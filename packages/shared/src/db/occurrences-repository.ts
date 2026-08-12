import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  escalationPolicySchema,
  occurrenceNotificationStateSchema,
  occurrenceStatusSchema,
  reminderDraftSchema,
  reminderRuntimeStateSchema,
  reminderStatusSchema,
  reminderVisibilitySchema,
  type ReminderDefinition,
  type ReminderOccurrence,
  type ReminderRuntime,
} from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction } from "./transaction.js";
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

export function rowToReminder(data: Record<string, unknown>): ReminderDefinition {
  const escalationEnabled = Boolean(getField(data, "escalation_enabled"));
  const draft = reminderDraftSchema.parse({
    title: getField(data, "title"),
    description: nullableString(getField(data, "description")),
    actionUrl: nullableString(getField(data, "action_url")),
    amountMinor: nullableNumber(getField(data, "amount_minor")),
    currency: nullableString(getField(data, "currency")),
    visibility: getField(data, "visibility"),
    assignment:
      getField(data, "assignment_mode") === "person"
        ? {
            mode: "person",
            responsibleUserId: Number(getField(data, "responsible_user_id")),
          }
        : { mode: "anyone" },
    watcherUserIds: [],
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
            AND (
              occurrence.visibility = 'group'
              OR reminder.creator_user_id = $actor_user_id
              OR occurrence.responsible_user_id = $actor_user_id
            )
          ORDER BY occurrence.due_at, occurrence.occurrence_id;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $actor_user_id: TypedValues.int64(actorUserId),
        },
      );
      return mapResultRows(resultSets[0]).map(rowToOccurrence);
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
        const reminder = rowToReminder(reminderRow);
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
          dueAt: runtime.nextDueAt,
          dueLocalDate:
            DateTime.fromJSDate(runtime.nextDueAt, { zone: reminder.timezone }).toISODate() ?? "",
          allDay: reminder.schedule.timing.kind === "allDay",
          reminderStartAt: runtime.nextReminderStartAt,
          status: runtime.nextDueAt <= now ? "overdue" : "pending",
          notificationState: "waiting",
          assignment: reminder.assignment,
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
            DECLARE $next_notification_at AS Timestamp;
            DECLARE $notification_sequence AS Uint32;
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
              title, description, action_url, amount_minor, currency, visibility,
              timezone, repeat_interval_minutes, ignore_quiet_hours,
              escalation_enabled, escalation_delay_minutes,
              escalation_repeat_minutes, next_notification_at,
              notification_sequence, created_at, updated_at
            ) VALUES (
              $workspace_id, $occurrence_id, $reminder_id, $reminder_version,
              $due_at, $due_local_date, $all_day, $reminder_start_at, $status,
              $notification_state, $assignment_mode, $responsible_user_id,
              $title, $description, $action_url, $amount_minor, $currency, $visibility,
              $timezone, $repeat_interval_minutes, $ignore_quiet_hours,
              $escalation_enabled, $escalation_delay_minutes,
              $escalation_repeat_minutes, $next_notification_at,
              $notification_sequence, $created_at, $updated_at
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
            $next_notification_at: timestampValue(occurrence.reminderStartAt),
            $notification_sequence: TypedValues.uint32(occurrence.notificationSequence),
            $created_at: timestampValue(occurrence.createdAt),
            $updated_at: timestampValue(occurrence.updatedAt),
          },
        );

        return occurrence;
      }),
    );
  }
}
