import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { decodeYdbValue } from "./ydb-utils.js";
import {
  WorkspaceChatAlreadyRegisteredError,
  WorkspaceOwnershipClaimForbiddenError,
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

const workspaceRow = {
  workspace_id: "workspace-a",
  telegram_chat_id: -100123,
  display_name: "Дом",
  owner_user_id: 10,
  timezone: "Europe/Moscow",
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  default_all_day_reminder_time: "09:00",
  status: "active",
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-13T10:00:00.000Z",
};

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
    expect(query).toContain("ORDER BY display_name, workspace_id");
    expect(query).not.toContain("ORDER BY workspace.display_name");
    expect(decodeYdbValue(parameters?.$user_id)).toBe(20);
  });

  it("lists all active workspaces for the dispatcher", async () => {
    const { repository, session } = repositoryDouble();
    await repository.listActive();

    expect(session.executeQuery.mock.calls[0]?.[0]).toContain(
      "WHERE status = 'active'",
    );
  });

  it("updates workspace settings for an active organizer and audits it", async () => {
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-settings" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM workspaces")
          ? [resultSet([workspaceRow]), resultSet([{ role: "organizer", status: "active" }])]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspacesRepository("", "", runSession);

    const updated = await repository.updateSettings(
      "workspace-a",
      {
        timezone: "Asia/Yekaterinburg",
        quietHoursStart: "23:00",
        quietHoursEnd: "07:30",
        defaultAllDayReminderTime: "10:00",
      },
      20,
      new Date("2026-08-14T10:00:00.000Z"),
    );

    expect(updated).toMatchObject({
      timezone: "Asia/Yekaterinburg",
      quietHoursStart: "23:00",
      quietHoursEnd: "07:30",
      defaultAllDayReminderTime: "10:00",
    });
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("workspace.settings_changed"));
    expect(write?.[0]).toContain("UPDATE workspaces SET");
  });

  it("rejects an ambiguous all-day quiet period before opening a transaction", async () => {
    const { repository, session } = repositoryDouble();

    await expect(repository.updateSettings(
      "workspace-a",
      {
        timezone: "Europe/Moscow",
        quietHoursStart: "08:00",
        quietHoursEnd: "08:00",
        defaultAllDayReminderTime: "09:00",
      },
      10,
    )).rejects.toThrow("Quiet hours start and end must be different");
    expect(session.beginTransaction).not.toHaveBeenCalled();
  });

  it("transfers ownership and changes both member roles atomically", async () => {
    const member = (userId: number, role: string, status = "active") => ({
      workspace_id: "workspace-a",
      user_id: userId,
      role,
      status,
      role_granted_by: 10,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    });
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-owner" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM workspaces")
          ? [
              resultSet([workspaceRow]),
              resultSet([member(10, "owner")]),
              resultSet([member(20, "member")]),
              resultSet([{ status: "active" }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspacesRepository("", "", runSession);

    const updated = await repository.transferOwnership(
      "workspace-a",
      20,
      10,
      new Date("2026-08-14T10:00:00.000Z"),
    );

    expect(updated.ownerUserId).toBe(20);
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("workspace.ownership_transferred"));
    expect(write?.[0]).toContain("UPDATE workspaces SET owner_user_id");
    expect(write?.[0]).toContain("role = 'owner'");
    expect(decodeYdbValue(write?.[1]?.$old_owner_role)).toBe("organizer");
  });

  it("recovers ownership only while the previous owner is inactive", async () => {
    const member = (userId: number, role: string, status: string) => ({
      workspace_id: "workspace-a",
      user_id: userId,
      role,
      status,
      role_granted_by: 10,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    });
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-owner-recovery" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM workspaces")
          ? [
              resultSet([workspaceRow]),
              resultSet([member(20, "member", "active")]),
              resultSet([member(20, "member", "active")]),
              resultSet([{ status: "removed" }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspacesRepository("", "", runSession);

    const updated = await repository.claimVacantOwnership(
      "workspace-a",
      20,
      new Date("2026-08-14T10:00:00.000Z"),
    );

    expect(updated.ownerUserId).toBe(20);
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("workspace.ownership_transferred"));
    expect(decodeYdbValue(write?.[1]?.$old_owner_role)).toBe("member");
    expect(decodeYdbValue(write?.[1]?.$target_user_id)).toBe(20);
  });

  it("refuses ownership recovery while the previous owner is active", async () => {
    const member = (userId: number, role: string) => ({
      workspace_id: "workspace-a",
      user_id: userId,
      role,
      status: "active",
      role_granted_by: 10,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    });
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-owner-recovery-denied" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM workspaces")
          ? [
              resultSet([workspaceRow]),
              resultSet([member(20, "member")]),
              resultSet([member(20, "member")]),
              resultSet([{ status: "active" }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspacesRepository("", "", runSession);

    await expect(repository.claimVacantOwnership("workspace-a", 20))
      .rejects.toBeInstanceOf(WorkspaceOwnershipClaimForbiddenError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.rollbackTransaction).toHaveBeenCalled();
  });
});
