import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { DeliveryInProgressError } from "./delivery-guard.js";
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

  it("sorts projected member profiles using output column names accepted by YDB", async () => {
    const session = {
      executeQuery: vi.fn().mockResolvedValue({
        resultSets: [
          resultSet({
            workspace_id: "workspace-a",
            user_id: 20,
            role: "member",
            status: "active",
            role_granted_by: null,
            role_granted_at: null,
            last_observed_at: "2026-08-13T12:00:00.000Z",
            created_at: "2026-08-01T10:00:00.000Z",
            updated_at: "2026-08-13T12:00:00.000Z",
            username: "member",
            display_name: "Member",
            private_chat_available: 1,
          }),
        ],
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    await repository.listProfiles("workspace-a");

    const query = session.executeQuery.mock.calls[0]?.[0] ?? "";
    expect(query).toContain("ORDER BY role, display_name, user_id");
    expect(query).not.toContain("ORDER BY member.role");
  });

  it("reactivates an observed removed member without restoring elevated rights", async () => {
    const removedRow = {
      workspace_id: "workspace-a",
      user_id: 20,
      role: "organizer",
      status: "removed",
      role_granted_by: 10,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-01T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-member" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT status, owner_user_id FROM workspaces")
          ? [resultSet({ status: "active", owner_user_id: 10 }), resultSet(removedRow)]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    const observed = await repository.observe(
      "workspace-a",
      20,
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(observed).toMatchObject({ role: "member", status: "active" });
    expect(observed?.roleGrantedBy).toBeNull();
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPSERT INTO workspace_members"),
    );
    expect(decodeYdbValue(writeCall?.[1]?.$role)).toBe("member");
  });

  it("restores the workspace owner's role when they rejoin", async () => {
    const removedOwnerRow = {
      workspace_id: "workspace-a",
      user_id: 10,
      role: "owner",
      status: "removed",
      role_granted_by: null,
      role_granted_at: null,
      last_observed_at: "2026-08-01T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-owner" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT status, owner_user_id FROM workspaces")
          ? [resultSet({ status: "active", owner_user_id: 10 }), resultSet(removedOwnerRow)]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    const observed = await repository.observe(
      "workspace-a",
      10,
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(observed).toMatchObject({ role: "owner", status: "active", roleGrantedBy: 10 });
  });

  it("lets the owner grant organizer access and audits the change", async () => {
    const memberRow = (userId: number, role: string) => ({
      workspace_id: "workspace-a",
      user_id: userId,
      role,
      status: "active",
      role_granted_by: userId === 10 ? 10 : null,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    });
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-role" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT owner_user_id")
          ? [
              resultSet({ owner_user_id: 10, status: "active" }),
              resultSet(memberRow(10, "owner")),
              resultSet(memberRow(20, "member")),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    const updated = await repository.setRole(
      "workspace-a",
      20,
      "organizer",
      10,
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(updated).toMatchObject({ userId: 20, role: "organizer", roleGrantedBy: 10 });
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("workspace_member.role_changed"),
    );
    expect(writeCall?.[0]).toContain("UPDATE workspace_members");
    expect(decodeYdbValue(writeCall?.[1]?.$target_user_id)).toBe(20);
    expect(decodeYdbValue(writeCall?.[1]?.$role)).toBe("organizer");
  });

  it("removes a member and pauses reminders assigned to them", async () => {
    const memberRow = {
      workspace_id: "workspace-a",
      user_id: 20,
      role: "organizer",
      status: "active",
      role_granted_by: 10,
      role_granted_at: "2026-08-01T10:00:00.000Z",
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-remove" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT owner_user_id")
          ? [
              resultSet({ owner_user_id: 10, status: "active" }),
              resultSet(memberRow),
              resultSet({ reminder_id: "reminder-a" }),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    const result = await repository.remove(
      "workspace-a",
      20,
      new Date("2026-08-14T00:00:00.000Z"),
    );

    expect(result.member).toMatchObject({ status: "removed", role: "member" });
    expect(result.pausedReminderIds).toEqual(["reminder-a"]);
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPDATE workspace_members SET"));
    expect(write?.[0]).toContain("UPDATE reminders SET status = 'paused'");
    expect(write?.[0]).toContain("reminder_id IN $paused_reminder_ids");
    expect(write?.[0]).toContain("UPDATE reminder_occurrences SET");
    expect(write?.[0]).toContain("'workspace_member.removed'");
  });

  it("does not remove a private recipient while their Telegram send is fenced", async () => {
    const memberRow = {
      workspace_id: "workspace-a",
      user_id: 20,
      role: "member",
      status: "active",
      role_granted_by: null,
      role_granted_at: null,
      last_observed_at: "2026-08-13T10:00:00.000Z",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const lockedOccurrence = {
      occurrence_id: "occurrence-a",
      delivery_lock_key: "delivery-a",
      delivery_locked_at: "2026-08-14T00:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-remove-locked" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT owner_user_id")
          ? [
              resultSet({ owner_user_id: 10, status: "active" }),
              resultSet(memberRow),
              resultSet({ reminder_id: "reminder-a" }),
              resultSet(lockedOccurrence),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new WorkspaceMembersRepository("", "", runSession);

    await expect(repository.remove(
      "workspace-a",
      20,
      new Date("2026-08-14T00:00:30.000Z"),
    )).rejects.toBeInstanceOf(DeliveryInProgressError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });
});
