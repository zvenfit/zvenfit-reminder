import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { decodeYdbValue } from "./ydb-utils.js";
import {
  WorkspaceChatAlreadyRegisteredError,
  WorkspacesRepository,
} from "./workspaces-repository.js";

function resultSet(rows: Array<Record<string, string | number | boolean | null>>) {
  const names = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns: names.map((name) => ({ name })),
    rows: rows.map((row) => ({
      items: names.map((name) => {
        const value = row[name];
        if (value == null) return { nullFlagValue: "NULL_VALUE" };
        if (typeof value === "string") return { textValue: value };
        if (typeof value === "boolean") return { boolValue: value };
        return { int64Value: value };
      }),
    })),
  };
}

function repositoryDouble(mappingRows: Array<Record<string, string>> = []) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-workspace" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => ({
      resultSets: query.includes("SELECT workspace_id FROM telegram_chat_workspaces")
        ? [resultSet(mappingRows)]
        : [],
    })),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new WorkspacesRepository("", "", runSession), session };
}

describe("WorkspacesRepository", () => {
  it("creates the workspace, chat mapping, and owner membership atomically", async () => {
    const { repository, session } = repositoryDouble();
    const now = new Date("2026-08-13T10:00:00.000Z");

    const workspace = await repository.create(
      {
        workspaceId: "98d365e8-79cb-45c9-940a-ce3fe08aef5a",
        telegramChatId: -100123,
        displayName: "Дом",
        ownerUserId: 10,
        timezone: "Europe/Moscow",
      },
      now,
    );

    expect(workspace.quietHoursStart).toBe("22:00");
    expect(workspace.quietHoursEnd).toBe("08:00");
    expect(session.commitTransaction).toHaveBeenCalledWith({ txId: "tx-workspace" });
    expect(session.rollbackTransaction).not.toHaveBeenCalled();

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO workspaces"),
    );
    expect(writeCall?.[0]).toContain("INSERT INTO telegram_chat_workspaces");
    expect(writeCall?.[0]).toContain("INSERT INTO workspace_members");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe(workspace.workspaceId);
  });

  it("rejects a chat mapping collision and rolls back", async () => {
    const { repository, session } = repositoryDouble([{ workspace_id: "existing" }]);

    await expect(
      repository.create({
        telegramChatId: -100123,
        displayName: "Дом",
        ownerUserId: 10,
        timezone: "Europe/Moscow",
      }),
    ).rejects.toBeInstanceOf(WorkspaceChatAlreadyRegisteredError);

    expect(session.executeQuery).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "tx-workspace" });
  });

  it("always scopes primary-key reads by workspace", async () => {
    const { repository, session } = repositoryDouble();
    await repository.getById("workspace-a");

    expect(session.executeQuery.mock.calls[0]?.[0]).toContain(
      "WHERE workspace_id = $workspace_id",
    );
    expect(decodeYdbValue(session.executeQuery.mock.calls[0]?.[1]?.$workspace_id)).toBe(
      "workspace-a",
    );
  });

  it("lists workspaces through active membership of one user", async () => {
    const { repository, session } = repositoryDouble();
    await repository.listForUser(20);

    const [query, parameters] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("member.user_id = $user_id");
    expect(query).toContain("member.status = 'active'");
    expect(query).toContain("workspace.status = 'active'");
    expect(decodeYdbValue(parameters?.$user_id)).toBe(20);
  });

  it("lists all active workspaces for the dispatcher", async () => {
    const { repository, session } = repositoryDouble();
    await repository.listActive();

    expect(session.executeQuery.mock.calls[0]?.[0]).toContain(
      "WHERE status = 'active'",
    );
  });
});
