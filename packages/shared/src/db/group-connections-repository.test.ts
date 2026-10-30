import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import { decodeYdbValue } from "./ydb-utils.js";
import { GroupConnectionError, GroupConnectionsRepository, groupConnectionId, type GroupConnection } from "./group-connections-repository.js";

const now = new Date("2026-10-30T10:00:00.000Z");
const input = { clientRequestId: "11111111-1111-4111-8111-111111111111", launchMode: "native" as const };
const workspaceId = "22222222-2222-4222-8222-222222222222";
function resultSet(rows: Record<string, unknown>[]) {
  const names = Object.keys(rows[0] ?? {});
  return { columns: names.map(name => ({ name })), rows: rows.map(row => ({ items: names.map(name => {
    const value = row[name];
    if (value == null) return { nullFlagValue: "NULL_VALUE" };
    if (typeof value === "string") return { textValue: value };
    if (typeof value === "boolean") return { boolValue: value };
    return { int64Value: value };
  }) })) };
}
function database() {
  const connections = new Map<string, GroupConnection>();
  const counters = new Map<number, number>();
  const requests = new Map<string, string>();
  let workspace: Record<string, unknown> | null = null;
  let member: Record<string, unknown> | null = null;
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-group" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined), rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      const p = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, decodeYdbValue(value)]));
      let rows: Record<string, unknown>[][] = [];
      if (query.includes("SELECT payload FROM group_connections")) {
        const connection = connections.get(String(p.$connection_id)); rows = [connection ? [{ payload: JSON.stringify(connection) }] : []];
      } else if (query.includes("SELECT next_request_id")) {
        const next = counters.get(Number(p.$actor_id)); rows = [next ? [{ next_request_id: next }] : []];
      } else if (query.includes("SELECT connection_id FROM group_connection_requests")) {
        const id = requests.get(`${p.$actor_id}:${p.$request_id}`); rows = [id ? [{ connection_id: id }] : []];
      } else if (query.includes("UPSERT INTO group_connection_counters")) {
        counters.set(Number(p.$actor_id), Number(p.$next_request_id)); requests.set(`${p.$actor_id}:${p.$request_id}`, String(p.$connection_id));
      } else if (query.includes("UPSERT INTO group_connections")) {
        connections.set(String(p.$connection_id), JSON.parse(String(p.$payload)));
      } else if (query.includes("SELECT w.workspace_id AS")) {
        rows = [workspace ? [workspace] : [], member ? [member] : []];
      } else if (query.includes("SELECT status, owner_user_id FROM workspaces")) {
        rows = [workspace ? [workspace] : [], member ? [member] : []];
      } else if (query.includes("SELECT workspace_id FROM telegram_chat_workspaces")) {
        rows = [workspace ? [workspace] : []];
      }
      return { resultSets: rows.map(resultSet) };
    }),
  };
  return {
    repository: new GroupConnectionsRepository("", "", async operation => operation(session as unknown as TableSession)),
    session, connections, counters, requests,
    existing(owner = 99, status = "active", role = "organizer") {
      workspace = { workspace_id: workspaceId, status: "active", owner_user_id: owner, updated_at: now.toISOString() };
      member = { workspace_id: workspaceId, user_id: 10, status, role, role_granted_by: 99,
        role_granted_at: now.toISOString(), last_observed_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString() };
    },
    changeMembership() { if (member) { member.status = "removed"; member.updated_at = "2026-10-30T10:00:01.000Z"; } },
    close() { if (workspace) workspace.status = "closed"; },
  };
}

