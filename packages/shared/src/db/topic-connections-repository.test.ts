import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import {
  effectiveTopicConnection,
  TopicConnectionConflictError,
  topicConnectionId,
  TopicConnectionsRepository,
  type TopicConnection,
} from "./topic-connections-repository.js";
import { TopicRegistrationForbiddenError, TopicUnavailableError } from "./topics-repository.js";
import type { QueryParameters } from "./transaction.js";
import { decodeYdbValue } from "./ydb-utils.js";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const clientRequestId = "22222222-2222-4222-8222-222222222222";
const actorUserId = 20;
const telegramChatId = -1001234567890;
const now = new Date("2026-10-30T12:00:00Z");
const connectionId = topicConnectionId(workspaceId, actorUserId, clientRequestId);
const input = { clientRequestId, messageThreadId: 42, link: "https://t.me/c/1234567890/42", name: "Оплаты" };

function connectionRow(overrides: Row = {}): Row {
  return {
    connection_id: connectionId, workspace_id: workspaceId, actor_user_id: actorUserId,
    client_request_id: clientRequestId, telegram_chat_id: telegramChatId, message_thread_id: 42,
    link: input.link, name: input.name, state: "pending", error_code: "",
    expires_at: "2026-10-30T12:15:00Z", send_deadline: now.toISOString(), updated_at: now.toISOString(),
    ...overrides,
  };
}

function resultSet(rows: Row[]) {
  const names = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns: names.map((name) => ({ name })),
    rows: rows.map((row) => ({ items: names.map((name) => {
      const value = row[name];
      if (value == null) return { nullFlagValue: "NULL_VALUE" };
      if (typeof value === "string") return { textValue: value };
      if (typeof value === "boolean") return { boolValue: value };
      return { int64Value: value };
    }) })),
  };
}

// This double preserves rows across calls. Transaction isolation itself is a
// real-YDB concern; the tests below separately assert the serializable boundary.
function repositoryDouble(options: { row?: Row; role?: string | null; topic?: Row } = {}) {
  const connections = new Map<string, Row>();
  if (options.row) connections.set(String(options.row.connection_id), { ...options.row });
  let role = options.role === undefined ? "organizer" : options.role;
  let topic = options.topic;
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "topic-connection-tx" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string, parameters: QueryParameters = {}, _control?: { txId: string }) => {
      const values = Object.fromEntries(Object.entries(parameters)
        .map(([key, value]) => [key.slice(1), decodeYdbValue(value)])) as Row;
      if (query.includes("SELECT member.role AS role")) {
        return { resultSets: [resultSet(role == null ? [] : [{ role }])] };
      }
      if (query.includes("SELECT * FROM topic_connection_requests")) {
        const row = connections.get(String(values.connection_id));
        return { resultSets: [resultSet(row ? [row] : [])] };
      }
      if (query.includes("INSERT INTO topic_connection_requests")) {
        connections.set(String(values.connection_id), {
          ...values, state: "pending", error_code: null, send_deadline: values.now, verification_started_at: null, updated_at: values.now,
        });
        return { resultSets: [] };
      }
      if (query.includes("UPDATE topic_connection_requests SET")) {
        const row = connections.get(String(values.connection_id));
        if (row) connections.set(String(values.connection_id), { ...row, ...values });
        return { resultSets: [] };
      }
      if (query.includes("SELECT name, is_closed")) {
        return { resultSets: [resultSet(topic ? [topic] : [])] };
      }
      if (query.includes("INSERT INTO workspace_topics")) {
        topic = { ...values, is_closed: false, unavailable_reason: null };
        return { resultSets: [] };
      }
      if (query.includes("UPDATE workspace_topics SET")) {
        topic = { ...topic, ...values, unavailable_reason: null };
        return { resultSets: [] };
      }
      throw new Error(`Unexpected query in topic connection test: ${query}`);
    }),
  };
  const runSession: SessionRunner = async (operation) => operation(session as unknown as TableSession);
  return {
    repository: new TopicConnectionsRepository("", "", runSession), session,
    setRole: (nextRole: string | null) => { role = nextRole; },
    row: (id = connectionId) => connections.get(id),
    topic: () => topic,
  };
}

function writes(session: ReturnType<typeof repositoryDouble>["session"]) {
  return session.executeQuery.mock.calls.filter(([query]) => /INSERT INTO|UPDATE .* SET/.test(query));
}

