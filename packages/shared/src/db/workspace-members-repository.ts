import {
  membershipStatusSchema,
  workspaceRoleSchema,
  type WorkspaceMember,
} from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import {
  getField,
  mapResultRows,
  parseYdbTimestamp,
  parseYdbTimestampRequired,
} from "./ydb-utils.js";

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
}
