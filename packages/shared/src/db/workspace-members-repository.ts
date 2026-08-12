import { randomUUID } from "node:crypto";
import {
  membershipStatusSchema,
  workspaceRoleSchema,
  type WorkspaceMember,
  type WorkspaceMemberProfile,
} from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalTimestamp,
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
            user.display_name AS display_name,
            user.private_chat_available AS private_chat_available
          FROM workspace_members AS member
          INNER JOIN users AS user ON member.user_id = user.user_id
          WHERE member.workspace_id = $workspace_id AND member.status = 'active'
          ORDER BY member.role, user.display_name, member.user_id;
        `,
        { $workspace_id: TypedValues.utf8(workspaceId) },
      );
      return mapResultRows(resultSets[0]).map((row) => ({
        ...rowToWorkspaceMember(row),
        username: nullableString(getField(row, "username")),
        displayName: String(getField(row, "display_name")),
        privateChatAvailable: Boolean(getField(row, "private_chat_available")),
      }));
    });
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
            SELECT status FROM workspaces
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
        const member: WorkspaceMember = {
          workspaceId,
          userId,
          role: reactivated ? "member" : (existing?.role ?? "member"),
          status: "active",
          roleGrantedBy: reactivated ? null : (existing?.roleGrantedBy ?? null),
          roleGrantedAt: reactivated ? null : (existing?.roleGrantedAt ?? null),
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
}
