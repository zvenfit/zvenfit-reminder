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

export class WorkspaceChatAlreadyRegisteredError extends Error {
  constructor(readonly telegramChatId: number) {
    super(`Telegram chat ${telegramChatId} already belongs to a workspace`);
    this.name = "WorkspaceChatAlreadyRegisteredError";
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
}
