import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  escalationPolicySchema,
  occurrenceNotificationStateSchema,
  occurrenceStatusSchema,
  reminderDraftSchema,
  reminderDraftUpdateSchema,
  reminderKindSchema,
  reminderRuntimeStateSchema,
  reminderStatusSchema,
  reminderVisibilitySchema,
  type ReminderDefinition,
  type ReminderDraftUpdate,
  type ReminderOccurrence,
  type ReminderRuntime,
} from "../reminder-domain.js";
import {
  calculateFirstNotificationAt,
  getNextScheduledDeadline,
} from "../reminder-scheduling.js";
import { createSessionRunner, TypedValues, Types, type SessionRunner } from "./client.js";
import {
  DELIVERY_LOCK_TTL_MILLISECONDS,
  hasActiveDeliveryLock,
  prepareOccurrenceMutation,
} from "./delivery-guard.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  InactiveWorkspaceMemberError,
  PrivateChatUnavailableError,
} from "./reminders-repository.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalUint32,
  optionalUtf8,
  parseJsonDocument,
  parseYdbTimestamp,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

export interface RuntimeCandidate {
  workspaceId: string;
  reminderId: string;
  reminderStartAt: Date;
}

export interface OccurrenceMessageSyncCandidate {
  occurrence: ReminderOccurrence;
  stateRevision: number;
  retireOnly: boolean;
}

export interface OccurrenceMessageSyncClaim extends OccurrenceMessageSyncCandidate {
  syncKey: string;
}

export class OccurrenceUpdateForbiddenError extends Error {
  constructor() {
    super("Cannot update this occurrence");
    this.name = "OccurrenceUpdateForbiddenError";
  }
}

