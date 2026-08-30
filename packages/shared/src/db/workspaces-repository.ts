import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  DEFAULT_QUIET_HOURS_END,
  DEFAULT_QUIET_HOURS_START,
  ianaTimezoneSchema,
  localTimeSchema,
  workspaceStatusSchema,
  type Workspace,
  type WorkspaceAccess,
} from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

const createWorkspaceSchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    telegramChatId: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    displayName: z.string().trim().min(1).max(200),
    ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timezone: ianaTimezoneSchema,
    quietHoursStart: localTimeSchema.default(DEFAULT_QUIET_HOURS_START),
    quietHoursEnd: localTimeSchema.default(DEFAULT_QUIET_HOURS_END),
    defaultAllDayReminderTime: localTimeSchema.default(DEFAULT_ALL_DAY_REMINDER_TIME),
  })
  .strict();

export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

export const workspaceSettingsSchema = z
  .object({
    timezone: ianaTimezoneSchema,
    quietHoursStart: localTimeSchema,
    quietHoursEnd: localTimeSchema,
    defaultAllDayReminderTime: localTimeSchema,
  })
  .strict();

export type WorkspaceSettingsInput = z.input<typeof workspaceSettingsSchema>;

export class WorkspaceChatAlreadyRegisteredError extends Error {
  constructor(readonly telegramChatId: number) {
    super(`Telegram chat ${telegramChatId} already belongs to a workspace`);
    this.name = "WorkspaceChatAlreadyRegisteredError";
  }
}

export class WorkspaceSettingsForbiddenError extends Error {
  constructor() {
    super("Only an owner or organizer can change workspace settings");
    this.name = "WorkspaceSettingsForbiddenError";
  }
}

export class WorkspaceOwnershipTransferForbiddenError extends Error {
  constructor() {
    super("Only the active workspace owner can transfer ownership to an active member");
    this.name = "WorkspaceOwnershipTransferForbiddenError";
  }
}

export class WorkspaceOwnershipClaimForbiddenError extends Error {
  constructor() {
    super("Workspace ownership can only be claimed when the current owner is inactive");
    this.name = "WorkspaceOwnershipClaimForbiddenError";
  }
}

