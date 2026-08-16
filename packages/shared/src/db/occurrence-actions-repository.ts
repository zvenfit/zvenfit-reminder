import { randomUUID } from "node:crypto";
import type { ReminderOccurrence } from "../reminder-domain.js";
import {
  adjustForQuietHours,
  calculateFirstNotificationAt,
  calculateSnoozedNotificationAt,
  getNextScheduledDeadline,
} from "../reminder-scheduling.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { prepareOccurrenceMutation } from "./delivery-guard.js";
import {
  rowToOccurrence,
  rowToReminder,
  rowToRuntime,
} from "./occurrences-repository.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalTimestamp,
  parseYdbTimestamp,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

const UNDO_WINDOW_MILLISECONDS = 10 * 60 * 1_000;

export interface CompletionFinalizationCandidate {
  workspaceId: string;
  occurrenceId: string;
  undoUntil: Date;
}

export interface CompletionFinalization {
  workspaceId: string;
  occurrenceId: string;
  reminderId: string;
  archivedReminder: boolean;
  nextDueAt: Date | null;
  nextReminderStartAt: Date | null;
  occurrence: ReminderOccurrence;
}

export class OccurrenceNotActionableError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`Occurrence ${occurrenceId} is not actionable`);
    this.name = "OccurrenceNotActionableError";
  }
}

export class OccurrenceRuntimeMismatchError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`Occurrence ${occurrenceId} does not own its reminder runtime slot`);
    this.name = "OccurrenceRuntimeMismatchError";
  }
}

export class UndoWindowExpiredError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`Undo window has expired for occurrence ${occurrenceId}`);
    this.name = "UndoWindowExpiredError";
  }
}

function assertActorUserId(actorUserId: number): void {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new Error("Actor user ID must be a positive safe integer");
  }
}

function ownsRuntimeSlot(
  occurrence: ReminderOccurrence,
  runtime: ReturnType<typeof rowToRuntime>,
): boolean {
  return (
    runtime.state === "blocked" &&
    runtime.currentOccurrenceId === occurrence.occurrenceId &&
    runtime.reminderId === occurrence.reminderId
  );
}