export class OccurrenceUpdateConflictError extends Error {
  constructor(readonly reason: "not_actionable" | "not_current") {
    super(`Cannot update occurrence: ${reason}`);
    this.name = "OccurrenceUpdateConflictError";
  }
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function rowToRuntime(data: Record<string, unknown>): ReminderRuntime {
  return {
    workspaceId: String(getField(data, "workspace_id")),
    reminderId: String(getField(data, "reminder_id")),
    state: reminderRuntimeStateSchema.parse(getField(data, "state")),
    nextDueAt: parseYdbTimestamp(getField(data, "next_due_at")),
    nextReminderStartAt: parseYdbTimestamp(getField(data, "next_reminder_start_at")),
    currentOccurrenceId: nullableString(getField(data, "current_occurrence_id")),
    scheduleVersion: Number(getField(data, "schedule_version")),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
  };
}

export function rowToReminder(
  data: Record<string, unknown>,
  watcherUserIds: number[] = [],
): ReminderDefinition {
  const escalationEnabled = Boolean(getField(data, "escalation_enabled"));
  const storedAmount = getField(data, "amount_minor");
  const draft = reminderDraftSchema.parse({
    kind: getField(data, "kind") ?? (storedAmount == null ? "task" : "payment"),
    title: getField(data, "title"),
    description: nullableString(getField(data, "description")),
    actionUrl: nullableString(getField(data, "action_url")),
    amountMinor: nullableNumber(storedAmount),
    currency: nullableString(getField(data, "currency")),
    visibility: getField(data, "visibility"),
    assignment:
      getField(data, "assignment_mode") === "person"
        ? {
            mode: "person",
            responsibleUserId: Number(getField(data, "responsible_user_id")),
          }
        : { mode: "anyone" },
    watcherUserIds,
    schedule: parseJsonDocument(getField(data, "schedule_spec"), null),
    timezone: getField(data, "timezone"),
    notificationPolicy: {
      leadMinutes: Number(getField(data, "lead_minutes")),
      repeatIntervalMinutes: Number(getField(data, "repeat_interval_minutes")),
      ignoreQuietHours: Boolean(getField(data, "ignore_quiet_hours")),
      escalation: escalationEnabled
        ? {
            enabled: true,
            delayMinutes: Number(getField(data, "escalation_delay_minutes")),
            repeatMinutes: Number(getField(data, "escalation_repeat_minutes")),
          }
        : { enabled: false },
    },
  });

  return {
    ...draft,
    workspaceId: String(getField(data, "workspace_id")),
    reminderId: String(getField(data, "reminder_id")),
    creatorUserId: Number(getField(data, "creator_user_id")),
    status: reminderStatusSchema.parse(getField(data, "status")),
    version: Number(getField(data, "version")),
    createdAt: parseYdbTimestampRequired(getField(data, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
  };
}

export function rowToOccurrence(data: Record<string, unknown>): ReminderOccurrence {
  const escalationEnabled = Boolean(getField(data, "escalation_enabled"));
  return {
    workspaceId: String(getField(data, "workspace_id")),
    occurrenceId: String(getField(data, "occurrence_id")),
    reminderId: String(getField(data, "reminder_id")),
    reminderVersion: Number(getField(data, "reminder_version")),
    stateRevision: Number(getField(data, "state_revision")),
    dueAt: parseYdbTimestampRequired(getField(data, "due_at"), "due_at"),
    dueLocalDate: String(getField(data, "due_local_date")),
    allDay: Boolean(getField(data, "all_day")),
    reminderStartAt: parseYdbTimestampRequired(
      getField(data, "reminder_start_at"),
      "reminder_start_at",
    ),
    status: occurrenceStatusSchema.parse(getField(data, "status")),
    notificationState: occurrenceNotificationStateSchema.parse(
      getField(data, "notification_state"),
    ),
    assignment:
      getField(data, "assignment_mode") === "person"
        ? {
            mode: "person",
            responsibleUserId: Number(getField(data, "responsible_user_id")),
          }
        : { mode: "anyone" },
    kind: reminderKindSchema.parse(
      getField(data, "kind") ?? (getField(data, "amount_minor") == null ? "task" : "payment"),
    ),
    title: String(getField(data, "title")),
    description: nullableString(getField(data, "description")),
    actionUrl: nullableString(getField(data, "action_url")),
    amountMinor: nullableNumber(getField(data, "amount_minor")),
    currency: nullableString(getField(data, "currency")),
    visibility: reminderVisibilitySchema.parse(getField(data, "visibility")),
    timezone: String(getField(data, "timezone")),
    repeatIntervalMinutes: Number(getField(data, "repeat_interval_minutes")),
    ignoreQuietHours: Boolean(getField(data, "ignore_quiet_hours")),
    escalation: escalationPolicySchema.parse(
      escalationEnabled
        ? {
            enabled: true,
            delayMinutes: Number(getField(data, "escalation_delay_minutes")),
            repeatMinutes: Number(getField(data, "escalation_repeat_minutes")),
          }
        : { enabled: false },
    ),
    nextNotificationAt: parseYdbTimestamp(getField(data, "next_notification_at")),
    notificationSequence: Number(getField(data, "notification_sequence")),
    snoozedBy: nullableNumber(getField(data, "snoozed_by")),
    snoozedAt: parseYdbTimestamp(getField(data, "snoozed_at")),
    snoozeUntil: parseYdbTimestamp(getField(data, "snooze_until")),
    latestMessageChatId: nullableNumber(getField(data, "latest_message_chat_id")),
    latestMessageId: nullableNumber(getField(data, "latest_message_id")),
    completedBy: nullableNumber(getField(data, "completed_by")),
    completedByDisplayName: nullableString(getField(data, "completed_by_display_name")),
    completedAt: parseYdbTimestamp(getField(data, "completed_at")),
    undoUntil: parseYdbTimestamp(getField(data, "undo_until")),
    cancelledBy: nullableNumber(getField(data, "cancelled_by")),
    cancellationReason: nullableString(getField(data, "cancellation_reason")),
    cancelledAt: parseYdbTimestamp(getField(data, "cancelled_at")),
    createdAt: parseYdbTimestampRequired(getField(data, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
  };
}

export class OccurrencesRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async listRuntimeCandidates(
    workspaceId: string,
    now: Date,
    limit = 100,
  ): Promise<RuntimeCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Candidate limit must be an integer between 1 and 1000");
    }
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $now AS Timestamp;
          DECLARE $limit AS Uint64;
          DECLARE $workspace_id AS Utf8;
          SELECT workspace_id, reminder_id, next_reminder_start_at
          FROM reminder_runtime VIEW idx_reminder_runtime_start
          WHERE state = 'ready'
            AND next_reminder_start_at <= $now
            AND workspace_id = $workspace_id
          ORDER BY state, next_reminder_start_at, workspace_id
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
        reminderId: String(getField(row, "reminder_id")),
        reminderStartAt: parseYdbTimestampRequired(
          getField(row, "next_reminder_start_at"),
          "next_reminder_start_at",
        ),
      }));
    });
  }

  async getById(workspaceId: string, occurrenceId: string): Promise<ReminderOccurrence | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $occurrence_id AS Utf8;
          SELECT * FROM reminder_occurrences
          WHERE workspace_id = $workspace_id AND occurrence_id = $occurrence_id
          LIMIT 1;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $occurrence_id: TypedValues.utf8(occurrenceId),
        },
      );
      const row = mapResultRows(resultSets[0])[0];
      return row ? rowToOccurrence(row) : null;
    });
  }

  async findByIdForActor(
    occurrenceId: string,
    actorUserId: number,
  ): Promise<ReminderOccurrence | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $occurrence_id AS Utf8;
          DECLARE $actor_user_id AS Int64;
          SELECT occurrence.* FROM reminder_occurrences VIEW idx_occurrences_id AS occurrence
          INNER JOIN workspace_members AS member
            ON member.workspace_id = occurrence.workspace_id
          WHERE occurrence.occurrence_id = $occurrence_id
            AND member.user_id = $actor_user_id
            AND member.status = 'active'
          LIMIT 1;
        `,
        {
          $occurrence_id: TypedValues.utf8(occurrenceId),
          $actor_user_id: TypedValues.int64(actorUserId),
        },
      );
      const row = mapResultRows(resultSets[0])[0];
      return row ? rowToOccurrence(row) : null;
    });
  }

  async listActionableForActor(
    workspaceId: string,
    actorUserId: number,
  ): Promise<ReminderOccurrence[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $actor_user_id AS Int64;
          SELECT occurrence.* FROM reminder_occurrences AS occurrence
          INNER JOIN reminders AS reminder
            ON occurrence.workspace_id = reminder.workspace_id
            AND occurrence.reminder_id = reminder.reminder_id
          WHERE occurrence.workspace_id = $workspace_id
            AND occurrence.status IN ('scheduled', 'pending', 'overdue')
            AND reminder.status = 'active'
            AND (
              occurrence.visibility = 'group'
              OR reminder.creator_user_id = $actor_user_id
              OR occurrence.responsible_user_id = $actor_user_id
            )
          ORDER BY due_at, occurrence_id;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $actor_user_id: TypedValues.int64(actorUserId),
        },
      );
      return mapResultRows(resultSets[0]).map(rowToOccurrence);
    });
  }

  async listHistoryForActor(
    workspaceId: string,
    actorUserId: number,
    limit = 100,
  ): Promise<ReminderOccurrence[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("History limit must be an integer between 1 and 500");
    }
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $actor_user_id AS Int64;
          DECLARE $limit AS Uint64;
          SELECT occurrence.* FROM reminder_occurrences AS occurrence
          INNER JOIN reminders AS reminder
            ON occurrence.workspace_id = reminder.workspace_id
            AND occurrence.reminder_id = reminder.reminder_id
          WHERE occurrence.workspace_id = $workspace_id
            AND occurrence.status IN ('completed', 'cancelled')
            AND (
              occurrence.visibility = 'group'
              OR reminder.creator_user_id = $actor_user_id
              OR occurrence.responsible_user_id = $actor_user_id
            )
          ORDER BY occurrence.workspace_id, occurrence.due_at DESC, occurrence.occurrence_id DESC
          LIMIT $limit;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $actor_user_id: TypedValues.int64(actorUserId),
          $limit: TypedValues.uint64(limit),
        },
      );
      return mapResultRows(resultSets[0]).map(rowToOccurrence);
    });
  }

  async updateCurrentForActor(
    workspaceId: string,
    occurrenceId: string,
    input: ReminderDraftUpdate,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderOccurrence | null> {
    const parsedInput = reminderDraftUpdateSchema.parse(input);
    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;

            SELECT status, quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time
            FROM workspaces WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT role, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT occurrence.*,
              reminder.creator_user_id AS creator_user_id,
              reminder.status AS reminder_status
            FROM reminder_occurrences AS occurrence
            INNER JOIN reminders AS reminder
              ON reminder.workspace_id = occurrence.workspace_id
              AND reminder.reminder_id = occurrence.reminder_id
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.occurrence_id = $occurrence_id
            LIMIT 1;

            SELECT current_occurrence_id FROM reminder_runtime
            WHERE workspace_id = $workspace_id
              AND current_occurrence_id = $occurrence_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        const actorRow = mapResultRows(resultSets[1])[0];
        const occurrenceRow = mapResultRows(resultSets[2])[0];
        const runtimeRow = mapResultRows(resultSets[3])[0];
        if (!occurrenceRow) return;

        const occurrence = rowToOccurrence(occurrenceRow);
        const parsed = reminderDraftSchema.parse({
          ...parsedInput,
          kind: parsedInput.kind ?? occurrence.kind,
        });
        const actorIsManager = Boolean(
          actorRow &&
          getField(actorRow, "status") === "active" &&
          ["owner", "organizer"].includes(String(getField(actorRow, "role"))),
        );
        const canEdit = Boolean(
          workspaceRow &&
          getField(workspaceRow, "status") === "active" &&
          actorRow &&
          getField(actorRow, "status") === "active" &&
          getField(occurrenceRow, "reminder_status") === "active" &&
          (occurrence.visibility === "group"
            ? actorIsManager
            : actorUserId === Number(getField(occurrenceRow, "creator_user_id")) ||
              (occurrence.assignment.mode === "person" &&
                occurrence.assignment.responsibleUserId === actorUserId)) &&
          (parsed.visibility !== "group" || actorIsManager),
        );
        if (!canEdit) throw new OccurrenceUpdateForbiddenError();
        if (!runtimeRow) throw new OccurrenceUpdateConflictError("not_current");
        if (occurrence.status !== "pending" && occurrence.status !== "overdue") {
          throw new OccurrenceUpdateConflictError("not_actionable");
        }
        await prepareOccurrenceMutation(
          transaction,
          workspaceId,
          occurrenceRow,
          occurrenceId,
          now,
        );

        const requiredParticipantIds = new Set<number>(parsed.watcherUserIds);
        if (parsed.assignment.mode === "person") {
          requiredParticipantIds.add(parsed.assignment.responsibleUserId);
        }
        const participantIds = [...requiredParticipantIds].sort((left, right) => left - right);
        const { resultSets: participantResultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $participant_ids AS List<Int64>;
            SELECT user_id, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id IN $participant_ids;

            SELECT user_id, private_chat_available FROM users
            WHERE user_id IN $participant_ids;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $participant_ids: TypedValues.list(Types.INT64, participantIds),
          },
        );
        const activeUserIds = new Set(
          mapResultRows(participantResultSets[0])
            .filter((row) => getField(row, "status") === "active")
            .map((row) => Number(getField(row, "user_id"))),
        );
        const inactiveUserIds = participantIds.filter((userId) => !activeUserIds.has(userId));
        if (inactiveUserIds.length > 0) {
          throw new InactiveWorkspaceMemberError(workspaceId, inactiveUserIds);
        }
        if (parsed.visibility === "private" && parsed.assignment.mode === "person") {
          const responsibleUserId = parsed.assignment.responsibleUserId;
          const responsibleUser = mapResultRows(participantResultSets[1]).find(
            (row) => Number(getField(row, "user_id")) === responsibleUserId,
          );
          if (!responsibleUser || !Boolean(getField(responsibleUser, "private_chat_available"))) {
            throw new PrivateChatUnavailableError(responsibleUserId);
          }
        }

        const deadlineReference = DateTime.fromISO(
          parsed.schedule.frequency === "once" ? parsed.schedule.date : occurrence.dueLocalDate,
          { zone: parsed.timezone },
        ).startOf("day").minus({ millisecond: 1 }).toJSDate();
        const deadline = getNextScheduledDeadline(
          parsed.schedule,
          parsed.timezone,
          deadlineReference,
          { defaultAllDayReminderTime: String(getField(workspaceRow, "default_all_day_reminder_time")) },
        );
        if (!deadline) throw new OccurrenceUpdateConflictError("not_actionable");
        const reminderStartAt = calculateFirstNotificationAt(
          deadline,
          parsed.notificationPolicy.leadMinutes,
          parsed.timezone,
          {
            startLocal: String(getField(workspaceRow, "quiet_hours_start")),
            endLocal: String(getField(workspaceRow, "quiet_hours_end")),
          },
          { ignoreQuietHours: parsed.notificationPolicy.ignoreQuietHours, notBefore: now },
        );
        const escalation = parsed.notificationPolicy.escalation;

        if (deadline.dueAt.getTime() !== occurrence.dueAt.getTime()) {
          await transaction.executeQuery(
            `
              DECLARE $workspace_id AS Utf8;
              DECLARE $reminder_id AS Utf8;
              DECLARE $occurrence_id AS Utf8;
              DECLARE $old_due_at AS Timestamp;
              DECLARE $new_due_at AS Timestamp;
              DECLARE $now AS Timestamp;
              DELETE FROM reminder_occurrence_slots
              WHERE workspace_id = $workspace_id
                AND reminder_id = $reminder_id
                AND due_at = $old_due_at
                AND occurrence_id = $occurrence_id;
              INSERT INTO reminder_occurrence_slots (
                workspace_id, reminder_id, due_at, occurrence_id, created_at
              ) VALUES ($workspace_id, $reminder_id, $new_due_at, $occurrence_id, $now);
            `,
            {
              $workspace_id: TypedValues.utf8(workspaceId),
              $reminder_id: TypedValues.utf8(occurrence.reminderId),
              $occurrence_id: TypedValues.utf8(occurrenceId),
              $old_due_at: timestampValue(occurrence.dueAt),
              $new_due_at: timestampValue(deadline.dueAt),
              $now: timestampValue(now),
            },
          );
        }

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $kind AS Utf8;
            DECLARE $title AS Utf8;
            DECLARE $description AS Utf8?;
            DECLARE $action_url AS Utf8?;
            DECLARE $amount_minor AS Int64?;
            DECLARE $currency AS Utf8?;
            DECLARE $visibility AS Utf8;
            DECLARE $assignment_mode AS Utf8;
            DECLARE $responsible_user_id AS Int64?;
            DECLARE $due_at AS Timestamp;
            DECLARE $due_local_date AS Utf8;
            DECLARE $all_day AS Bool;
            DECLARE $reminder_start_at AS Timestamp;
            DECLARE $status AS Utf8;
            DECLARE $timezone AS Utf8;
            DECLARE $repeat_interval_minutes AS Uint32;
            DECLARE $ignore_quiet_hours AS Bool;
            DECLARE $escalation_enabled AS Bool;
            DECLARE $escalation_delay_minutes AS Uint32?;
            DECLARE $escalation_repeat_minutes AS Uint32?;
            DECLARE $watcher_user_ids AS JsonDocument;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $revision_increment AS Uint64;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + $revision_increment,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              kind = $kind,
              title = $title,
              description = $description,
              action_url = $action_url,
              amount_minor = $amount_minor,
              currency = $currency,
              visibility = $visibility,
              assignment_mode = $assignment_mode,
              responsible_user_id = $responsible_user_id,
              due_at = $due_at,
              due_local_date = $due_local_date,
              all_day = $all_day,
              reminder_start_at = $reminder_start_at,
              status = $status,
              timezone = $timezone,
              repeat_interval_minutes = $repeat_interval_minutes,
              ignore_quiet_hours = $ignore_quiet_hours,
              escalation_enabled = $escalation_enabled,
              escalation_delay_minutes = $escalation_delay_minutes,
              escalation_repeat_minutes = $escalation_repeat_minutes,
              watcher_user_ids = $watcher_user_ids,
              next_notification_at = $reminder_start_at,
              notification_sequence = 0,
              snoozed_by = NULL,
              snoozed_at = NULL,
              snooze_until = NULL,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND status IN ('pending', 'overdue');

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $occurrence_id, $now, $event_id, 'occurrence',
              'occurrence.updated', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $kind: TypedValues.utf8(parsed.kind),
            $title: TypedValues.utf8(parsed.title),
            $description: optionalUtf8(parsed.description),
            $action_url: optionalUtf8(parsed.actionUrl),
            $amount_minor: optionalInt64(parsed.amountMinor),
            $currency: optionalUtf8(parsed.currency),
            $visibility: TypedValues.utf8(parsed.visibility),
            $assignment_mode: TypedValues.utf8(parsed.assignment.mode),
            $responsible_user_id: optionalInt64(
              parsed.assignment.mode === "person" ? parsed.assignment.responsibleUserId : null,
            ),
            $due_at: timestampValue(deadline.dueAt),
            $due_local_date: TypedValues.utf8(deadline.dueLocalDate),
            $all_day: TypedValues.bool(deadline.allDay),
            $reminder_start_at: timestampValue(reminderStartAt),
            $status: TypedValues.utf8(deadline.dueAt <= now ? "overdue" : "pending"),
            $timezone: TypedValues.utf8(parsed.timezone),
            $repeat_interval_minutes: TypedValues.uint32(parsed.notificationPolicy.repeatIntervalMinutes),
            $ignore_quiet_hours: TypedValues.bool(parsed.notificationPolicy.ignoreQuietHours),
            $escalation_enabled: TypedValues.bool(escalation.enabled),
            $escalation_delay_minutes: optionalUint32(escalation.enabled ? escalation.delayMinutes : null),
            $escalation_repeat_minutes: optionalUint32(escalation.enabled ? escalation.repeatMinutes : null),
            $watcher_user_ids: TypedValues.jsonDocument(JSON.stringify(parsed.watcherUserIds)),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $revision_increment: TypedValues.uint64(1),
            $payload: TypedValues.jsonDocument(JSON.stringify({
              scope: "occurrence",
              previousDueAt: occurrence.dueAt.toISOString(),
              dueAt: deadline.dueAt.toISOString(),
            })),
          },
        );
      }),
    );
    return this.getById(workspaceId, occurrenceId);
  }

  async listMessageSyncCandidates(
    workspaceId: string,
    limit = 100,
  ): Promise<OccurrenceMessageSyncCandidate[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $limit AS Uint64;
          SELECT * FROM reminder_occurrences
          WHERE workspace_id = $workspace_id
            AND message_sync_required = true
          ORDER BY updated_at, occurrence_id
          LIMIT $limit;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $limit: TypedValues.uint64(limit),
        },
      );
      return mapResultRows(resultSets[0]).map((row) => ({
        occurrence: rowToOccurrence(row),
        stateRevision: Number(getField(row, "state_revision")),
        retireOnly: Boolean(getField(row, "message_sync_retire_only")),
      }));
    });
  }

  async beginMessageSync(
    workspaceId: string,
    occurrenceId: string,
    stateRevision: number,
    now: Date = new Date(),
  ): Promise<OccurrenceMessageSyncClaim | null> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            SELECT * FROM reminder_occurrences
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
          },
        );
        const row = mapResultRows(resultSets[0])[0];
        const currentStateRevision = Number(getField(row ?? {}, "state_revision"));
        if (
          !row ||
          !Boolean(getField(row, "message_sync_required")) ||
          currentStateRevision !== stateRevision ||
          hasActiveDeliveryLock(row, now)
        ) {
          return null;
        }
        await prepareOccurrenceMutation(transaction, workspaceId, row, occurrenceId, now);
        const syncKey = `message-sync:${occurrenceId}:${currentStateRevision}:${randomUUID()}`;
        const expiredBefore = new Date(now.getTime() - DELIVERY_LOCK_TTL_MILLISECONDS);
        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $state_revision AS Uint64;
            DECLARE $sync_key AS Utf8;
            DECLARE $now AS Timestamp;
            DECLARE $expired_before AS Timestamp;
            UPDATE reminder_occurrences SET
              delivery_lock_key = $sync_key,
              delivery_locked_at = $now
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND state_revision = $state_revision
              AND message_sync_required = true
              AND (
                delivery_lock_key IS NULL OR delivery_locked_at <= $expired_before
              );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $state_revision: TypedValues.uint64(currentStateRevision),
            $sync_key: TypedValues.utf8(syncKey),
            $now: timestampValue(now),
            $expired_before: timestampValue(expiredBefore),
          },
        );
        return {
          occurrence: rowToOccurrence(row),
          stateRevision: currentStateRevision,
          retireOnly: Boolean(getField(row, "message_sync_retire_only")),
          syncKey,
        };
      }),
    );
  }

  async finishMessageSync(
    workspaceId: string,
    occurrenceId: string,
    stateRevision: number,
    syncKey: string,
    succeeded: boolean,
  ): Promise<void> {
    await this.runSession(async (session) => {
      await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $occurrence_id AS Utf8;
          DECLARE $state_revision AS Uint64;
          DECLARE $sync_key AS Utf8;
          DECLARE $succeeded AS Bool;
          UPDATE reminder_occurrences SET
            delivery_lock_key = NULL,
            delivery_locked_at = NULL,
            message_sync_required = IF($succeeded, false, message_sync_required),
            message_sync_retire_only = IF($succeeded, false, message_sync_retire_only)
          WHERE workspace_id = $workspace_id
            AND occurrence_id = $occurrence_id
            AND state_revision = $state_revision
            AND delivery_lock_key = $sync_key;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $occurrence_id: TypedValues.utf8(occurrenceId),
          $state_revision: TypedValues.uint64(stateRevision),
          $sync_key: TypedValues.utf8(syncKey),
          $succeeded: TypedValues.bool(succeeded),
        },
      );
    });
  }

  async materialize(
    workspaceId: string,
    reminderId: string,
    options: { occurrenceId?: string; now?: Date } = {},
  ): Promise<ReminderOccurrence | null> {
    const now = options.now ?? new Date();
    const occurrenceId = options.occurrenceId ?? randomUUID();

    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;

            SELECT * FROM reminder_runtime
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
            LIMIT 1;

            SELECT * FROM reminders
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
            LIMIT 1;

            SELECT user_id FROM reminder_watchers
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
            ORDER BY user_id;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
          },
        );

        const runtimeRow = mapResultRows(resultSets[0])[0];
        const reminderRow = mapResultRows(resultSets[1])[0];
        if (!runtimeRow || !reminderRow) {
          return null;
        }
        const runtime = rowToRuntime(runtimeRow);
        const reminder = rowToReminder(
          reminderRow,
          mapResultRows(resultSets[2]).map((row) => Number(getField(row, "user_id"))),
        );
        if (
          runtime.state !== "ready" ||
          reminder.status !== "active" ||
          runtime.scheduleVersion !== reminder.version ||
          !runtime.nextDueAt ||
          !runtime.nextReminderStartAt ||
          runtime.nextReminderStartAt > now
        ) {
          return null;
        }

        const occurrence: ReminderOccurrence = {
          workspaceId,
          occurrenceId,
          reminderId,
          reminderVersion: reminder.version,
          stateRevision: 1,
          dueAt: runtime.nextDueAt,
          dueLocalDate:
            DateTime.fromJSDate(runtime.nextDueAt, { zone: reminder.timezone }).toISODate() ?? "",
          allDay: reminder.schedule.timing.kind === "allDay",
          reminderStartAt: runtime.nextReminderStartAt,
          status: runtime.nextDueAt <= now ? "overdue" : "pending",
          notificationState: "waiting",
          assignment: reminder.assignment,
          kind: reminder.kind,
          title: reminder.title,
          description: reminder.description,
          actionUrl: reminder.actionUrl,
          amountMinor: reminder.amountMinor,
          currency: reminder.currency,
          visibility: reminder.visibility,
          timezone: reminder.timezone,
          repeatIntervalMinutes: reminder.notificationPolicy.repeatIntervalMinutes,
          ignoreQuietHours: reminder.notificationPolicy.ignoreQuietHours,
          escalation: reminder.notificationPolicy.escalation,
          nextNotificationAt: runtime.nextReminderStartAt,
          notificationSequence: 0,
          snoozedBy: null,
          snoozedAt: null,
          snoozeUntil: null,
          latestMessageChatId: null,
          latestMessageId: null,
          completedBy: null,
          completedByDisplayName: null,
          completedAt: null,
          undoUntil: null,
          cancelledBy: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        if (!occurrence.dueLocalDate) {
          throw new Error("Could not derive occurrence local due date");
        }

        const escalation = occurrence.escalation;
        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $reminder_version AS Uint64;
            DECLARE $due_at AS Timestamp;
            DECLARE $due_local_date AS Utf8;
            DECLARE $all_day AS Bool;
            DECLARE $reminder_start_at AS Timestamp;
            DECLARE $status AS Utf8;
            DECLARE $notification_state AS Utf8;
            DECLARE $assignment_mode AS Utf8;
            DECLARE $responsible_user_id AS Int64?;
            DECLARE $kind AS Utf8;
            DECLARE $title AS Utf8;
            DECLARE $description AS Utf8?;
            DECLARE $action_url AS Utf8?;
            DECLARE $amount_minor AS Int64?;
            DECLARE $currency AS Utf8?;
            DECLARE $visibility AS Utf8;
            DECLARE $timezone AS Utf8;
            DECLARE $repeat_interval_minutes AS Uint32;
            DECLARE $ignore_quiet_hours AS Bool;
            DECLARE $escalation_enabled AS Bool;
            DECLARE $escalation_delay_minutes AS Uint32?;
            DECLARE $escalation_repeat_minutes AS Uint32?;
            DECLARE $watcher_user_ids AS JsonDocument;
            DECLARE $next_notification_at AS Timestamp;
            DECLARE $notification_sequence AS Uint32;
            DECLARE $message_sync_required AS Bool;
            DECLARE $message_sync_retire_only AS Bool;
            DECLARE $state_revision AS Uint64;
            DECLARE $created_at AS Timestamp;
            DECLARE $updated_at AS Timestamp;

            INSERT INTO reminder_occurrence_slots (
              workspace_id, reminder_id, due_at, occurrence_id, created_at
            ) VALUES (
              $workspace_id, $reminder_id, $due_at, $occurrence_id, $created_at
            );

            INSERT INTO reminder_occurrences (
              workspace_id, occurrence_id, reminder_id, reminder_version,
              due_at, due_local_date, all_day, reminder_start_at, status,
              notification_state, assignment_mode, responsible_user_id,
              kind, title, description, action_url, amount_minor, currency, visibility,
              timezone, repeat_interval_minutes, ignore_quiet_hours,
              escalation_enabled, escalation_delay_minutes,
              escalation_repeat_minutes, watcher_user_ids, next_notification_at,
              notification_sequence, message_sync_required,
              message_sync_retire_only, state_revision,
              created_at, updated_at
            ) VALUES (
              $workspace_id, $occurrence_id, $reminder_id, $reminder_version,
              $due_at, $due_local_date, $all_day, $reminder_start_at, $status,
              $notification_state, $assignment_mode, $responsible_user_id,
              $kind, $title, $description, $action_url, $amount_minor, $currency, $visibility,
              $timezone, $repeat_interval_minutes, $ignore_quiet_hours,
              $escalation_enabled, $escalation_delay_minutes,
              $escalation_repeat_minutes, $watcher_user_ids, $next_notification_at,
              $notification_sequence, $message_sync_required,
              $message_sync_retire_only, $state_revision,
              $created_at, $updated_at
            );

            UPDATE reminder_runtime SET
              state = 'blocked',
              next_due_at = NULL,
              next_reminder_start_at = NULL,
              current_occurrence_id = $occurrence_id,
              updated_at = $updated_at
            WHERE workspace_id = $workspace_id
              AND reminder_id = $reminder_id
              AND state = 'ready'
              AND schedule_version = $reminder_version;
          `,
          {
            $workspace_id: TypedValues.utf8(occurrence.workspaceId),
            $occurrence_id: TypedValues.utf8(occurrence.occurrenceId),
            $reminder_id: TypedValues.utf8(occurrence.reminderId),
            $reminder_version: TypedValues.uint64(occurrence.reminderVersion),
            $due_at: timestampValue(occurrence.dueAt),
            $due_local_date: TypedValues.utf8(occurrence.dueLocalDate),
            $all_day: TypedValues.bool(occurrence.allDay),
            $reminder_start_at: timestampValue(occurrence.reminderStartAt),
            $status: TypedValues.utf8(occurrence.status),
            $notification_state: TypedValues.utf8(occurrence.notificationState),
            $assignment_mode: TypedValues.utf8(occurrence.assignment.mode),
            $responsible_user_id: optionalInt64(
              occurrence.assignment.mode === "person"
                ? occurrence.assignment.responsibleUserId
                : null,
            ),
            $kind: TypedValues.utf8(occurrence.kind),
            $title: TypedValues.utf8(occurrence.title),
            $description: optionalUtf8(occurrence.description),
            $action_url: optionalUtf8(occurrence.actionUrl),
            $amount_minor: optionalInt64(occurrence.amountMinor),
            $currency: optionalUtf8(occurrence.currency),
            $visibility: TypedValues.utf8(occurrence.visibility),
            $timezone: TypedValues.utf8(occurrence.timezone),
            $repeat_interval_minutes: TypedValues.uint32(
              occurrence.repeatIntervalMinutes,
            ),
            $ignore_quiet_hours: TypedValues.bool(occurrence.ignoreQuietHours),
            $escalation_enabled: TypedValues.bool(escalation.enabled),
            $escalation_delay_minutes: optionalUint32(
              escalation.enabled ? escalation.delayMinutes : null,
            ),
            $escalation_repeat_minutes: optionalUint32(
              escalation.enabled ? escalation.repeatMinutes : null,
            ),
            $watcher_user_ids: TypedValues.jsonDocument(
              JSON.stringify(reminder.watcherUserIds),
            ),
            $next_notification_at: timestampValue(occurrence.reminderStartAt),
            $notification_sequence: TypedValues.uint32(occurrence.notificationSequence),
            $message_sync_required: TypedValues.bool(false),
            $message_sync_retire_only: TypedValues.bool(false),
            $state_revision: TypedValues.uint64(1),
            $created_at: timestampValue(occurrence.createdAt),
            $updated_at: timestampValue(occurrence.updatedAt),
          },
        );

        return occurrence;
      }),
    );
  }
}
