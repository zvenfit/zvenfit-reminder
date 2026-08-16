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
import { prepareOccurrenceMutation } from "./delivery-guard.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalTimestamp,
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

export class ReminderReassignmentForbiddenError extends Error {
  constructor() {
    super("Only an owner or organizer can reassign reminders");
    this.name = "ReminderReassignmentForbiddenError";
  }
}

export class ReminderLifecycleForbiddenError extends Error {
  constructor() {
    super("Actor cannot change this reminder lifecycle");
    this.name = "ReminderLifecycleForbiddenError";
  }
}

export class ReminderLifecycleConflictError extends Error {
  constructor(readonly status: string, readonly action: string) {
    super(`Cannot ${action} a reminder in ${status} status`);
    this.name = "ReminderLifecycleConflictError";
  }
}

export class ReminderUpdateForbiddenError extends Error {
  constructor() {
    super("Actor cannot edit this reminder");
    this.name = "ReminderUpdateForbiddenError";
  }
}

export class ReminderCreateForbiddenError extends Error {
  constructor() {
    super("Actor cannot create this reminder");
    this.name = "ReminderCreateForbiddenError";
  }
}

export class ReminderUpdateConflictError extends Error {
  constructor(readonly reason: string) {
    super(`Reminder cannot be edited right now: ${reason}`);
    this.name = "ReminderUpdateConflictError";
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
  const storedAmount = getField(data, "amount_minor");
  const draft = reminderDraftSchema.parse({
    kind: getField(data, "kind") ?? (storedAmount == null ? "task" : "payment"),
    title: getField(data, "title"),
    description: nullableString(getField(data, "description")),
    actionUrl: nullableString(getField(data, "action_url")),
    amountMinor: storedAmount == null ? null : Number(storedAmount),
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

function effectiveWatcherIds(
  draft: ReminderDraft,
  creatorUserId: number,
  includeCreator = true,
): number[] {
  const watcherIds = new Set(draft.watcherUserIds);
  if (
    includeCreator &&
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

          SELECT watcher.user_id AS user_id FROM reminder_watchers AS watcher
          INNER JOIN workspace_members AS member
            ON member.workspace_id = watcher.workspace_id
            AND member.user_id = watcher.user_id
          WHERE watcher.workspace_id = $workspace_id
            AND watcher.reminder_id = $reminder_id
            AND member.status = 'active'
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

          SELECT watcher.reminder_id AS reminder_id, watcher.user_id AS user_id
          FROM reminder_watchers AS watcher
          INNER JOIN workspace_members AS member
            ON member.workspace_id = watcher.workspace_id
            AND member.user_id = watcher.user_id
          WHERE watcher.workspace_id = $workspace_id
            AND member.status = 'active'
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

            SELECT user_id, role, status FROM workspace_members
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

        const memberRows = mapResultRows(resultSets[1]);
        const creatorMember = memberRows.find(
          (row) => Number(getField(row, "user_id")) === creatorUserId,
        );
        const creatorRole = creatorMember ? String(getField(creatorMember, "role")) : null;
        const canCreate = Boolean(
          creatorMember &&
          getField(creatorMember, "status") === "active" &&
          (reminder.visibility === "group"
            ? creatorRole === "owner" || creatorRole === "organizer"
            : reminder.assignment.mode === "person" &&
              (creatorRole === "owner" ||
                creatorRole === "organizer" ||
                reminder.assignment.responsibleUserId === creatorUserId)),
        );
        if (!canCreate) {
          throw new ReminderCreateForbiddenError();
        }

        const activeUserIds = new Set(
          memberRows
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
            DECLARE $kind AS Utf8;
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
              workspace_id, reminder_id, kind, title, description, action_url,
              amount_minor, currency, visibility, creator_user_id,
              assignment_mode, responsible_user_id, schedule_spec, timezone,
              lead_minutes, repeat_interval_minutes, ignore_quiet_hours,
              escalation_enabled, escalation_delay_minutes,
              escalation_repeat_minutes, status, version, created_at, updated_at
            ) VALUES (
              $workspace_id, $reminder_id, $kind, $title, $description, $action_url,
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
            $kind: TypedValues.utf8(reminder.kind),
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

  async reassign(
    workspaceId: string,
    reminderId: string,
    responsibleUserId: number,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderDefinition | null> {
    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $responsible_user_id AS Int64;
            SELECT role, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $responsible_user_id
            LIMIT 1;

            SELECT reminder.*, creator.status AS creator_member_status
            FROM reminders AS reminder
            LEFT JOIN workspace_members AS creator
              ON creator.workspace_id = reminder.workspace_id
              AND creator.user_id = reminder.creator_user_id
            WHERE reminder.workspace_id = $workspace_id
              AND reminder.reminder_id = $reminder_id
            LIMIT 1;

            SELECT private_chat_available FROM users
            WHERE user_id = $responsible_user_id LIMIT 1;

            SELECT occurrence.* FROM reminder_occurrences AS occurrence
            INNER JOIN reminder_runtime AS runtime
              ON runtime.workspace_id = occurrence.workspace_id
              AND runtime.current_occurrence_id = occurrence.occurrence_id
            WHERE runtime.workspace_id = $workspace_id
              AND runtime.reminder_id = $reminder_id
            LIMIT 1;

            SELECT watcher.user_id AS user_id, member.status AS member_status
            FROM reminder_watchers AS watcher
            INNER JOIN workspace_members AS member
              ON member.workspace_id = watcher.workspace_id
              AND member.user_id = watcher.user_id
            WHERE watcher.workspace_id = $workspace_id
              AND watcher.reminder_id = $reminder_id
              AND watcher.user_id != $responsible_user_id
              AND member.status = 'active'
            ORDER BY user_id;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $responsible_user_id: TypedValues.int64(responsibleUserId),
          },
        );
        const actorRow = mapResultRows(resultSets[0])[0];
        const targetRow = mapResultRows(resultSets[1])[0];
        const reminderRow = mapResultRows(resultSets[2])[0];
        const userRow = mapResultRows(resultSets[3])[0];
        const currentOccurrenceRow = mapResultRows(resultSets[4])[0];
        const existingWatcherUserIds = mapResultRows(resultSets[5])
          .map((row) => Number(getField(row, "user_id")))
          .filter((userId) => userId !== responsibleUserId);
        if (!reminderRow) {
          return;
        }
        if (
          !actorRow ||
          getField(actorRow, "status") !== "active" ||
          (
            getField(reminderRow, "visibility") === "group"
              ? !["owner", "organizer"].includes(String(getField(actorRow, "role")))
              : actorUserId !== Number(getField(reminderRow, "creator_user_id")) &&
                actorUserId !== Number(getField(reminderRow, "responsible_user_id"))
          )
        ) {
          throw new ReminderReassignmentForbiddenError();
        }
        if (getField(reminderRow, "status") === "archived") {
          throw new ReminderReassignmentForbiddenError();
        }
        if (
          getField(reminderRow, "visibility") === "private" &&
          !["owner", "organizer"].includes(String(getField(actorRow, "role"))) &&
          responsibleUserId !== actorUserId
        ) {
          throw new ReminderReassignmentForbiddenError();
        }
        if (!targetRow || getField(targetRow, "status") !== "active") {
          throw new InactiveWorkspaceMemberError(workspaceId, [responsibleUserId]);
        }
        if (
          getField(reminderRow, "visibility") === "private" &&
          (!userRow || !Boolean(getField(userRow, "private_chat_available")))
        ) {
          throw new PrivateChatUnavailableError(responsibleUserId);
        }
        if (currentOccurrenceRow) {
          await prepareOccurrenceMutation(
            transaction,
            workspaceId,
            currentOccurrenceRow,
            String(getField(currentOccurrenceRow, "occurrence_id")),
            now,
          );
        }
        const creatorUserId = Number(getField(reminderRow, "creator_user_id"));
        const creatorIsActive =
          getField(reminderRow, "creator_member_status") === "active" ||
          (creatorUserId === actorUserId && getField(actorRow, "status") === "active") ||
          (creatorUserId === responsibleUserId && getField(targetRow, "status") === "active");
        const shouldWatchCreator =
          getField(reminderRow, "visibility") === "group" &&
          creatorIsActive &&
          creatorUserId !== responsibleUserId;
        const watcherUserIds = [...new Set(existingWatcherUserIds)];
        if (shouldWatchCreator && !watcherUserIds.includes(creatorUserId)) {
          watcherUserIds.push(creatorUserId);
        }
        watcherUserIds.sort((left, right) => left - right);
        const activateReminder =
          getField(reminderRow, "status") === "active" || Boolean(currentOccurrenceRow);
        const retireOldMessage = Boolean(
          getField(reminderRow, "visibility") === "private" &&
          Number(getField(reminderRow, "responsible_user_id")) !== responsibleUserId &&
          currentOccurrenceRow &&
          getField(currentOccurrenceRow, "latest_message_id") != null,
        );

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $responsible_user_id AS Int64;
            DECLARE $actor_user_id AS Int64;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $watcher_user_ids AS JsonDocument;
            DECLARE $activate_reminder AS Bool;
            DECLARE $retire_old_message AS Bool;
            DECLARE $person_assignment AS Utf8;
            DECLARE $active_status AS Utf8;
            DECLARE $waiting_notification_state AS Utf8;
            DECLARE $ready_runtime_state AS Utf8;
            DECLARE $paused_runtime_state AS Utf8;
            DECLARE $blocked_runtime_state AS Utf8;
            DECLARE $revision_increment AS Uint64;
            UPDATE reminders SET
              assignment_mode = $person_assignment, responsible_user_id = $responsible_user_id,
              status = IF($activate_reminder, $active_status, status), updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            DELETE FROM reminder_watchers
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
              AND user_id = $responsible_user_id;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + $revision_increment,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              assignment_mode = $person_assignment, responsible_user_id = $responsible_user_id,
              notification_state = $waiting_notification_state, next_notification_at = $now,
              watcher_user_ids = $watcher_user_ids,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              message_sync_retire_only = IF(
                $retire_old_message, true, message_sync_retire_only
              ),
              updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
              AND status IN ('scheduled', 'pending', 'overdue');

            UPDATE reminder_runtime SET
              state = IF(
                current_occurrence_id IS NULL,
                IF($activate_reminder, $ready_runtime_state, $paused_runtime_state),
                $blocked_runtime_state
              ),
              updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $reminder_id, $now, $event_id, 'reminder',
              'reminder.reassigned', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
            $responsible_user_id: TypedValues.int64(responsibleUserId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(JSON.stringify({
              fromUserId: Number(getField(reminderRow, "responsible_user_id")),
              toUserId: responsibleUserId,
            })),
            $watcher_user_ids: TypedValues.jsonDocument(JSON.stringify(watcherUserIds)),
            $activate_reminder: TypedValues.bool(activateReminder),
            $retire_old_message: TypedValues.bool(retireOldMessage),
            $person_assignment: TypedValues.utf8("person"),
            $active_status: TypedValues.utf8("active"),
            $waiting_notification_state: TypedValues.utf8("waiting"),
            $ready_runtime_state: TypedValues.utf8("ready"),
            $paused_runtime_state: TypedValues.utf8("paused"),
            $blocked_runtime_state: TypedValues.utf8("blocked"),
            $revision_increment: TypedValues.uint64(1),
          },
        );

        if (shouldWatchCreator && !existingWatcherUserIds.includes(creatorUserId)) {
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
              $workspace_id: TypedValues.utf8(workspaceId),
              $reminder_id: TypedValues.utf8(reminderId),
              $user_id: TypedValues.int64(creatorUserId),
              $created_at: timestampValue(now),
            },
          );
        }
      }),
    );
    return this.getById(workspaceId, reminderId);
  }

  async update(
    workspaceId: string,
    reminderId: string,
    input: ReminderDraft,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderDefinition | null> {
    const parsed = reminderDraftSchema.parse(input);

    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $actor_user_id AS Int64;

            SELECT status, quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time
            FROM workspaces WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT role, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT * FROM reminders
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
            LIMIT 1;

            SELECT runtime.current_occurrence_id AS current_occurrence_id,
              occurrence.due_at AS current_due_at,
              occurrence.status AS current_status,
              occurrence.latest_message_id AS current_latest_message_id,
              occurrence.delivery_lock_key AS delivery_lock_key,
              occurrence.delivery_locked_at AS delivery_locked_at
            FROM reminder_runtime AS runtime
            LEFT JOIN reminder_occurrences AS occurrence
              ON occurrence.workspace_id = runtime.workspace_id
              AND occurrence.occurrence_id = runtime.current_occurrence_id
            WHERE runtime.workspace_id = $workspace_id
              AND runtime.reminder_id = $reminder_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        const actorRow = mapResultRows(resultSets[1])[0];
        const reminderRow = mapResultRows(resultSets[2])[0];
        const runtimeRow = mapResultRows(resultSets[3])[0];
        if (!reminderRow) return;
        if (!workspaceRow || !runtimeRow) {
          throw new WorkspaceUnavailableError(workspaceId);
        }
        const existingVisibility = String(getField(reminderRow, "visibility"));
        const actorIsManager = Boolean(
          actorRow &&
          getField(actorRow, "status") === "active" &&
          ["owner", "organizer"].includes(String(getField(actorRow, "role"))),
        );
        const canEdit = Boolean(
          getField(workspaceRow, "status") === "active" &&
          actorRow &&
          getField(actorRow, "status") === "active" &&
          (existingVisibility === "group"
            ? actorIsManager
            : actorUserId === Number(getField(reminderRow, "creator_user_id")) ||
              actorUserId === Number(getField(reminderRow, "responsible_user_id"))) &&
          (parsed.visibility !== "group" || actorIsManager),
        );
        const canAssignPrivateTarget = parsed.visibility !== "private" ||
          parsed.assignment.mode !== "person" ||
          actorIsManager ||
          parsed.assignment.responsibleUserId === actorUserId;
        if (
          !canEdit ||
          !canAssignPrivateTarget ||
          getField(reminderRow, "status") === "archived"
        ) {
          throw new ReminderUpdateForbiddenError();
        }
        const currentOccurrenceId = getField(runtimeRow, "current_occurrence_id");
        if (currentOccurrenceId != null) {
          await prepareOccurrenceMutation(
            transaction,
            workspaceId,
            runtimeRow,
            String(currentOccurrenceId),
            now,
          );
          if (getField(runtimeRow, "current_status") === "completed") {
            throw new ReminderUpdateConflictError("completion_undo_window");
          }
        }

        const creatorUserId = Number(getField(reminderRow, "creator_user_id"));
        const requiredParticipantIds = new Set<number>(parsed.watcherUserIds);
        if (parsed.assignment.mode === "person") {
          requiredParticipantIds.add(parsed.assignment.responsibleUserId);
        }
        const lookupUserIds = [...new Set([creatorUserId, ...requiredParticipantIds])]
          .sort((left, right) => left - right);
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
            $participant_ids: TypedValues.list(Types.INT64, lookupUserIds),
          },
        );
        const activeUserIds = new Set(
          mapResultRows(participantResultSets[0])
            .filter((row) => getField(row, "status") === "active")
            .map((row) => Number(getField(row, "user_id"))),
        );
        const inactiveUserIds = [...requiredParticipantIds]
          .filter((userId) => !activeUserIds.has(userId));
        if (inactiveUserIds.length > 0) {
          throw new InactiveWorkspaceMemberError(workspaceId, inactiveUserIds);
        }
        const watcherUserIds = effectiveWatcherIds(
          parsed,
          creatorUserId,
          activeUserIds.has(creatorUserId),
        );
        if (parsed.visibility === "private" && parsed.assignment.mode === "person") {
          const responsibleUserId = parsed.assignment.responsibleUserId;
          const responsibleUser = mapResultRows(participantResultSets[1]).find(
            (row) => Number(getField(row, "user_id")) === responsibleUserId,
          );
          if (!responsibleUser || !Boolean(getField(responsibleUser, "private_chat_available"))) {
            throw new PrivateChatUnavailableError(responsibleUserId);
          }
        }

        const hasCurrentOccurrence = getField(runtimeRow, "current_occurrence_id") != null;
        const nextResponsibleUserId = parsed.assignment.mode === "person"
          ? parsed.assignment.responsibleUserId
          : null;
        const currentResponsibleUserId = getField(reminderRow, "responsible_user_id") == null
          ? null
          : Number(getField(reminderRow, "responsible_user_id"));
        const deliveryTargetChanged =
          existingVisibility !== parsed.visibility ||
          (existingVisibility === "private" &&
            parsed.visibility === "private" &&
            currentResponsibleUserId !== nextResponsibleUserId);
        const migrateLiveMessage = Boolean(
          deliveryTargetChanged && getField(runtimeRow, "current_latest_message_id") != null,
        );
        const scheduleChanged =
          JSON.stringify(parseJsonDocument(getField(reminderRow, "schedule_spec"), null)) !==
            JSON.stringify(parsed.schedule) ||
          String(getField(reminderRow, "timezone")) !== parsed.timezone;
        const currentDueAt = hasCurrentOccurrence
          ? parseYdbTimestampRequired(getField(runtimeRow, "current_due_at"), "current_due_at")
          : null;
        const deadline = getNextScheduledDeadline(
          parsed.schedule,
          parsed.timezone,
          now,
          {
          defaultAllDayReminderTime: String(
            getField(workspaceRow, "default_all_day_reminder_time"),
          ),
          },
        );
        if (!deadline && (!hasCurrentOccurrence || scheduleChanged)) {
          throw new ScheduleHasNoFutureDeadlineError();
        }
        const reminderStartAt = deadline
          ? calculateFirstNotificationAt(
              deadline,
              parsed.notificationPolicy.leadMinutes,
              parsed.timezone,
              {
                startLocal: String(getField(workspaceRow, "quiet_hours_start")),
                endLocal: String(getField(workspaceRow, "quiet_hours_end")),
              },
              {
                ignoreQuietHours: parsed.notificationPolicy.ignoreQuietHours,
                notBefore: now,
              },
            )
          : null;
        const nextVersion = Number(getField(reminderRow, "version")) + 1;
        const escalation = parsed.notificationPolicy.escalation;

        if (scheduleChanged && currentOccurrenceId != null && currentDueAt && deadline) {
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
              ) VALUES (
                $workspace_id, $reminder_id, $new_due_at, $occurrence_id, $now
              );
            `,
            {
              $workspace_id: TypedValues.utf8(workspaceId),
              $reminder_id: TypedValues.utf8(reminderId),
              $occurrence_id: TypedValues.utf8(String(currentOccurrenceId)),
              $old_due_at: timestampValue(currentDueAt),
              $new_due_at: timestampValue(deadline.dueAt),
              $now: timestampValue(now),
            },
          );
        }

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
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
            DECLARE $schedule_spec AS JsonDocument;
            DECLARE $timezone AS Utf8;
            DECLARE $lead_minutes AS Uint32;
            DECLARE $repeat_interval_minutes AS Uint32;
            DECLARE $ignore_quiet_hours AS Bool;
            DECLARE $escalation_enabled AS Bool;
            DECLARE $escalation_delay_minutes AS Uint32?;
            DECLARE $escalation_repeat_minutes AS Uint32?;
            DECLARE $version AS Uint64;
            DECLARE $schedule_changed AS Bool;
            DECLARE $migrate_live_message AS Bool;
            DECLARE $next_due_at AS Timestamp?;
            DECLARE $next_due_local_date AS Utf8?;
            DECLARE $next_all_day AS Bool?;
            DECLARE $next_reminder_start_at AS Timestamp?;
            DECLARE $watcher_user_ids AS JsonDocument;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $revision_increment AS Uint64;
            DECLARE $overdue_status AS Utf8;
            DECLARE $pending_status AS Utf8;

            UPDATE reminders SET
              kind = $kind, title = $title, description = $description, action_url = $action_url,
              amount_minor = $amount_minor, currency = $currency,
              visibility = $visibility, assignment_mode = $assignment_mode,
              responsible_user_id = $responsible_user_id,
              schedule_spec = $schedule_spec, timezone = $timezone,
              lead_minutes = $lead_minutes,
              repeat_interval_minutes = $repeat_interval_minutes,
              ignore_quiet_hours = $ignore_quiet_hours,
              escalation_enabled = $escalation_enabled,
              escalation_delay_minutes = $escalation_delay_minutes,
              escalation_repeat_minutes = $escalation_repeat_minutes,
              version = $version, updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            UPDATE reminder_runtime SET
              next_due_at = IF(current_occurrence_id IS NULL, $next_due_at, next_due_at),
              next_reminder_start_at = IF(
                current_occurrence_id IS NULL,
                $next_reminder_start_at,
                next_reminder_start_at
              ),
              schedule_version = $version,
              updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + $revision_increment,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              reminder_version = $version,
              due_at = IF($schedule_changed, COALESCE($next_due_at, due_at), due_at),
              due_local_date = IF(
                $schedule_changed, COALESCE($next_due_local_date, due_local_date), due_local_date
              ),
              all_day = IF($schedule_changed, COALESCE($next_all_day, all_day), all_day),
              reminder_start_at = IF(
                $schedule_changed,
                COALESCE($next_reminder_start_at, reminder_start_at),
                reminder_start_at
              ),
              status = IF(
                $schedule_changed,
                IF(
                  COALESCE($next_due_at, due_at) <= $now,
                  $overdue_status,
                  $pending_status
                ),
                status
              ),
              next_notification_at = IF(
                notification_state = 'waiting',
                IF(
                  $migrate_live_message,
                  $now,
                  IF(
                    $schedule_changed,
                    COALESCE($next_reminder_start_at, $now),
                    $now
                  )
                ),
                next_notification_at
              ),
              kind = $kind, title = $title, description = $description, action_url = $action_url,
              amount_minor = $amount_minor, currency = $currency,
              visibility = $visibility, assignment_mode = $assignment_mode,
              responsible_user_id = $responsible_user_id,
              timezone = $timezone,
              repeat_interval_minutes = $repeat_interval_minutes,
              ignore_quiet_hours = $ignore_quiet_hours,
              escalation_enabled = $escalation_enabled,
              escalation_delay_minutes = $escalation_delay_minutes,
              escalation_repeat_minutes = $escalation_repeat_minutes,
              watcher_user_ids = $watcher_user_ids,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              message_sync_retire_only = IF(
                $migrate_live_message, true, message_sync_retire_only
              ),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id = $reminder_id
              AND occurrence_id IN (
                SELECT current_occurrence_id FROM reminder_runtime
                WHERE workspace_id = $workspace_id
                  AND reminder_id = $reminder_id
                  AND current_occurrence_id IS NOT NULL
              )
              AND status IN ('scheduled', 'pending', 'overdue');

            DELETE FROM reminder_watchers
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $reminder_id, $now, $event_id, 'reminder',
              'reminder.updated', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
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
            $schedule_spec: TypedValues.jsonDocument(JSON.stringify(parsed.schedule)),
            $timezone: TypedValues.utf8(parsed.timezone),
            $lead_minutes: TypedValues.uint32(parsed.notificationPolicy.leadMinutes),
            $repeat_interval_minutes: TypedValues.uint32(
              parsed.notificationPolicy.repeatIntervalMinutes,
            ),
            $ignore_quiet_hours: TypedValues.bool(parsed.notificationPolicy.ignoreQuietHours),
            $escalation_enabled: TypedValues.bool(escalation.enabled),
            $escalation_delay_minutes: optionalUint32(
              escalation.enabled ? escalation.delayMinutes : null,
            ),
            $escalation_repeat_minutes: optionalUint32(
              escalation.enabled ? escalation.repeatMinutes : null,
            ),
            $version: TypedValues.uint64(nextVersion),
            $watcher_user_ids: TypedValues.jsonDocument(JSON.stringify(watcherUserIds)),
            $schedule_changed: TypedValues.bool(scheduleChanged),
            $migrate_live_message: TypedValues.bool(migrateLiveMessage),
            $next_due_local_date: deadline
              ? TypedValues.optional(TypedValues.utf8(deadline.dueLocalDate))
              : TypedValues.optionalNull(Types.UTF8),
            $next_all_day: deadline
              ? TypedValues.optional(TypedValues.bool(deadline.allDay))
              : TypedValues.optionalNull(Types.BOOL),
            $next_due_at: optionalTimestamp(deadline?.dueAt),
            $next_reminder_start_at: optionalTimestamp(reminderStartAt),
            $now: timestampValue(now),
            $revision_increment: TypedValues.uint64(1),
            $overdue_status: TypedValues.utf8("overdue"),
            $pending_status: TypedValues.utf8("pending"),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(JSON.stringify({
              fromVersion: nextVersion - 1,
              toVersion: nextVersion,
              currentOccurrenceUpdated: hasCurrentOccurrence,
            })),
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
              $workspace_id: TypedValues.utf8(workspaceId),
              $reminder_id: TypedValues.utf8(reminderId),
              $user_id: TypedValues.int64(watcherUserId),
              $created_at: timestampValue(now),
            },
          );
        }
      }),
    );

    return this.getById(workspaceId, reminderId);
  }

  async changeLifecycle(
    workspaceId: string,
    reminderId: string,
    action: "pause" | "resume" | "archive",
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<ReminderDefinition | null> {
    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            SELECT role, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT * FROM reminders
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id
            LIMIT 1;

            SELECT occurrence.* FROM reminder_occurrences AS occurrence
            INNER JOIN reminder_runtime AS runtime
              ON runtime.workspace_id = occurrence.workspace_id
              AND runtime.current_occurrence_id = occurrence.occurrence_id
            WHERE runtime.workspace_id = $workspace_id
              AND runtime.reminder_id = $reminder_id
            LIMIT 1;

            SELECT member.status AS status FROM workspace_members AS member
            INNER JOIN reminders AS reminder
              ON reminder.workspace_id = member.workspace_id
              AND reminder.responsible_user_id = member.user_id
            WHERE reminder.workspace_id = $workspace_id
              AND reminder.reminder_id = $reminder_id
              AND reminder.assignment_mode = 'person'
            LIMIT 1;

            SELECT quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time
            FROM workspaces WHERE workspace_id = $workspace_id LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const actorRow = mapResultRows(resultSets[0])[0];
        const reminderRow = mapResultRows(resultSets[1])[0];
        const currentOccurrenceRow = mapResultRows(resultSets[2])[0];
        const responsibleRow = mapResultRows(resultSets[3])[0];
        const workspaceRow = mapResultRows(resultSets[4])[0];
        if (!reminderRow) return;
        const currentStatus = String(getField(reminderRow, "status"));
        const visibility = String(getField(reminderRow, "visibility"));
        const canManage = Boolean(
          actorRow &&
          getField(actorRow, "status") === "active" &&
          (visibility === "group"
            ? ["owner", "organizer"].includes(String(getField(actorRow, "role")))
            : actorUserId === Number(getField(reminderRow, "creator_user_id")) ||
              actorUserId === Number(getField(reminderRow, "responsible_user_id"))),
        );
        if (!canManage) throw new ReminderLifecycleForbiddenError();

        const nextStatus = action === "archive" ? "archived" : action === "pause" ? "paused" : "active";
        if (currentStatus === nextStatus) {
          return;
        }
        if (
          currentStatus === "archived" ||
          (action === "pause" && currentStatus !== "active") ||
          (action === "resume" && currentStatus !== "paused")
        ) {
          throw new ReminderLifecycleConflictError(currentStatus, action);
        }
        if (
          action === "resume" &&
          getField(reminderRow, "assignment_mode") === "person" &&
          getField(responsibleRow ?? {}, "status") !== "active"
        ) {
          throw new ReminderLifecycleConflictError(currentStatus, action);
        }
        if (
          action !== "archive" &&
          currentOccurrenceRow &&
          getField(currentOccurrenceRow, "status") === "completed" &&
          getField(currentOccurrenceRow, "undo_until") != null
        ) {
          throw new ReminderLifecycleConflictError(currentStatus, action);
        }
        if (currentOccurrenceRow) {
          await prepareOccurrenceMutation(
            transaction,
            workspaceId,
            currentOccurrenceRow,
            String(getField(currentOccurrenceRow, "occurrence_id")),
            now,
          );
        }

        const currentOccurrence = currentOccurrenceRow
          ? {
              occurrenceId: String(getField(currentOccurrenceRow, "occurrence_id")),
              status: String(getField(currentOccurrenceRow, "status")),
              dueAt: parseYdbTimestampRequired(
                getField(currentOccurrenceRow, "due_at"),
                "due_at",
              ),
            }
          : null;
        const restoreCurrent = Boolean(
          action === "resume" &&
          currentOccurrence &&
          ["scheduled", "pending", "overdue"].includes(currentOccurrence.status) &&
          currentOccurrence.dueAt > now,
        );
        let nextDueAt: Date | null = null;
        let nextReminderStartAt: Date | null = null;
        if (action === "resume" && !restoreCurrent) {
          if (!workspaceRow) throw new WorkspaceUnavailableError(workspaceId);
          const reminder = rowToReminder(reminderRow, []);
          const deadline = getNextScheduledDeadline(
            reminder.schedule,
            reminder.timezone,
            now,
            {
              defaultAllDayReminderTime: String(
                getField(workspaceRow, "default_all_day_reminder_time"),
              ),
            },
          );
          if (!deadline) {
            throw new ReminderLifecycleConflictError(currentStatus, action);
          }
          nextDueAt = deadline.dueAt;
          nextReminderStartAt = calculateFirstNotificationAt(
            deadline,
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
        }

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $next_status AS Utf8;
            DECLARE $action AS Utf8;
            DECLARE $current_occurrence_id AS Utf8?;
            DECLARE $restore_current AS Bool;
            DECLARE $next_due_at AS Timestamp?;
            DECLARE $next_reminder_start_at AS Timestamp?;
            DECLARE $schedule_version AS Uint64;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $event_type AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $resume_action AS Utf8;
            DECLARE $pause_action AS Utf8;
            DECLARE $archive_action AS Utf8;
            DECLARE $paused_runtime_state AS Utf8;
            DECLARE $blocked_runtime_state AS Utf8;
            DECLARE $ready_runtime_state AS Utf8;
            DECLARE $waiting_notification_state AS Utf8;
            DECLARE $stopped_notification_state AS Utf8;
            DECLARE $cancelled_status AS Utf8;
            DECLARE $completed_status AS Utf8;
            DECLARE $reminder_archived_reason AS Utf8;
            DECLARE $missed_while_paused_reason AS Utf8;
            DECLARE $revision_increment AS Uint64;

            UPDATE reminders SET status = $next_status, updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            UPDATE reminder_runtime SET
              state = IF(
                $action != $resume_action,
                $paused_runtime_state,
                IF($restore_current, $blocked_runtime_state, $ready_runtime_state)
              ),
              next_due_at = IF($action = $resume_action, $next_due_at, NULL),
              next_reminder_start_at = IF(
                $action = $resume_action, $next_reminder_start_at, NULL
              ),
              current_occurrence_id = IF(
                $action = $pause_action,
                current_occurrence_id,
                IF($restore_current, current_occurrence_id, NULL)
              ),
              schedule_version = $schedule_version,
              updated_at = $now
            WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + $revision_increment,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              notification_state = IF(
                $action = $resume_action AND $restore_current,
                $waiting_notification_state,
                IF(
                  status IN ('scheduled', 'pending', 'overdue'),
                  $stopped_notification_state,
                  notification_state
                )
              ),
              next_notification_at = IF(
                $action = $resume_action AND $restore_current, $now, NULL
              ),
              status = IF(
                status IN ('scheduled', 'pending', 'overdue')
                  AND (
                    $action = $archive_action
                    OR ($action = $resume_action AND NOT $restore_current)
                  ),
                $cancelled_status, status
              ),
              cancelled_by = IF(
                status IN ('scheduled', 'pending', 'overdue')
                  AND (
                    $action = $archive_action
                    OR ($action = $resume_action AND NOT $restore_current)
                  ),
                $actor_user_id, cancelled_by
              ),
              cancellation_reason = IF(
                status IN ('scheduled', 'pending', 'overdue') AND $action = $archive_action,
                $reminder_archived_reason,
                IF(
                  status IN ('scheduled', 'pending', 'overdue')
                    AND $action = $resume_action AND NOT $restore_current,
                  $missed_while_paused_reason, cancellation_reason
                )
              ),
              cancelled_at = IF(
                status IN ('scheduled', 'pending', 'overdue')
                  AND (
                    $action = $archive_action
                    OR ($action = $resume_action AND NOT $restore_current)
                  ),
                $now, cancelled_at
              ),
              completion_finalized_at = IF(
                $action = $archive_action AND status = $completed_status,
                $now,
                completion_finalized_at
              ),
              undo_until = IF(
                $action = $archive_action AND status = $completed_status,
                $now,
                undo_until
              ),
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id = $reminder_id
              AND occurrence_id = $current_occurrence_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $reminder_id, $now, $event_id, 'reminder',
              $event_type, $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $reminder_id: TypedValues.utf8(reminderId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $next_status: TypedValues.utf8(nextStatus),
            $action: TypedValues.utf8(action),
            $current_occurrence_id: optionalUtf8(currentOccurrence?.occurrenceId),
            $restore_current: TypedValues.bool(restoreCurrent),
            $next_due_at: optionalTimestamp(nextDueAt),
            $next_reminder_start_at: optionalTimestamp(nextReminderStartAt),
            $schedule_version: TypedValues.uint64(Number(getField(reminderRow, "version"))),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $event_type: TypedValues.utf8(
              action === "pause" ? "reminder.paused" :
                action === "resume" ? "reminder.resumed" : "reminder.archived",
            ),
            $payload: TypedValues.jsonDocument(JSON.stringify({ from: currentStatus, to: nextStatus })),
            $resume_action: TypedValues.utf8("resume"),
            $pause_action: TypedValues.utf8("pause"),
            $archive_action: TypedValues.utf8("archive"),
            $paused_runtime_state: TypedValues.utf8("paused"),
            $blocked_runtime_state: TypedValues.utf8("blocked"),
            $ready_runtime_state: TypedValues.utf8("ready"),
            $waiting_notification_state: TypedValues.utf8("waiting"),
            $stopped_notification_state: TypedValues.utf8("stopped"),
            $cancelled_status: TypedValues.utf8("cancelled"),
            $completed_status: TypedValues.utf8("completed"),
            $reminder_archived_reason: TypedValues.utf8("reminder_archived"),
            $missed_while_paused_reason: TypedValues.utf8("missed_while_paused"),
            $revision_increment: TypedValues.uint64(1),
          },
        );
      }),
    );
    return this.getById(workspaceId, reminderId);
  }
}