describe("TopicConnectionsRepository.create", () => {
  it("treats uppercase and lowercase representations as the same client UUID", async () => {
    const { repository } = repositoryDouble();
    const first = await repository.create(workspaceId, actorUserId, telegramChatId, input, now);
    const replay = await repository.create(workspaceId, actorUserId, telegramChatId,
      { ...input, clientRequestId: input.clientRequestId.toUpperCase() }, now);
    expect(replay.connectionId).toBe(first.connectionId);
  });
  it("checks active workspace, chat binding and manager membership before creating the operation", async () => {
    const { repository, session } = repositoryDouble();
    const result = await repository.create(workspaceId, actorUserId, telegramChatId, {
      ...input, name: " Оплаты ", link: ` ${input.link} `,
    }, now);
    expect(result).toMatchObject({ connectionId, workspaceId, actorUserId, telegramChatId,
      messageThreadId: 42, name: "Оплаты", link: input.link, state: "pending" });
    const [query, parameters, control] = session.executeQuery.mock.calls[0];
    expect(query).toContain("member.status = 'active'");
    expect(query).toContain("workspace.status = 'active'");
    expect(query).toContain("workspace.telegram_chat_id = $telegram_chat_id");
    expect(decodeYdbValue(parameters.$workspace_id)).toBe(workspaceId);
    expect(decodeYdbValue(parameters.$actor_user_id)).toBe(actorUserId);
    expect(decodeYdbValue(parameters.$telegram_chat_id)).toBe(telegramChatId);
    expect(control).toEqual({ txId: "topic-connection-tx" });
  });

  it.each([null, "member"])("does not read or write an operation without manager access: %s", async (role) => {
    const { repository, session } = repositoryDouble({ role });
    await expect(repository.create(workspaceId, actorUserId, telegramChatId, input, now))
      .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(session.executeQuery).toHaveBeenCalledOnce();
    expect(writes(session)).toEqual([]);
    expect(session.rollbackTransaction).toHaveBeenCalled();
  });

  it("namespaces the same client UUID by actor and workspace", async () => {
    const { repository, row } = repositoryDouble();
    const first = await repository.create(workspaceId, actorUserId, telegramChatId, input, now);
    const second = await repository.create(workspaceId, 21, telegramChatId, input, now);
    const third = await repository.create("other-workspace", actorUserId, telegramChatId, input, now);
    expect(new Set([first.connectionId, second.connectionId, third.connectionId]).size).toBe(3);
    expect(row(first.connectionId)?.actor_user_id).toBe(20);
    expect(row(second.connectionId)?.actor_user_id).toBe(21);
    expect(row(third.connectionId)?.workspace_id).toBe("other-workspace");
  });

  it.each(["pending", "sending", "succeeded", "failed", "unknown"] as const)("reuses the immutable request in state %s without creating another operation", async (state) => {
    const { repository, session } = repositoryDouble({ row: connectionRow({ state, send_deadline: "2026-10-30T12:01:00Z" }) });
    await expect(repository.create(workspaceId, actorUserId, telegramChatId, input, now))
      .resolves.toMatchObject({ connectionId, state });
    expect(writes(session)).toEqual([]);
  });

  it.each([
    { name: "Другое имя" }, { link: "https://t.me/c/1234567890/52" }, { messageThreadId: 52 },
  ])("rejects reuse of a UUID with a different payload: %j", async (change) => {
    const { repository, session } = repositoryDouble({ row: connectionRow() });
    await expect(repository.create(workspaceId, actorUserId, telegramChatId, { ...input, ...change }, now))
      .rejects.toBeInstanceOf(TopicConnectionConflictError);
    expect(writes(session)).toEqual([]);
  });

  it("rejects reuse after the workspace is rebound to a different Telegram chat", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow() });
    await expect(repository.create(workspaceId, actorUserId, -1009999999999, input, now))
      .rejects.toBeInstanceOf(TopicConnectionConflictError);
    expect(writes(session)).toEqual([]);
  });
});