function rowToWorkspace(data: Record<string, unknown>): Workspace {
  return {
    workspaceId: String(getField(data, "workspace_id")),
    telegramChatId: Number(getField(data, "telegram_chat_id")),
    displayName: String(getField(data, "display_name")),
    ownerUserId: Number(getField(data, "owner_user_id")),
    timezone: String(getField(data, "timezone")),
    quietHoursStart: String(getField(data, "quiet_hours_start")),
    quietHoursEnd: String(getField(data, "quiet_hours_end")),
    defaultAllDayReminderTime: String(getField(data, "default_all_day_reminder_time")),
    status: workspaceStatusSchema.parse(getField(data, "status")),
    createdAt: parseYdbTimestampRequired(getField(data, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
  };
}

function rowToWorkspaceAccess(data: Record<string, unknown>): WorkspaceAccess {
  return {
    ...rowToWorkspace(data),
    role: z.enum(["owner", "organizer", "member"]).parse(getField(data, "member_role")),
  };
}

export class WorkspacesRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async getById(workspaceId: string): Promise<Workspace | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          SELECT * FROM workspaces
          WHERE workspace_id = $workspace_id
          LIMIT 1;
        `,
        { $workspace_id: TypedValues.utf8(workspaceId) },
      );
      const rows = mapResultRows(resultSets[0]);
      return rows[0] ? rowToWorkspace(rows[0]) : null;
    });
  }

  async getByTelegramChatId(telegramChatId: number): Promise<Workspace | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $telegram_chat_id AS Int64;
          SELECT w.*
          FROM telegram_chat_workspaces AS mapping
          INNER JOIN workspaces AS w
            ON w.workspace_id = mapping.workspace_id
          WHERE mapping.telegram_chat_id = $telegram_chat_id
          LIMIT 1;
        `,
        { $telegram_chat_id: TypedValues.int64(telegramChatId) },
      );
      const rows = mapResultRows(resultSets[0]);
      return rows[0] ? rowToWorkspace(rows[0]) : null;
    });
  }

  async listActive(): Promise<Workspace[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          SELECT * FROM workspaces
          WHERE status = 'active'
          ORDER BY created_at, workspace_id;
        `,
      );
      return mapResultRows(resultSets[0]).map(rowToWorkspace);
    });
  }

  async listForUser(userId: number): Promise<WorkspaceAccess[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $user_id AS Int64;
          SELECT workspace.*, member.role AS member_role
          FROM workspace_members AS member
          INNER JOIN workspaces AS workspace
            ON workspace.workspace_id = member.workspace_id
          WHERE member.user_id = $user_id
            AND member.status = 'active'
            AND workspace.status = 'active'
          ORDER BY display_name, workspace_id;
        `,
        { $user_id: TypedValues.int64(userId) },
      );
      return mapResultRows(resultSets[0]).map(rowToWorkspaceAccess);
    });
  }

  async create(input: CreateWorkspaceInput, now: Date = new Date()): Promise<Workspace> {
    const parsed = createWorkspaceSchema.parse(input);
    const workspace: Workspace = {
      workspaceId: parsed.workspaceId ?? randomUUID(),
      telegramChatId: parsed.telegramChatId,
      displayName: parsed.displayName,
      ownerUserId: parsed.ownerUserId,
      timezone: parsed.timezone,
      quietHoursStart: parsed.quietHoursStart,
      quietHoursEnd: parsed.quietHoursEnd,
      defaultAllDayReminderTime: parsed.defaultAllDayReminderTime,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $telegram_chat_id AS Int64;
            SELECT workspace_id FROM telegram_chat_workspaces
            WHERE telegram_chat_id = $telegram_chat_id
            LIMIT 1;
          `,
          { $telegram_chat_id: TypedValues.int64(workspace.telegramChatId) },
        );
        if (mapResultRows(resultSets[0]).length > 0) {
          throw new WorkspaceChatAlreadyRegisteredError(workspace.telegramChatId);
        }

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $telegram_chat_id AS Int64;
            DECLARE $display_name AS Utf8;
            DECLARE $owner_user_id AS Int64;
            DECLARE $timezone AS Utf8;
            DECLARE $quiet_hours_start AS Utf8;
            DECLARE $quiet_hours_end AS Utf8;
            DECLARE $default_all_day_reminder_time AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $created_at AS Timestamp;
            DECLARE $updated_at AS Timestamp;

            INSERT INTO workspaces (
              workspace_id, telegram_chat_id, display_name, owner_user_id,
              timezone, quiet_hours_start, quiet_hours_end,
              default_all_day_reminder_time, status, created_at, updated_at
            ) VALUES (
              $workspace_id, $telegram_chat_id, $display_name, $owner_user_id,
              $timezone, $quiet_hours_start, $quiet_hours_end,
              $default_all_day_reminder_time, $status, $created_at, $updated_at
            );

            INSERT INTO telegram_chat_workspaces (
              telegram_chat_id, workspace_id, created_at
            ) VALUES ($telegram_chat_id, $workspace_id, $created_at);

            INSERT INTO workspace_members (
              workspace_id, user_id, role, status, role_granted_by,
              role_granted_at, last_observed_at, created_at, updated_at
            ) VALUES (
              $workspace_id, $owner_user_id, 'owner', 'active', $owner_user_id,
              $created_at, $created_at, $created_at, $updated_at
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspace.workspaceId),
            $telegram_chat_id: TypedValues.int64(workspace.telegramChatId),
            $display_name: TypedValues.utf8(workspace.displayName),
            $owner_user_id: TypedValues.int64(workspace.ownerUserId),
            $timezone: TypedValues.utf8(workspace.timezone),
            $quiet_hours_start: TypedValues.utf8(workspace.quietHoursStart),
            $quiet_hours_end: TypedValues.utf8(workspace.quietHoursEnd),
            $default_all_day_reminder_time: TypedValues.utf8(
              workspace.defaultAllDayReminderTime,
            ),
            $status: TypedValues.utf8(workspace.status),
            $created_at: timestampValue(workspace.createdAt),
            $updated_at: timestampValue(workspace.updatedAt),
          },
        );
      }),
    );

    return workspace;
  }

  async updateSettings(
    workspaceId: string,
    input: WorkspaceSettingsInput,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<Workspace> {
    const settings = workspaceSettingsSchema.parse(input);
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            SELECT * FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT role, status FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $actor_user_id: TypedValues.int64(actorUserId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        const actorRow = mapResultRows(resultSets[1])[0];
        if (
          !workspaceRow ||
          getField(workspaceRow, "status") !== "active" ||
          !actorRow ||
          getField(actorRow, "status") !== "active" ||
          !["owner", "organizer"].includes(String(getField(actorRow, "role")))
        ) {
          throw new WorkspaceSettingsForbiddenError();
        }
        const workspace = {
          ...rowToWorkspace(workspaceRow),
          ...settings,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $timezone AS Utf8;
            DECLARE $quiet_hours_start AS Utf8;
            DECLARE $quiet_hours_end AS Utf8;
            DECLARE $default_all_day_reminder_time AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            UPDATE workspaces SET
              timezone = $timezone,
              quiet_hours_start = $quiet_hours_start,
              quiet_hours_end = $quiet_hours_end,
              default_all_day_reminder_time = $default_all_day_reminder_time,
              updated_at = $now
            WHERE workspace_id = $workspace_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $workspace_id, $now, $event_id, 'workspace',
              'workspace.settings_changed', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $timezone: TypedValues.utf8(settings.timezone),
            $quiet_hours_start: TypedValues.utf8(settings.quietHoursStart),
            $quiet_hours_end: TypedValues.utf8(settings.quietHoursEnd),
            $default_all_day_reminder_time: TypedValues.utf8(
              settings.defaultAllDayReminderTime,
            ),
            $actor_user_id: TypedValues.int64(actorUserId),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(JSON.stringify(settings)),
          },
        );
        return workspace;
      }),
    );
  }

  async transferOwnership(
    workspaceId: string,
    targetUserId: number,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<Workspace> {
    return this.changeOwner(workspaceId, targetUserId, actorUserId, false, now);
  }

  async claimVacantOwnership(
    workspaceId: string,
    targetUserId: number,
    now: Date = new Date(),
  ): Promise<Workspace> {
    return this.changeOwner(workspaceId, targetUserId, targetUserId, true, now);
  }

  private async changeOwner(
    workspaceId: string,
    targetUserId: number,
    actorUserId: number,
    requireVacant: boolean,
    now: Date,
  ): Promise<Workspace> {
    if (targetUserId === actorUserId && !requireVacant) {
      throw new WorkspaceOwnershipTransferForbiddenError();
    }
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $target_user_id AS Int64;
            SELECT * FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $target_user_id
            LIMIT 1;

            SELECT owner.status AS status
            FROM workspaces AS workspace
            INNER JOIN workspace_members AS owner
              ON owner.workspace_id = workspace.workspace_id
              AND owner.user_id = workspace.owner_user_id
            WHERE workspace.workspace_id = $workspace_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $target_user_id: TypedValues.int64(targetUserId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        const actorRow = mapResultRows(resultSets[1])[0];
        const targetRow = mapResultRows(resultSets[2])[0];
        const ownerRow = mapResultRows(resultSets[3])[0];
        const oldOwnerUserId = workspaceRow
          ? Number(getField(workspaceRow, "owner_user_id"))
          : null;
        const commonAllowed =
          workspaceRow &&
          getField(workspaceRow, "status") === "active" &&
          targetRow &&
          getField(targetRow, "status") === "active";
        const allowed = requireVacant
          ? commonAllowed && ownerRow && getField(ownerRow, "status") !== "active"
          : commonAllowed &&
            actorRow &&
            getField(actorRow, "status") === "active" &&
            getField(actorRow, "role") === "owner" &&
            oldOwnerUserId === actorUserId;
        if (!allowed || oldOwnerUserId == null) {
          throw requireVacant
            ? new WorkspaceOwnershipClaimForbiddenError()
            : new WorkspaceOwnershipTransferForbiddenError();
        }
        const workspace = {
          ...rowToWorkspace(workspaceRow),
          ownerUserId: targetUserId,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $old_owner_user_id AS Int64;
            DECLARE $target_user_id AS Int64;
            DECLARE $actor_user_id AS Int64;
            DECLARE $old_owner_role AS Utf8;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            UPDATE workspaces SET owner_user_id = $target_user_id, updated_at = $now
            WHERE workspace_id = $workspace_id;

            UPDATE workspace_members SET
              role = $old_owner_role,
              role_granted_by = NULL,
              role_granted_at = NULL,
              updated_at = $now
            WHERE workspace_id = $workspace_id AND user_id = $old_owner_user_id;

            UPDATE workspace_members SET
              role = 'owner',
              role_granted_by = $actor_user_id,
              role_granted_at = $now,
              updated_at = $now
            WHERE workspace_id = $workspace_id AND user_id = $target_user_id;

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $workspace_id, $now, $event_id, 'workspace',
              'workspace.ownership_transferred', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $old_owner_user_id: TypedValues.int64(oldOwnerUserId),
            $target_user_id: TypedValues.int64(targetUserId),
            $actor_user_id: TypedValues.int64(actorUserId),
            $old_owner_role: TypedValues.utf8(requireVacant ? "member" : "organizer"),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $payload: TypedValues.jsonDocument(JSON.stringify({
              fromUserId: oldOwnerUserId,
              toUserId: targetUserId,
              recovered: requireVacant,
            })),
          },
        );
        return workspace;
      }),
    );
  }
}
