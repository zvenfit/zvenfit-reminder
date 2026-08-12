import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { WorkspaceMembersRepository } from "./workspace-members-repository.js";
import { decodeYdbValue } from "./ydb-utils.js";

function resultSet(row: Record<string, string | number | null>) {
  const names = Object.keys(row);
  return {
    columns: names.map((name) => ({ name })),
    rows: [
      {
        items: names.map((name) => {
          const value = row[name];
          if (value == null) return { nullFlagValue: "NULL_VALUE" };
          return typeof value === "number"
            ? { int64Value: value }
            : { textValue: value };
        }),
      },
    ],
  };
}

describe("WorkspaceMembersRepository", () => {
  it("loads one member by the workspace-scoped primary key", async () => {
    const session = {
      executeQuery: vi.fn().mockResolvedValue({
        resultSets: [
          resultSet({
            workspace_id: "workspace-a",
            user_id: 20,
            role: "member",
            status: "active",
            role_granted_by: 10,
            role_granted_at: "2026-08-01T10:00:00.000Z",
            last_observed_at: "2026-08-13T12:00:00.000Z",
            created_at: "2026-08-01T10:00:00.000Z",
            updated_at: "2026-08-13T12:00:00.000Z",
          }),
        ],
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    const member = await repository.getByUserId("workspace-a", 20);

    expect(member).toMatchObject({
      workspaceId: "workspace-a",
      userId: 20,
      role: "member",
      status: "active",
    });
    expect(session.executeQuery.mock.calls[0]?.[0]).toContain(
      "WHERE workspace_id = $workspace_id AND user_id = $user_id",
    );
    expect(decodeYdbValue(session.executeQuery.mock.calls[0]?.[1]?.$workspace_id)).toBe(
      "workspace-a",
    );
  });
});
