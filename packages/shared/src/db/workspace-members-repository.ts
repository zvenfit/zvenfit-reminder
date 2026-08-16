import { randomUUID } from "node:crypto";
import {
  membershipStatusSchema,
  workspaceRoleSchema,
  type WorkspaceMember,
  type WorkspaceMemberProfile,
} from "../reminder-domain.js";
import { createSessionRunner, TypedValues, Types, type SessionRunner } from "./client.js";
import { prepareOccurrenceMutation } from "./delivery-guard.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalTimestamp,
  optionalUtf8,
  parseYdbTimestamp,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

export class WorkspaceRoleChangeForbiddenError extends Error {
  constructor() {
    super("Only the workspace owner can change member roles");
    this.name = "WorkspaceRoleChangeForbiddenError";
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  constructor(readonly userId: number) {
    super(`Workspace member ${userId} was not found`);
    this.name = "WorkspaceMemberNotFoundError";
  }
}

export class WorkspaceMemberDisplayNameChangeForbiddenError extends Error {
  constructor() {
    super("This member display name cannot be changed by the current actor");
    this.name = "WorkspaceMemberDisplayNameChangeForbiddenError";
  }
}

export interface RemovedWorkspaceMemberResult {
  member: WorkspaceMember | null;
  pausedReminderIds: string[];
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function rowToWorkspaceMember(row: Record<string, unknown>): WorkspaceMember {
  return {
    workspaceId: String(getField(row, "workspace_id")),
    userId: Number(getField(row, "user_id")),
    role: workspaceRoleSchema.parse(getField(row, "role")),
    status: membershipStatusSchema.parse(getField(row, "status")),
    roleGrantedBy: nullableNumber(getField(row, "role_granted_by")),
    roleGrantedAt: parseYdbTimestamp(getField(row, "role_granted_at")),
    lastObservedAt: parseYdbTimestampRequired(
      getField(row, "last_observed_at"),
      "last_observed_at",
    ),
    createdAt: parseYdbTimestampRequired(getField(row, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(row, "updated_at"), "updated_at"),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function rowToWorkspaceMemberProfile(row: Record<string, unknown>): WorkspaceMemberProfile {
  return {
    ...rowToWorkspaceMember(row),
    username: nullableString(getField(row, "username")),
    displayName: String(getField(row, "display_name")),
    telegramDisplayName: String(getField(row, "telegram_display_name")),
    displayNameOverride: nullableString(getField(row, "display_name_override")),
    privateChatAvailable: Boolean(getField(row, "private_chat_available")),
  };
}

export class WorkspaceMembersRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async getByUserId(workspaceId: string, userId: number): Promise<WorkspaceMember | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $user_id AS Int64;
          SELECT * FROM workspace_members
          WHERE workspace_id = $workspace_id AND user_id = $user_id
          LIMIT 1;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $user_id: TypedValues.int64(userId),
        },
      );
      const row = mapResultRows(resultSets[0])[0];
      return row ? rowToWorkspaceMember(row) : null;
    });
  }

  async listProfiles(workspaceId: string): Promise<WorkspaceMemberProfile[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          SELECT member.*, user.username AS username,
            COALESCE(member.display_name_override, user.display_name) AS display_name,
            user.display_name AS telegram_display_name,
            user.private_chat_available AS private_chat_available
          FROM workspace_members AS member
          INNER JOIN users AS user ON member.user_id = user.user_id
          WHERE member.workspace_id = $workspace_id AND member.status = 'active'
          ORDER BY role, display_name, user_id;
        `,
        { $workspace_id: TypedValues.utf8(workspaceId) },
      );
      return mapResultRows(resultSets[0]).map(rowToWorkspaceMemberProfile);
    });
  }

  async setDisplayNameOverride(
    workspaceId: string,
    targetUserId: number,
    displayNameOverride: string | null,
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<WorkspaceMemberProfile> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $target_user_id AS Int64;
            SELECT status FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT member.*, user.username AS username,
              COALESCE(member.display_name_override, user.display_name) AS display_name,
              user.display_name AS telegram_display_name,
              user.private_chat_available AS private_chat_available
            FROM workspace_members AS member
            INNER JOIN users AS user ON user.user_id = member.user_id
            WHERE member.workspace_id = $workspace_id
              AND member.user_id = $target_user_id
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
        if (!targetRow) {
          throw new WorkspaceMemberNotFoundError(targetUserId);
        }
        const actor = actorRow ? rowToWorkspaceMember(actorRow) : null;
        const target = rowToWorkspaceMemberProfile(targetRow);
        const actorCanRenameTarget = actor?.userId === targetUserId ||
          actor?.role === "owner" ||
          (actor?.role === "organizer" && target.role !== "owner");
        if (
          !workspaceRow ||
          getField(workspaceRow, "status") !== "active" ||
          !actor ||
          actor.status !== "active" ||
          target.status !== "active" ||
          !actorCanRenameTarget
        ) {
          throw new WorkspaceMemberDisplayNameChangeForbiddenError();
        }

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $target_user_id AS Int64;
            DECLARE $display_name_override AS Utf8?;
            DECLARE $actor_user_id AS Int64;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $entity_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            UPDATE workspace_members SET
              display_name_override = $display_name_override,
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND user_id = $target_user_id
              AND status = 'active';

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $entity_id, $now, $event_id, 'workspace_member',
              'workspace_member.display_name_changed', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $target_user_id: TypedValues.int64(targetUserId),
            $display_name_override: optionalUtf8(displayNameOverride),
            $actor_user_id: TypedValues.int64(actorUserId),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $entity_id: TypedValues.utf8(`member:${targetUserId}`),
            $payload: TypedValues.jsonDocument(JSON.stringify({
              action: displayNameOverride === null ? "reset" : "set",
            })),
          },
        );

        return {
          ...target,
          displayNameOverride,
          displayName: displayNameOverride ?? target.telegramDisplayName,
          updatedAt: now,
        };
      }),
    );
  }

  async observe(
    workspaceId: string,
    userId: number,
    now: Date = new Date(),
  ): Promise<WorkspaceMember | null> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $user_id AS Int64;
            SELECT status, owner_user_id FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $user_id
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $user_id: TypedValues.int64(userId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        if (!workspaceRow || getField(workspaceRow, "status") !== "active") {
          return null;
        }
        const existingRow = mapResultRows(resultSets[1])[0];
        const existing = existingRow ? rowToWorkspaceMember(existingRow) : null;
        const reactivated = existing?.status === "removed";
        const isWorkspaceOwner = Number(getField(workspaceRow, "owner_user_id")) === userId;
        const member: WorkspaceMember = {
          workspaceId,
          userId,
          role: isWorkspaceOwner ? "owner" : reactivated ? "member" : (existing?.role ?? "member"),
          status: "active",
          roleGrantedBy: isWorkspaceOwner
            ? userId
            : reactivated ? null : (existing?.roleGrantedBy ?? null),
          roleGrantedAt: isWorkspaceOwner
            ? (existing?.roleGrantedAt ?? now)
            : reactivated ? null : (existing?.roleGrantedAt ?? null),
          lastObservedAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $user_id AS Int64;
            DECLARE $role AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $role_granted_by AS Int64?;
            DECLARE $role_granted_at AS Timestamp?;
            DECLARE $last_observed_at AS Timestamp;
            DECLARE $created_at AS Timestamp;
            DECLARE $updated_at AS Timestamp;
            UPSERT INTO workspace_members (
              workspace_id, user_id, role, status, role_granted_by,
              role_granted_at, last_observed_at, created_at, updated_at
            ) VALUES (
              $workspace_id, $user_id, $role, $status, $role_granted_by,
              $role_granted_at, $last_observed_at, $created_at, $updated_at
            );
          `,
          {
            $workspace_id: TypedValues.utf8(member.workspaceId),
            $user_id: TypedValues.int64(member.userId),
            $role: TypedValues.utf8(member.role),
            $status: TypedValues.utf8(member.status),
            $role_granted_by: optionalInt64(member.roleGrantedBy),
            $role_granted_at: optionalTimestamp(member.roleGrantedAt),
            $last_observed_at: timestampValue(member.lastObservedAt),
            $created_at: timestampValue(member.createdAt),
            $updated_at: timestampValue(member.updatedAt),
          },
        );
        return member;
      }),
    );
  }

  async setRole(
    workspaceId: string,
    targetUserId: number,
    role: "organizer" | "member",
    actorUserId: number,
    now: Date = new Date(),
  ): Promise<WorkspaceMember> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $target_user_id AS Int64;
            SELECT owner_user_id, status FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $actor_user_id
            LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $target_user_id
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
        if (!targetRow) {
          throw new WorkspaceMemberNotFoundError(targetUserId);
        }
        const actor = actorRow ? rowToWorkspaceMember(actorRow) : null;
        const target = rowToWorkspaceMember(targetRow);
        if (
          !workspaceRow ||
          getField(workspaceRow, "status") !== "active" ||
          !actor ||
          actor.status !== "active" ||
          actor.role !== "owner" ||
          Number(getField(workspaceRow, "owner_user_id")) !== actorUserId ||
          target.status !== "active" ||
          targetUserId === actorUserId
        ) {
          throw new WorkspaceRoleChangeForbiddenError();
        }
        const updated: WorkspaceMember = {
          ...target,
          role,
          roleGrantedBy: actorUserId,
          roleGrantedAt: now,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $target_user_id AS Int64;
            DECLARE $role AS Utf8;
            DECLARE $actor_user_id AS Int64;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $entity_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            UPDATE workspace_members SET
              role = $role,
              role_granted_by = $actor_user_id,
              role_granted_at = $now,
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND user_id = $target_user_id
              AND status = 'active';

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $entity_id, $now, $event_id, 'workspace_member',
              'workspace_member.role_changed', $actor_user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $target_user_id: TypedValues.int64(targetUserId),
            $role: TypedValues.utf8(role),
            $actor_user_id: TypedValues.int64(actorUserId),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $entity_id: TypedValues.utf8(`member:${targetUserId}`),
            $payload: TypedValues.jsonDocument(
              JSON.stringify({ from: target.role, to: role }),
            ),
          },
        );
        return updated;
      }),
    );
  }

  async remove(
    workspaceId: string,
    userId: number,
    now: Date = new Date(),
  ): Promise<RemovedWorkspaceMemberResult> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $user_id AS Int64;
            SELECT owner_user_id, status FROM workspaces
            WHERE workspace_id = $workspace_id LIMIT 1;

            SELECT * FROM workspace_members
            WHERE workspace_id = $workspace_id AND user_id = $user_id
            LIMIT 1;

            SELECT reminder_id FROM reminders
            WHERE workspace_id = $workspace_id
              AND status = 'active'
              AND (
                responsible_user_id = $user_id
                OR reminder_id IN (
                  SELECT reminder_id FROM reminder_occurrences
                  WHERE workspace_id = $workspace_id
                    AND responsible_user_id = $user_id
                    AND notification_state = 'waiting'
                    AND status IN ('scheduled', 'pending', 'overdue')
                )
              )
            ORDER BY reminder_id;

            SELECT occurrence.* FROM reminder_occurrences AS occurrence
            WHERE occurrence.workspace_id = $workspace_id
              AND occurrence.responsible_user_id = $user_id
              AND occurrence.status IN ('scheduled', 'pending', 'overdue')
              AND occurrence.delivery_lock_key IS NOT NULL;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $user_id: TypedValues.int64(userId),
          },
        );
        const workspaceRow = mapResultRows(resultSets[0])[0];
        const memberRow = mapResultRows(resultSets[1])[0];
        if (!workspaceRow || getField(workspaceRow, "status") !== "active" || !memberRow) {
          return { member: null, pausedReminderIds: [] };
        }
        const existing = rowToWorkspaceMember(memberRow);
        if (existing.status === "removed") {
          return { member: existing, pausedReminderIds: [] };
        }
        const pausedReminderIds = mapResultRows(resultSets[2]).map((row) =>
          String(getField(row, "reminder_id")));
        for (const occurrenceRow of mapResultRows(resultSets[3])) {
          await prepareOccurrenceMutation(
            transaction,
            workspaceId,
            occurrenceRow,
            String(getField(occurrenceRow, "occurrence_id")),
            now,
          );
        }
        const removed: WorkspaceMember = {
          ...existing,
          role: existing.role === "owner" ? "owner" : "member",
          status: "removed",
          roleGrantedBy: null,
          roleGrantedAt: null,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $user_id AS Int64;
            DECLARE $role AS Utf8;
            DECLARE $now AS Timestamp;
            DECLARE $event_id AS Utf8;
            DECLARE $entity_id AS Utf8;
            DECLARE $payload AS JsonDocument;
            DECLARE $paused_reminder_ids AS List<Utf8>;
            UPDATE workspace_members SET
              role = $role, status = 'removed', role_granted_by = NULL,
              role_granted_at = NULL, updated_at = $now
            WHERE workspace_id = $workspace_id AND user_id = $user_id;

            UPDATE reminders SET status = 'paused', updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id IN $paused_reminder_ids
              AND status = 'active';

            UPDATE reminder_runtime SET state = 'paused', updated_at = $now
            WHERE workspace_id = $workspace_id
              AND reminder_id IN $paused_reminder_ids;

            UPDATE reminder_occurrences SET
              state_revision = state_revision + 1,
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              notification_state = 'stopped', next_notification_at = NULL,
              message_sync_required = IF(latest_message_id IS NOT NULL, true, message_sync_required),
              updated_at = $now
            WHERE workspace_id = $workspace_id
              AND responsible_user_id = $user_id
              AND notification_state = 'waiting'
              AND status IN ('scheduled', 'pending', 'overdue');

            INSERT INTO audit_events (
              workspace_id, entity_id, occurred_at, event_id, entity_type,
              event_type, actor_user_id, payload
            ) VALUES (
              $workspace_id, $entity_id, $now, $event_id, 'workspace_member',
              'workspace_member.removed', $user_id, $payload
            );
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $user_id: TypedValues.int64(userId),
            $role: TypedValues.utf8(removed.role),
            $now: timestampValue(now),
            $event_id: TypedValues.utf8(randomUUID()),
            $entity_id: TypedValues.utf8(`member:${userId}`),
            $payload: TypedValues.jsonDocument(JSON.stringify({ pausedReminderIds })),
            $paused_reminder_ids: TypedValues.list(Types.UTF8, pausedReminderIds),
          },
        );
        return { member: removed, pausedReminderIds };
      }),
    );
  }
}