export class OccurrenceActionsRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async snooze(
    workspaceId: string,
    occurrenceId: string,
    actorUserId: number,
    requestedAt: Date,
    now: Date = new Date(),
  ): Promise<ReminderOccurrence | null> {
    assertActorUserId(actorUserId);
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            SELECT occurrence.* FROM reminder_occurrences AS occurrence
            INNER JOIN reminders AS reminder
              ON reminder.workspace_id = occurrence.workspace_id
              AND reminder.reminder_id = occurrence.reminder_id
            INNER JOIN workspace_members AS actor
              ON actor.workspace_id = occurrence.workspace_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
              AND actor.user_id = $actor_user_id
              AND actor.status = 'active'
              AND reminder.status = 'active'
              AND (
                occurrence.responsible_user_id = $actor_user_id
                OR reminder.creator_user_id = $actor_user_id
                OR (
                  occurrence.visibility = 'group'
                  AND actor.role IN ('owner', 'organizer')
                )
              )
            LIMIT 1;

            SELECT quiet_hours_start, quiet_hours_end, status FROM workspaces
            WHERE workspace_id = $workspace_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const occurrenceRow = mapResultRows(resultSets[0])[0];
        const workspaceRow = mapResultRows(resultSets[1])[0];
        if (!occurrenceRow || !workspaceRow) {
          return null;
        }
        const occurrence = rowToOccurrence(occurrenceRow);
        await prepareOccurrenceMutation(
          transaction, workspaceId, occurrenceRow, occurrenceId, now,
        );
        if (
          getField(workspaceRow, "status") !== "active" ||
          occurrence.notificationState !== "waiting" ||
          (occurrence.status !== "pending" && occurrence.status !== "overdue")
        ) {
          throw new OccurrenceNotActionableError(occurrenceId);
        }
        const snoozeUntil = calculateSnoozedNotificationAt(
          requestedAt,
          now,
          occurrence.timezone,
          {
            startLocal: String(getField(workspaceRow, "quiet_hours_start")),
            endLocal: String(getField(workspaceRow, "quiet_hours_end")),
          },
          occurrence.ignoreQuietHours,
        );

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $now AS Timestamp;
            DECLARE $snooze_until AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $revision_increment AS Uint64;
            DECLARE $overdue_status AS Utf8;
            UPDATE reminder_occurrences SET
              state_revision = state_revision + $revision_increment,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              status = IF(due_at <= $now, $overdue_status, status),
              next_notification_at = $snooze_until,
              snoozed_by = $actor_user_id,
              snoozed_at = $now,
              snooze_until = $snooze_until,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND notification_state = 'waiting';

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $occurrence_id, $now, $event_id, 'occurrence',
              'occurrence.snoozed', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $now: timestampValue(now),
            $snooze_until: timestampValue(snoozeUntil),
            $revision_increment: TypedValues.uint64(1),
            $overdue_status: TypedValues.utf8("overdue"),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(
              JSON.stringify({ snoozeUntil: snoozeUntil.toISOString() }),
            ),
          },
        );

        return {
          ...occurrence,
          stateRevision: occurrence.stateRevision + 1,
          status: occurrence.dueAt <= now ? "overdue" : occurrence.status,
          nextNotificationAt: snoozeUntil,
          snoozedBy: actorUserId,
          snoozedAt: now,
          snoozeUntil,
          updatedAt: now,
        };
      }),
    );
  }

  async complete(
    workspaceId: string,
    occurrenceId: string,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderOccurrence | null> {
    assertActorUserId(actorUserId);
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            SELECT occurrence.*,
              COALESCE(actor.display_name_override, actor_user.display_name) AS actor_display_name
            FROM reminder_occurrences AS occurrence
            INNER JOIN reminders AS reminder
              ON reminder.workspace_id = occurrence.workspace_id
              AND reminder.reminder_id = occurrence.reminder_id
            INNER JOIN workspace_members AS actor
              ON actor.workspace_id = occurrence.workspace_id
            INNER JOIN users AS actor_user
              ON actor_user.user_id = actor.user_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
              AND actor.user_id = $actor_user_id
              AND actor.status = 'active'
              AND reminder.status = 'active'
              AND (
                occurrence.responsible_user_id = $actor_user_id
                OR reminder.creator_user_id = $actor_user_id
                OR (
                  occurrence.visibility = 'group'
                  AND (
                    actor.role IN ('owner', 'organizer')
                    OR occurrence.assignment_mode = 'anyone'
                  )
                )
              )
            LIMIT 1;

            SELECT runtime.* FROM reminder_runtime AS runtime
            INNER JOIN reminder_occurrences AS occurrence
              ON runtime.workspace_id = occurrence.workspace_id
              AND runtime.reminder_id = occurrence.reminder_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const occurrenceRow = mapResultRows(resultSets[0])[0];
        const runtimeRow = mapResultRows(resultSets[1])[0];
        if (!occurrenceRow || !runtimeRow) {
          return null;
        }
        const occurrence = rowToOccurrence(occurrenceRow);
        const actorDisplayName = String(getField(occurrenceRow, "actor_display_name"));
        await prepareOccurrenceMutation(
          transaction, workspaceId, occurrenceRow, occurrenceId, now,
        );
        if (occurrence.status === "completed") {
          throw new OccurrenceNotActionableError(occurrenceId);
        }
        if (
          occurrence.status !== "pending" &&
          occurrence.status !== "overdue"
        ) {
          throw new OccurrenceNotActionableError(occurrenceId);
        }
        const runtime = rowToRuntime(runtimeRow);
        if (!ownsRuntimeSlot(occurrence, runtime)) {
          throw new OccurrenceRuntimeMismatchError(occurrenceId);
        }
        const undoUntil = new Date(now.getTime() + UNDO_WINDOW_MILLISECONDS);

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $actor_display_name AS Utf8;
            DECLARE $now AS Timestamp;
            DECLARE $undo_until AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + 1,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              status = 'completed',
              notification_state = 'stopped',
              next_notification_at = NULL,
              snoozed_by = NULL,
              snoozed_at = NULL,
              snooze_until = NULL,
              completed_by = $actor_user_id,
              completed_by_display_name = $actor_display_name,
              completed_at = $now,
              undo_until = $undo_until,
              completion_finalized_at = NULL,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND status IN ('pending', 'overdue');

            UPDATE reminder_runtime SET updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id = $reminder_id
              AND state = 'blocked'
              AND current_occurrence_id = $occurrence_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $occurrence_id, $now, $event_id, 'occurrence',
              'occurrence.completed', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $reminder_id: TypedValues.utf8(occurrence.reminderId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $actor_display_name: TypedValues.utf8(actorDisplayName),
            $now: timestampValue(now),
            $undo_until: timestampValue(undoUntil),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(
              JSON.stringify({ undoUntil: undoUntil.toISOString() }),
            ),
          },
        );

        return {
          ...occurrence,
          stateRevision: occurrence.stateRevision + 1,
          status: "completed",
          notificationState: "stopped",
          nextNotificationAt: null,
          snoozedBy: null,
          snoozedAt: null,
          snoozeUntil: null,
          completedBy: actorUserId,
          completedByDisplayName: actorDisplayName,
          completedAt: now,
          undoUntil,
          updatedAt: now,
        };
      }),
    );
  }

  async undoCompletion(
    workspaceId: string,
    occurrenceId: string,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderOccurrence | null> {
    assertActorUserId(actorUserId);
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            SELECT occurrence.* FROM reminder_occurrences AS occurrence
            INNER JOIN reminders AS reminder
              ON reminder.workspace_id = occurrence.workspace_id
              AND reminder.reminder_id = occurrence.reminder_id
            INNER JOIN workspace_members AS actor
              ON actor.workspace_id = occurrence.workspace_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
              AND actor.user_id = $actor_user_id
              AND actor.status = 'active'
              AND reminder.status = 'active'
              AND (
                occurrence.responsible_user_id = $actor_user_id
                OR reminder.creator_user_id = $actor_user_id
                OR (
                  occurrence.visibility = 'group'
                  AND (
                    actor.role IN ('owner', 'organizer')
                    OR occurrence.assignment_mode = 'anyone'
                  )
                )
              )
            LIMIT 1;

            SELECT runtime.* FROM reminder_runtime AS runtime
            INNER JOIN reminder_occurrences AS occurrence
              ON runtime.workspace_id = occurrence.workspace_id
              AND runtime.reminder_id = occurrence.reminder_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
            LIMIT 1;

            SELECT quiet_hours_start, quiet_hours_end, status FROM workspaces
            WHERE workspace_id = $workspace_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const occurrenceRow = mapResultRows(resultSets[0])[0];
        const runtimeRow = mapResultRows(resultSets[1])[0];
        const workspaceRow = mapResultRows(resultSets[2])[0];
        if (!occurrenceRow || !runtimeRow || !workspaceRow) {
          return null;
        }
        const occurrence = rowToOccurrence(occurrenceRow);
        await prepareOccurrenceMutation(
          transaction, workspaceId, occurrenceRow, occurrenceId, now,
        );
        if (occurrence.status !== "completed") {
          throw new OccurrenceNotActionableError(occurrenceId);
        }
        if (!occurrence.undoUntil || now > occurrence.undoUntil) {
          throw new UndoWindowExpiredError(occurrenceId);
        }
        const runtime = rowToRuntime(runtimeRow);
        if (!ownsRuntimeSlot(occurrence, runtime)) {
          throw new OccurrenceRuntimeMismatchError(occurrenceId);
        }
        const nextNotificationAt = adjustForQuietHours(
          now,
          occurrence.timezone,
          {
            startLocal: String(getField(workspaceRow, "quiet_hours_start")),
            endLocal: String(getField(workspaceRow, "quiet_hours_end")),
          },
          occurrence.ignoreQuietHours,
        );
        const status = occurrence.dueAt <= now ? "overdue" : "pending";

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $next_notification_at AS Timestamp;
            DECLARE $now AS Timestamp;
            DECLARE $actor_user_id AS Int64;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            UPDATE reminder_occurrences SET
              state_revision = state_revision + 1,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              status = $status,
              notification_state = 'waiting',
              next_notification_at = $next_notification_at,
              completed_by = NULL,
              completed_by_display_name = NULL,
              completed_at = NULL,
              undo_until = NULL,
              completion_finalized_at = NULL,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND status = 'completed';

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $occurrence_id, $now, $event_id, 'occurrence',
              'occurrence.completion_undone', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $status: TypedValues.utf8(status),
            $next_notification_at: timestampValue(nextNotificationAt),
            $now: timestampValue(now),
            $actor_user_id: TypedValues.int64(actorUserId),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(
              JSON.stringify({ nextNotificationAt: nextNotificationAt.toISOString() }),
            ),
          },
        );

        return {
          ...occurrence,
          stateRevision: occurrence.stateRevision + 1,
          status,
          notificationState: "waiting",
          nextNotificationAt,
          completedBy: null,
          completedByDisplayName: null,
          completedAt: null,
          undoUntil: null,
          updatedAt: now,
        };
      }),
    );
  }

  async listCompletionFinalizationCandidates(
    workspaceId: string,
    now: Date,
    limit = 100,
  ): Promise<CompletionFinalizationCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Candidate limit must be an integer between 1 and 1000");
    }
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $now AS Timestamp;
          DECLARE $limit AS Uint64;
          DECLARE $workspace_id AS Utf8;
          SELECT workspace_id, occurrence_id, undo_until
          FROM reminder_occurrences VIEW idx_occurrences_completion_finalize
          WHERE status = 'completed'
            AND undo_until <= $now
            AND workspace_id = $workspace_id
          ORDER BY status, undo_until, workspace_id
          LIMIT $limit;
        `,
        {
          $now: timestampValue(now),
          $limit: TypedValues.uint64(limit),
          $workspace_id: TypedValues.utf8(workspaceId),
        },
      );
      return mapResultRows(resultSets[0]).map((row) => ({
        workspaceId: String(getField(row, "workspace_id")),
        occurrenceId: String(getField(row, "occurrence_id")),
        undoUntil: parseYdbTimestampRequired(getField(row, "undo_until"), "undo_until"),
      }));
    });
  }

  async finalizeCompletion(
    workspaceId: string,
    occurrenceId: string,
    now: Date = new Date(),
  ): Promise<CompletionFinalization | null> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            SELECT * FROM reminder_occurrences
            WHERE workspace_id = $workspace_id AND occurrence_id = $occurrence_id
            LIMIT 1;

            SELECT runtime.* FROM reminder_runtime AS runtime
            INNER JOIN reminder_occurrences AS occurrence
              ON runtime.workspace_id = occurrence.workspace_id
              AND runtime.reminder_id = occurrence.reminder_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
            LIMIT 1;

            SELECT reminder.* FROM reminders AS reminder
            INNER JOIN reminder_occurrences AS occurrence
              ON reminder.workspace_id = occurrence.workspace_id
              AND reminder.reminder_id = occurrence.reminder_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
            LIMIT 1;

            SELECT quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time
            FROM workspaces WHERE workspace_id = $workspace_id LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
          },
        );
        const occurrenceRow = mapResultRows(resultSets[0])[0];
        const runtimeRow = mapResultRows(resultSets[1])[0];
        const reminderRow = mapResultRows(resultSets[2])[0];
        const workspaceRow = mapResultRows(resultSets[3])[0];
        if (!occurrenceRow || !runtimeRow || !reminderRow || !workspaceRow) {
          return null;
        }
        const occurrence = rowToOccurrence(occurrenceRow);
        await prepareOccurrenceMutation(
          transaction, workspaceId, occurrenceRow, occurrenceId, now,
        );
        if (
          occurrence.status !== "completed" ||
          !occurrence.undoUntil ||
          occurrence.undoUntil > now
        ) {
          return null;
        }
        const runtime = rowToRuntime(runtimeRow);
        const completionFinalizedAt = parseYdbTimestamp(
          getField(occurrenceRow, "completion_finalized_at"),
        );
        const ownsPausedFinalizationSlot =
          runtime.state === "paused" &&
          runtime.currentOccurrenceId === occurrence.occurrenceId &&
          runtime.reminderId === occurrence.reminderId;
        if (
          !completionFinalizedAt &&
          !ownsRuntimeSlot(occurrence, runtime) &&
          !ownsPausedFinalizationSlot
        ) {
          throw new OccurrenceRuntimeMismatchError(occurrenceId);
        }
        const reminder = rowToReminder(reminderRow);
        const completingCurrentDefinition = occurrence.reminderVersion === reminder.version;
        const oneOff = completionFinalizedAt
          ? reminder.schedule.frequency === "once" && reminder.status === "archived"
          : reminder.schedule.frequency === "once" && completingCurrentDefinition;
        let nextDueAt: Date | null = completionFinalizedAt ? runtime.nextDueAt : null;
        let nextReminderStartAt: Date | null = completionFinalizedAt
          ? runtime.nextReminderStartAt
          : null;
        let nextRuntimeState: "ready" | "paused" = "paused";

        if (!completionFinalizedAt && !oneOff && reminder.status === "active") {
          // Completing during the lead-time window must advance past the slot
          // being completed, not materialize that same due date again.
          const nextScheduleReference = new Date(
            Math.max(now.getTime(), occurrence.dueAt.getTime()),
          );
          const nextDeadline = getNextScheduledDeadline(
            reminder.schedule,
            reminder.timezone,
            nextScheduleReference,
            {
              defaultAllDayReminderTime: String(
                getField(workspaceRow, "default_all_day_reminder_time"),
              ),
            },
          );
          if (!nextDeadline) {
            throw new Error("Recurring reminder has no next deadline");
          }
          nextDueAt = nextDeadline.dueAt;
          nextReminderStartAt = calculateFirstNotificationAt(
            nextDeadline,
            reminder.notificationPolicy.leadMinutes,
            reminder.timezone,
            {
              startLocal: String(getField(workspaceRow, "quiet_hours_start")),
              endLocal: String(getField(workspaceRow, "quiet_hours_end")),
            },
            {
              ignoreQuietHours: reminder.notificationPolicy.ignoreQuietHours,
              notBefore: now,
            },
          );
          nextRuntimeState = "ready";
        }

        if (!completionFinalizedAt) await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $runtime_state AS Utf8;
            DECLARE $next_due_at AS Timestamp?;
            DECLARE $next_reminder_start_at AS Timestamp?;
            DECLARE $schedule_version AS Uint64;
            DECLARE $now AS Timestamp;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + 1,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              completion_finalized_at = $now,
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND status = 'completed';

            UPDATE reminder_runtime SET
              state = $runtime_state,
              next_due_at = $next_due_at,
              next_reminder_start_at = $next_reminder_start_at,
              current_occurrence_id = NULL,
              schedule_version = $schedule_version,
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id = $reminder_id
              AND state IN ('blocked', 'paused')
              AND current_occurrence_id = $occurrence_id;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $reminder_id: TypedValues.utf8(occurrence.reminderId),
            $runtime_state: TypedValues.utf8(nextRuntimeState),
            $next_due_at: optionalTimestamp(nextDueAt),
            $next_reminder_start_at: optionalTimestamp(nextReminderStartAt),
            $schedule_version: TypedValues.uint64(reminder.version),
            $now: timestampValue(now),
          },
        );

        if (!completionFinalizedAt && oneOff && reminder.status !== "archived") {
          await transaction.executeQuery(
            `
              DECLARE $workspace_id AS Utf8;
              DECLARE $reminder_id AS Utf8;
              DECLARE $version AS Uint64;
              DECLARE $now AS Timestamp;
              UPDATE reminders SET
                status = 'archived',
                version = version + 1,
                updated_at = $now
              WHERE workspace_id = $workspace_id
                AND reminder_id = $reminder_id
                AND version = $version;
            `,
            {
              $workspace_id: TypedValues.utf8(workspaceId),
              $reminder_id: TypedValues.utf8(reminder.reminderId),
              $version: TypedValues.uint64(reminder.version),
              $now: timestampValue(now),
            },
          );
        }

        return {
          workspaceId,
          occurrenceId,
          reminderId: occurrence.reminderId,
          archivedReminder: oneOff,
          nextDueAt,
          nextReminderStartAt,
          occurrence: {
            ...occurrence,
            stateRevision: completionFinalizedAt
              ? occurrence.stateRevision
              : occurrence.stateRevision + 1,
            undoUntil: null,
            updatedAt: now,
          },
        };
      }),
    );
  }

  async markCompletionMessageFinalized(
    workspaceId: string,
    occurrenceId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.runSession(async (session) => {
      await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $occurrence_id AS Utf8;
          DECLARE $now AS Timestamp;
          UPDATE reminder_occurrences SET
            undo_until = NULL,
            message_sync_required = false,
            message_sync_retire_only = false,
            updated_at = $now
          WHERE workspace_id = $workspace_id
            AND occurrence_id = $occurrence_id
            AND status = 'completed'
            AND completion_finalized_at IS NOT NULL
            AND undo_until <= $now;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $occurrence_id: TypedValues.utf8(occurrenceId),
          $now: timestampValue(now),
        },
      );
    });
  }
}