describe("TopicConnectionsRepository.claim", () => {
  it("claims once and binds the read, authorization and state write to the same serializable transaction", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow() });
    await expect(repository.claim(connectionId, now)).resolves.toMatchObject({ state: "sending", sendDeadline: new Date("2026-10-30T12:01:00Z") });
    expect(session.beginTransaction).toHaveBeenCalledWith({ serializableReadWrite: {} });
    for (const [, , control] of session.executeQuery.mock.calls) expect(control).toEqual({ txId: "topic-connection-tx" });
    expect(session.commitTransaction).toHaveBeenCalledWith({ txId: "topic-connection-tx" });
    await expect(repository.claim(connectionId, now)).resolves.toBeNull();
    expect(writes(session)).toHaveLength(1);
  });

  it("does not return permission to send when YDB rejects a concurrent commit", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow() });
    const conflict = new Error("ABORTED: concurrent transaction changed the operation");
    session.commitTransaction.mockRejectedValueOnce(conflict);
    await expect(repository.claim(connectionId, now)).rejects.toBe(conflict);
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "topic-connection-tx" });
  });

  it.each([null, "member"])("checks revoked manager access before sending: %s", async (role) => {
    const { repository, session } = repositoryDouble({ row: connectionRow(), role });
    await expect(repository.claim(connectionId, now)).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(writes(session)).toEqual([]);
  });

  it.each([
    { state: "pending", expires_at: now.toISOString() },
    { state: "sending", send_deadline: "2026-10-30T11:59:00Z" },
    { state: "unknown" }, { state: "succeeded" }, { state: "failed" },
  ])("never reclaims expired or already attempted operations: %j", async (overrides) => {
    const { repository, session } = repositoryDouble({ row: connectionRow(overrides) });
    await expect(repository.claim(connectionId, now)).resolves.toBeNull();
    expect(writes(session)).toEqual([]);
  });
});

describe("TopicConnectionsRepository.finish", () => {
  it.each(["sending", "unknown"])("preserves a newer unavailable result when a delayed %s probe completes", async (state) => {
    const { repository, session, topic } = repositoryDouble({
      row: connectionRow({ state, verification_started_at: now.toISOString() }),
      topic: { name: "Оплаты", is_closed: false, unavailable_reason: "topic_deleted", updated_at: "2026-10-30T12:00:02Z" },
    });
    await expect(repository.finish(connectionId, "succeeded", undefined, new Date("2026-10-30T12:00:05Z")))
      .rejects.toBeInstanceOf(TopicUnavailableError);
    expect(topic()?.unavailable_reason).toBe("topic_deleted");
    expect(writes(session)).toEqual([]);
  });

  it.each([null, now.toISOString()])("does not clear unavailability with missing or equal verification evidence: %s", async (verificationStartedAt) => {
    const { repository, session } = repositoryDouble({
      row: connectionRow({ state: "unknown", verification_started_at: verificationStartedAt }),
      topic: { name: "Оплаты", is_closed: false, unavailable_reason: "topic_closed", updated_at: now.toISOString() },
    });
    await expect(repository.finish(connectionId, "succeeded", undefined, new Date("2026-10-30T12:00:05Z")))
      .rejects.toBeInstanceOf(TopicUnavailableError);
    expect(writes(session)).toEqual([]);
  });

  it("uses original probe evidence rather than completion time for the catalog watermark", async () => {
    const { repository, topic } = repositoryDouble({
      row: connectionRow({ state: "unknown", verification_started_at: now.toISOString() }),
      topic: { name: "Оплаты", is_closed: false, unavailable_reason: "topic_deleted", updated_at: "2026-10-30T11:59:59Z" },
    });
    await repository.finish(connectionId, "succeeded", undefined, new Date("2026-10-30T12:00:05Z"));
    expect(topic()?.unavailable_reason).toBeNull();
    expect(topic()?.updated_at).toBe(now.getTime() * 1000);
  });

  it("does not advance the catalog watermark for a legacy probe without evidence", async () => {
    const previous = new Date("2026-10-30T11:59:59Z");
    const { repository, topic } = repositoryDouble({
      row: connectionRow({ state: "unknown", verification_started_at: null }),
      topic: { name: "Оплаты", is_closed: false, unavailable_reason: null, updated_at: previous.toISOString() },
    });
    await repository.finish(connectionId, "succeeded", undefined, new Date("2026-10-30T12:00:05Z"));
    expect(topic()?.updated_at).toBe(previous.getTime() * 1000);
  });

  it.each(["sending", "unknown"])("confirms a %s operation and registers its destination in the same transaction", async (state) => {
    const { repository, session, topic, row } = repositoryDouble({ row: connectionRow({ state }) });
    await expect(repository.finish(connectionId, "succeeded", undefined, now)).resolves.toMatchObject({ state: "succeeded" });
    expect(row()?.state).toBe("succeeded");
    expect(topic()).toMatchObject({ workspace_id: workspaceId, message_thread_id: 42, name: "Оплаты" });
    for (const [, , control] of session.executeQuery.mock.calls) expect(control).toEqual({ txId: "topic-connection-tx" });
    expect(session.commitTransaction).toHaveBeenCalledOnce();
  });

  it.each([null, "member"])("rejects confirmation by a revoked actor: %s", async (role) => {
    const { repository, session, topic } = repositoryDouble({ row: connectionRow({ state: "unknown" }), role });
    await expect(repository.finish(connectionId, "succeeded", undefined, now)).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(writes(session)).toEqual([]);
    expect(topic()).toBeUndefined();
  });

  it("rechecks manager access even for a duplicate successful callback", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow({ state: "succeeded" }), role: null });
    await expect(repository.finish(connectionId, "succeeded", undefined, now)).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(writes(session)).toEqual([]);
  });

  it("does not register a topic closed while the probe was in flight", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow({ state: "sending" }), topic: { name: "Оплаты", is_closed: true } });
    await expect(repository.finish(connectionId, "succeeded", undefined, now)).rejects.toBeInstanceOf(TopicUnavailableError);
    expect(writes(session)).toEqual([]);
    expect(session.rollbackTransaction).toHaveBeenCalled();
  });

  it.each(["failed", "unknown"] as const)("keeps callback success when a delayed send result is %s", async (outcome) => {
    const { repository, session, row } = repositoryDouble({ row: connectionRow({ state: "sending" }) });
    await repository.finish(connectionId, "succeeded", undefined, now);
    session.executeQuery.mockClear();
    await expect(repository.finish(connectionId, outcome, "late_response", now)).resolves.toMatchObject({ state: "succeeded" });
    expect(row()?.state).toBe("succeeded");
    expect(writes(session)).toEqual([]);
  });

  it.each([
    { state: "pending" }, { state: "failed" },
    { state: "unknown", expires_at: now.toISOString() },
  ])("does not confirm an unattempted, rejected or expired operation: %j", async (overrides) => {
    const { repository, session, topic } = repositoryDouble({ row: connectionRow(overrides) });
    const result = await repository.finish(connectionId, "succeeded", undefined, now);
    expect(result?.state).not.toBe("succeeded");
    expect(writes(session)).toEqual([]);
    expect(topic()).toBeUndefined();
  });

  it("keeps a definite failure terminal when a later result arrives", async () => {
    const { repository, session } = repositoryDouble({ row: connectionRow({ state: "failed", error_code: "telegram_forbidden" }) });
    await expect(repository.finish(connectionId, "unknown", "delivery_unknown", now))
      .resolves.toMatchObject({ state: "failed", errorCode: "telegram_forbidden" });
    expect(writes(session)).toEqual([]);
  });
});