describe("GroupConnectionsRepository", () => {
  it("binds idempotency to the actor and immutable mode, and never reuses Telegram request ids", async () => {
    const db = database();
    const first = await db.repository.create(10, input, now);
    expect(await db.repository.create(10, input, now)).toEqual(first);
    await expect(db.repository.create(10, { ...input, launchMode: "private_chat" }, now)).rejects.toMatchObject({ code: "idempotency_conflict" });
    const next = await db.repository.create(10, { ...input, clientRequestId: "33333333-3333-4333-8333-333333333333" }, now);
    expect(next.requestId).toBe(first.requestId + 1);
    expect((await db.repository.create(11, input, now)).connectionId).not.toBe(first.connectionId);
    expect(db.counters.get(10)).toBe(3);
    expect(await db.repository.getByRequest(11, next.requestId)).toBeNull();
  });
  it("does not expose another actor's operation and rejects expired selections", async () => {
    const db = database(); const connection = await db.repository.create(10, input, now);
    await expect(db.repository.get(11, connection.connectionId, now)).rejects.toMatchObject({ code: "not_found" });
    const expiry = new Date(now.getTime() + 15 * 60 * 1000);
    expect((await db.repository.beginValidation(10, connection.connectionId, -1001, expiry)).state).toBe("expired");
    expect(db.connections.get(connection.connectionId)?.selectedChatId).toBeUndefined();
  });
  it("persists the selected group, prevents concurrent validation and never changes selection on retry", async () => {
    const db = database(); const connection = await db.repository.create(10, input, now);
    const claim = await db.repository.beginValidation(10, connection.connectionId, -1001, now);
    expect(db.connections.get(connection.connectionId)).toMatchObject({ selectedChatId: -1001, state: "validating" });
    await expect(db.repository.beginValidation(10, connection.connectionId, -1001, now)).rejects.toMatchObject({ code: "validation_in_progress" });
    await db.repository.reject(claim, "telegram_unavailable");
    await expect(db.repository.beginValidation(10, connection.connectionId, -1002, now)).rejects.toMatchObject({ code: "selection_conflict" });
    const retry = await db.repository.beginValidation(10, connection.connectionId, undefined, now);
    expect(retry.selectedChatId).toBe(-1001);
    expect(retry.validationToken).not.toBe(claim.validationToken);
    expect(await db.repository.reject(claim, "stale_error")).toEqual(retry);
  });
  it("atomically creates a new workspace, owner and completed operation", async () => {
    const db = database(); const connection = await db.repository.create(10, input, now);
    const claim = await db.repository.beginValidation(10, connection.connectionId, -1001, now);
    db.session.executeQuery.mockClear();
    const done = await db.repository.complete(claim, { title: "Дом", isForum: true, timezone: "Europe/Moscow" }, now);
    expect(done.state).toBe("connected");
    const writes = db.session.executeQuery.mock.calls.filter(([query]) => query.includes("INSERT INTO workspaces"));
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toContain("INSERT INTO workspace_members");
    expect(writes[0][0]).toContain("INSERT INTO telegram_chat_workspaces");
    expect(decodeYdbValue(writes[0][1].$is_forum)).toBe(true);
    expect(db.session.executeQuery.mock.calls.at(-1)?.[0]).toContain("UPSERT INTO group_connections");
    expect(db.session.commitTransaction).toHaveBeenLastCalledWith({ txId: "tx-group" });
  });
  it.each([
    { owner: 99, status: "removed", role: "organizer", expected: "member" },
    { owner: 10, status: "removed", role: "owner", expected: "owner" },
    { owner: 99, status: "active", role: "organizer", expected: "organizer" },
  ])("preserves enrollment policy: $status $role returns as $expected", async ({ owner, status, role, expected }) => {
    const db = database(); db.existing(owner, status, role);
    const connection = await db.repository.create(10, input, now);
    const claim = await db.repository.beginValidation(10, connection.connectionId, -1001, now);
    const done = await db.repository.complete(claim, { title: "Дом", isForum: false, timezone: "Europe/Moscow" }, now);
    expect(done).toMatchObject({ state: "connected", workspaceId });
    const call = db.session.executeQuery.mock.calls.find(([query]) => query.includes("UPSERT INTO workspace_members"));
    expect(decodeYdbValue(call?.[1].$role)).toBe(expected);
    expect(db.session.executeQuery.mock.calls.some(([query]) => query.includes("INSERT INTO workspaces"))).toBe(false);
    expect(db.session.executeQuery.mock.calls.some(([query]) => query.includes("UPDATE reminders"))).toBe(false);
    expect(db.session.executeQuery.mock.calls.some(([query]) => query.includes("SET owner_user_id"))).toBe(false);
  });
  it.each(["removal", "closure"])("rejects concurrent %s without reactivating membership", async change => {
    const db = database(); db.existing();
    const connection = await db.repository.create(10, input, now);
    const claim = await db.repository.beginValidation(10, connection.connectionId, -1001, now);
    if (change === "removal") db.changeMembership(); else db.close();
    const done = await db.repository.complete(claim, { title: "Дом", isForum: true, timezone: "Europe/Moscow" }, now);
    expect(done).toMatchObject({ state: "rejected", errorCode: change === "removal" ? "membership_changed" : "workspace_closed" });
    expect(db.session.executeQuery.mock.calls.some(([query]) => query.includes("UPSERT INTO workspace_members"))).toBe(false);
  });
  it("allows recovery after an abandoned validation lease and ignores its late completion", async () => {
    const db = database(); const connection = await db.repository.create(10, input, now);
    const claim = await db.repository.beginValidation(10, connection.connectionId, -1001, now);
    const retry = await db.repository.beginValidation(10, connection.connectionId, undefined, new Date(now.getTime() + 31_000));
    expect(await db.repository.complete(claim, { title: "Дом", isForum: false, timezone: "UTC" }, now)).toEqual(retry);
  });
  it("uses a valid, deterministic UUID without sharing actor scopes", () => {
    expect(groupConnectionId(10, input.clientRequestId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(groupConnectionId(10, input.clientRequestId)).not.toBe(groupConnectionId(11, input.clientRequestId));
    expect(new GroupConnectionError("not_found").code).toBe("not_found");
  });
});
