import { randomUUID } from "node:crypto";
import {
  reminderDraftSchema,
  reminderStatusSchema,
  type ReminderDefinition,
  type ReminderDraft,
} from "../reminder-domain.js";
import {
  calculateFirstNotificationAt,
  getNextScheduledDeadline,
} from "../reminder-scheduling.js";
import { createSessionRunner, TypedValues, Types, type SessionRunner } from "./client.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalUint32,
  optionalUtf8,
  parseJsonDocument,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

export class WorkspaceUnavailableError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace ${workspaceId} does not exist or is inactive`);
    this.name = "WorkspaceUnavailableError";
  }
}

export class InactiveWorkspaceMemberError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly userIds: number[],
  ) {
    super(`Users are not active workspace members: ${userIds.join(", ")}`);
    this.name = "InactiveWorkspaceMemberError";
  }
}

export class ScheduleHasNoFutureDeadlineError extends Error {
  constructor() {
    super("Schedule has no deadline after the reminder creation time");
    this.name = "ScheduleHasNoFutureDeadlineError";
  }
}

export class PrivateChatUnavailableError extends Error {
  constructor(readonly userId: number) {
    super(`User ${userId} has not started a private bot chat`);
    this.name = "PrivateChatUnavailableError";
  }
}

interface WorkspaceDeliverySettings {
  status: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function rowToReminder(
  data: Record<string, unknown>,
  watcherUserIds: number[],
): ReminderDefinition {
  const escalationEnabled = Boolean(getField(data, "escalation_enabled"));
  const draft = reminderDraftSchema.parse({
    title: getField(data, "title"),
    description: nullableString(getField(data, "description")),
    actionUrl: nullableString(getField(data, "action_url")),
    amountMinor:
      getField(data, "amount_minor") == null ? null : Number(getField(data, "amount_minor")),
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

function effectiveWatcherIds(draft: ReminderDraft, creatorUserId: number): number[] {
  const watcherIds = new Set(draft.watcherUserIds);
  if (
    draft.visibility === "group" &&
    draft.assignment.mode === "person" &&
    draft.assignment.responsibleUserId !== creatorUserId
  ) {
    watcherIds.add(creatorUserId);
  }
  return [...watcherIds].sort((left, right) => left - right);
}

export class RemindersRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async getById(workspaceId: string, reminderId: string): Promise<ReminderDefinition | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $reminder_id AS Utf8;

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
      const reminderRows = mapResultRows(resultSets[0]);
      if (!reminderRows[0]) {
        return null;
      }
      const watcherIds = mapResultRows(resultSets[1]).map((row) => Number(getField(row, "user_id")));
      return rowToReminder(reminderRows[0], watcherIds);
    });
  }

  async listForActor(
    workspaceId: string,
    actorUserId: number,
  ): Promise<ReminderDefinition[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $actor_user_id AS Int64;
          SELECT * FROM reminders
          WHERE workspace_id = $workspace_id
            AND status != 'archived'
            AND (
              visibility = 'group'
              OR creator_user_id = $actor_user_id
              OR responsible_user_id = $actor_user_id
            )
          ORDER BY updated_at DESC, reminder_id;

          SELECT reminder_id, user_id FROM reminder_watchers
          WHERE workspace_id = $workspace_id
          ORDER BY reminder_id, user_id;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $actor_user_id: TypedValues.int64(actorUserId),
        },
      );
      const watchers = new Map<string, number[]>();
      for (const row of mapResultRows(resultSets[1])) {
        const reminderId = String(getField(row, "reminder_id"));
        const ids = watchers.get(reminderId) ?? [];
        ids.push(Number(getField(row, "user_id")));
        watchers.set(reminderId, ids);
      }
      return mapResultRows(resultSets[0]).map((row) => {
        const reminderId = String(getField(row, "reminder_id"));
        return rowToReminder(row, watchers.get(reminderId) ?? []);
      });
    });
  }

  async create(
    workspaceId: string,
    creatorUserId: number,
    input: ReminderDraft,
    options: { reminderId?: string; now?: Date } = {},
  ): Promise<ReminderDefinition> {
    const parsed = reminderDraftSchema.parse(input);
    const now = options.now ?? new Date();
    const watcherUserIds = effectiveWatcherIds(parsed, creatorUserId);
    const reminder: ReminderDefinition = {
      ...parsed,
      watcherUserIds,
      workspaceId,
      reminderId: options.reminderId ?? randomUUID(),
      creatorUserId,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const participantIds = new Set<number>([creatorUserId, ...watcherUserIds]);
        if (reminder.assignment.mode === "person") {
          participantIds.add(reminder.assignment.responsibleUserId);
        }
        const requiredUserIds = [...participantIds].sort((left, right) => left - right);

        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $participant_ids AS List<Int64>;

            SELECT status, quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time
            FROM workspaces
            WHERE workspace_id = $workspace_id
            LIMIT 1;

            SELECT user_id, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id IN $participant_ids;

            SELECT user_id, private_chat_available FROM users
            WHERE user_id IN $participant_ids;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $participant_ids: TypedValues.list(Types.INT64, requiredUserIds),
          },
        );

        const workspaceRow = mapResultRows(resultSets[0])[0];
        if (!workspaceRow || getField(workspaceRow, "status") !== "active") {
          throw new WorkspaceUnavailableError(workspaceId);
        }
        const workspaceSettings: WorkspaceDeliverySettings = {
          status: String(getField(workspaceRow, "status")),
          quietHoursStart: String(getField(workspaceRow, "quiet_hours_start")),
          quietHoursEnd: String(getField(workspaceRow, "quiet_hours_end")),
          defaultAllDayReminderTime: String(
            getField(workspaceRow, "default_all_day_reminder_time"),
          ),
        };

        const activeUserIds = new Set(
          mapResultRows(resultSets[1])
            .filter((row) => getField(row, "status") === "active")
            .map((row) => Number(getField(row, "user_id"))),
        );
        const inactiveUserIds = requiredUserIds.filter((userId) => !activeUserIds.has(userId));
        if (inactiveUserIds.length > 0) {
          throw new InactiveWorkspaceMemberError(workspaceId, inactiveUserIds);
        }
        if (reminder.visibility === "private" && reminder.assignment.mode === "person") {
          const responsibleUserId = reminder.assignment.responsibleUserId;
          const responsibleUser = mapResultRows(resultSets[2]).find(
            (row) => Number(getField(row, "user_id")) === responsibleUserId,
          );
          if (
            !responsibleUser ||
            !Boolean(getField(responsibleUser, "private_chat_available"))
          ) {
            throw new PrivateChatUnavailableError(responsibleUserId);
          }
        }

        const deadline = getNextScheduledDeadline(reminder.schedule, reminder.timezone, now, {
          defaultAllDayReminderTime: workspaceSettings.defaultAllDayReminderTime,
        });
        if (!deadline) {
          throw new ScheduleHasNoFutureDeadlineError();
        }
        const reminderStartAt = calculateFirstNotificationAt(
          deadline,
          reminder.notificationPolicy.leadMinutes,
          reminder.timezone,
          {
            startLocal: workspaceSettings.quietHoursStart,
            endLocal: workspaceSettings.quietHoursEnd,
          },
          {
            ignoreQuietHours: reminder.notificationPolicy.ignoreQuietHours,
            notBefore: now,
          },
        );

        const escalation = reminder.notificationPolicy.escalation;
        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $title AS Utf8;
            DECLARE $description AS Utf8?;
            DECLARE $action_url AS Utf8?;
            DECLARE $amount_minor AS Int64?;
            DECLARE $currency AS Utf8?;
            DECLARE $visibility AS Utf8;
            DECLARE $creator_user_id AS Int64;
            DECLARE $assignment_mode AS Utf8;
            DECLARE $responsible_user_id AS Int64?;
            DECLARE $schedule_spec AS JsonDocument;
            DECLARE $timezone AS Utf8;
            DECLARE $lead_minutes AS Uint32;
            DECLARE $repeat_interval_minutes AS Uint32;
            DECLARE $ignore_quiet_hours AS Bool;
            DECLARE $escalation_enabled AS Bool;
            DECLARE $escalation_delay_minutes AS Uint32?;
            DECLARE $escalation_repeat_minutes AS Uint32?;
            DECLARE $status AS Utf8;
            DECLARE $version AS Uint64;
            DECLARE $next_due_at AS Timestamp;
            DECLARE $next_reminder_start_at AS Timestamp;
            DECLARE $created_at AS Timestamp;
            DECLARE $updated_at AS Timestamp;

            INSERT INTO reminders (
              workspace_id, reminder_id, title, description, action_url,
              amount_minor, currency, visibility, creator_user_id,
              assignment_mode, responsible_user_id, schedule_spec, timezone,
              lead_minutes, repeat_interval_minutes, ignore_quiet_hours,
              escalation_enabled, escalation_delay_minutes,
              escalation_repeat_minutes, status, version, created_at, updated_at
            ) VALUES (
              $workspace_id, $reminder_id, $title, $description, $action_url,
              $amount_minor, $currency, $visibility, $creator_user_id,
              $assignment_mode, $responsible_user_id, $schedule_spec, $timezone,
              $lead_minutes, $repeat_interval_minutes, $ignore_quiet_hours,
              $escalation_enabled, $escalation_delay_minutes,
              $escalation_repeat_minutes, $status, $version, $created_at, $updated_at
            );

            INSERT INTO reminder_runtime (
              workspace_id, reminder_id, state, next_due_at, next_reminder_start_at,
              current_occurrence_id, schedule_version, updated_at
            ) VALUES (
              $workspace_id, $reminder_id, 'ready', $next_due_at, $next_reminder_start_at,
              NULL, $version, $updated_at
            );
          `,
          {
            $workspace_id: TypedValues.utf8(reminder.workspaceId),
            $reminder_id: TypedValues.utf8(reminder.reminderId),
            $title: TypedValues.utf8(reminder.title),
            $description: optionalUtf8(reminder.description),
            $action_url: optionalUtf8(reminder.actionUrl),
            $amount_minor: optionalInt64(reminder.amountMinor),
            $currency: optionalUtf8(reminder.currency),
            $visibility: TypedValues.utf8(reminder.visibility),
            $creator_user_id: TypedValues.int64(reminder.creatorUserId),
            $assignment_mode: TypedValues.utf8(reminder.assignment.mode),
            $responsible_user_id: optionalInt64(
              reminder.assignment.mode === "person"
                ? reminder.assignment.responsibleUserId
                : null,
            ),
            $schedule_spec: TypedValues.jsonDocument(JSON.stringify(reminder.schedule)),
            $timezone: TypedValues.utf8(reminder.timezone),
            $lead_minutes: TypedValues.uint32(reminder.notificationPolicy.leadMinutes),
            $repeat_interval_minutes: TypedValues.uint32(
              reminder.notificationPolicy.repeatIntervalMinutes,
            ),
            $ignore_quiet_hours: TypedValues.bool(
              reminder.notificationPolicy.ignoreQuietHours,
            ),
            $escalation_enabled: TypedValues.bool(escalation.enabled),
            $escalation_delay_minutes: optionalUint32(
              escalation.enabled ? escalation.delayMinutes : null,
            ),
            $escalation_repeat_minutes: optionalUint32(
              escalation.enabled ? escalation.repeatMinutes : null,
            ),
            $status: TypedValues.utf8(reminder.status),
            $version: TypedValues.uint64(reminder.version),
            $next_due_at: timestampValue(deadline.dueAt),
            $next_reminder_start_at: timestampValue(reminderStartAt),
            $created_at: timestampValue(reminder.createdAt),
            $updated_at: timestampValue(reminder.updatedAt),
          },
        );

        for (const watcherUserId of watcherUserIds) {
          await transaction.executeQuery(
            `
              DECLARE $workspace_id AS Utf8;
              DECLARE $reminder_id AS Utf8;
              DECLARE $user_id AS Int64;
              DECLARE $created_at AS Timestamp;

              INSERT INTO reminder_watchers (
                workspace_id, reminder_id, user_id, created_at
              ) VALUES ($workspace_id, $reminder_id, $user_id, $created_at);
            `,
            {
              $workspace_id: TypedValues.utf8(reminder.workspaceId),
              $reminder_id: TypedValues.utf8(reminder.reminderId),
              $user_id: TypedValues.int64(watcherUserId),
              $created_at: timestampValue(reminder.createdAt),
            },
          );
        }

      }),
    );

    return reminder;
  }
}