describe("effectiveTopicConnection", () => {
  it("presents an expired send as unknown and an expired unattempted request as failed", async () => {
    const { repository } = repositoryDouble({ row: connectionRow() });
    const pending = (await repository.get(connectionId))!;
    expect(effectiveTopicConnection(pending, new Date("2026-10-30T12:15:00Z")))
      .toMatchObject({ state: "failed", errorCode: "expired" });
    const sending: TopicConnection = { ...pending, state: "sending", sendDeadline: now };
    expect(effectiveTopicConnection(sending, now)).toMatchObject({ state: "unknown", errorCode: "delivery_unknown" });
    expect(pending.state).toBe("pending");
    expect(sending.state).toBe("sending");
    expect(effectiveTopicConnection(sending, new Date("2026-10-30T12:15:00Z")))
      .toMatchObject({ state: "unknown", errorCode: "expired" });
    expect(effectiveTopicConnection({ ...sending, state: "unknown" }, new Date("2026-10-30T12:15:00Z")))
      .toMatchObject({ state: "unknown", errorCode: "expired" });
  });
});

describe("persisted topic operation metadata", () => {
  it.each([null, "", "[object Object]"])("normalizes an absent or legacy empty error code: %s", async (errorCode) => {
    const { repository } = repositoryDouble({ row: connectionRow({ error_code: errorCode }) });
    expect((await repository.get(connectionId))?.errorCode).toBeUndefined();
  });

  it("retains the claim evidence through unknown and successful callback recovery without inventing errors", async () => {
    const { repository } = repositoryDouble();
    await repository.create(workspaceId, actorUserId, telegramChatId, input, now);
    expect((await repository.get(connectionId))?.errorCode).toBeUndefined();
    await repository.claim(connectionId, now);
    expect(await repository.get(connectionId)).toMatchObject({ state: "sending", verificationStartedAt: now });
    expect((await repository.get(connectionId))?.errorCode).toBeUndefined();
    await repository.finish(connectionId, "unknown", "delivery_unknown", new Date("2026-10-30T12:00:01Z"));
    expect(await repository.get(connectionId)).toMatchObject({ errorCode: "delivery_unknown", verificationStartedAt: now });
    await repository.finish(connectionId, "succeeded", undefined, new Date("2026-10-30T12:00:02Z"));
    expect(await repository.get(connectionId)).toMatchObject({ state: "succeeded", verificationStartedAt: now });
    expect((await repository.get(connectionId))?.errorCode).toBeUndefined();
  });
});
