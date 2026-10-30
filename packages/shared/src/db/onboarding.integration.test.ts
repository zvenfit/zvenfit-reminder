import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { TableSession } from "ydb-sdk";
import { reminderDraftSchema } from "../reminder-domain.js";
import { getDriver, TypedValues, Types, withSession, type SessionRunner } from "./client.js";
import { DeliveriesRepository } from "./deliveries-repository.js";
import { groupConnectionId, GroupConnectionsRepository } from "./group-connections-repository.js";
import { OccurrencesRepository } from "./occurrences-repository.js";
import { RemindersRepository } from "./reminders-repository.js";
import { effectiveTopicConnection, TopicConnectionConflictError, topicConnectionId, TopicConnectionsRepository } from "./topic-connections-repository.js";
import { TopicsRepository, TopicRegistrationForbiddenError, TopicUnavailableError } from "./topics-repository.js";
import type { QueryParameters } from "./transaction.js";
import { WorkspaceMembersRepository } from "./workspace-members-repository.js";
import { WorkspacesRepository } from "./workspaces-repository.js";
import { decodeYdbValue, mapResultRows, parseYdbTimestamp, timestampValue } from "./ydb-utils.js";

const enabled = process.env.RUN_YDB_WRITE_INTEGRATION === "1";
const endpoint = process.env.YDB_ENDPOINT ?? "grpc://localhost:2136";
const database = process.env.YDB_DATABASE ?? "/local";
if (enabled) {
  const target = new URL(endpoint);
  if (!["grpc:", "grpcs:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username || target.password || target.search || target.hash ||
    (target.pathname !== "" && target.pathname !== "/") || database !== "/local") {
    throw new Error("Write integration tests require a loopback YDB endpoint and the isolated /local database");
  }
}

const groupConnections = new GroupConnectionsRepository(endpoint, database);
const topicConnections = new TopicConnectionsRepository(endpoint, database);
const workspaces = new WorkspacesRepository(endpoint, database);
const members = new WorkspaceMembersRepository(endpoint, database);
const topics = new TopicsRepository(endpoint, database);
const reminders = new RemindersRepository(endpoint, database);
const occurrences = new OccurrencesRepository(endpoint, database);
const deliveries = new DeliveriesRepository(endpoint, database);
const ownedActors = new Set<number>();
const ownedChats = new Set<number>();
const ownedWorkspaces = new Set<string>();
const ownedGroups = new Set<string>();
const ownedTopics = new Set<string>();
const t0 = new Date("2026-10-30T12:00:00Z");
const later = (milliseconds: number) => new Date(t0.getTime() + milliseconds);
const dueAt = new Date("2030-01-01T12:00:00Z");

function expectTransactionConflict(error: unknown) {
  expect(String(error)).toMatch(/Aborted|ABORTED|Transaction not found:/);
}
async function retrySerializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2) throw error;
      expectTransactionConflict(error);
    }
  }
}

function newActor() {
  const id = randomInt(8_000_000_000_000, 8_100_000_000_000);
  ownedActors.add(id);
  return id;
}
function newChat() {
  const id = -randomInt(3_000_000_000_000, 3_100_000_000_000);
  ownedChats.add(id);
  return id;
}
async function query(sql: string, parameters: QueryParameters = {}) {
  return withSession(endpoint, database, (session) => session.executeQuery(sql, parameters));
}
async function createWorkspace() {
  const actorUserId = newActor();
  const telegramChatId = newChat();
  const workspaceId = randomUUID();
  ownedWorkspaces.add(workspaceId);
  const workspace = await workspaces.create({ workspaceId, telegramChatId, ownerUserId: actorUserId,
    displayName: `Integration ${workspaceId}`, timezone: "UTC", isForum: true }, t0);
  return { workspace, actorUserId, telegramChatId };
}
async function createGroupRequest(actorUserId: number) {
  const clientRequestId = randomUUID();
  ownedGroups.add(groupConnectionId(actorUserId, clientRequestId));
  const connection = await groupConnections.create(actorUserId,
    { clientRequestId, launchMode: "private_chat" }, t0);
  return connection;
}
async function createTopicRequest(workspaceId: string, actorUserId: number, telegramChatId: number, messageThreadId = 42) {
  const clientRequestId = randomUUID();
  ownedTopics.add(topicConnectionId(workspaceId, actorUserId, clientRequestId));
  const input = { clientRequestId, messageThreadId, link: `https://t.me/integration/${messageThreadId}`, name: "Проверка" };
  const connection = await topicConnections.create(workspaceId, actorUserId, telegramChatId, input, t0);
  return { connection, input };
}
async function readTopicEvidence(workspaceId: string, messageThreadId = 42) {
  const result = await query(`
    DECLARE $workspace_id AS Utf8; DECLARE $message_thread_id AS Int64;
    SELECT unavailable_reason, updated_at FROM workspace_topics
    WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id;
  `, { $workspace_id: TypedValues.utf8(workspaceId), $message_thread_id: TypedValues.int64(messageThreadId) });
  const row = mapResultRows(result.resultSets[0])[0];
  return { unavailableReason: row.unavailable_reason, updatedAt: parseYdbTimestamp(row.updated_at) };
}
type ManagerAccessChange = "demoted" | "removed" | "archived" | "chat_rebound";
async function changeManagerAccess(workspaceId: string, actorUserId: number, change: ManagerAccessChange) {
  if (change === "demoted" || change === "removed") {
    await query(`DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64;
      UPDATE workspace_members SET ${change === "demoted" ? "role = 'member'" : "status = 'removed'"}
      WHERE workspace_id = $workspace_id AND user_id = $actor_id;`, {
      $workspace_id: TypedValues.utf8(workspaceId), $actor_id: TypedValues.int64(actorUserId),
    });
  } else if (change === "archived") {
    await query(`DECLARE $workspace_id AS Utf8;
      UPDATE workspaces SET status = 'archived' WHERE workspace_id = $workspace_id;`,
    { $workspace_id: TypedValues.utf8(workspaceId) });
  } else {
    await query(`DECLARE $workspace_id AS Utf8; DECLARE $chat_id AS Int64;
      UPDATE workspaces SET telegram_chat_id = $chat_id WHERE workspace_id = $workspace_id;`,
    { $workspace_id: TypedValues.utf8(workspaceId), $chat_id: TypedValues.int64(newChat()) });
  }
}
async function createDueOccurrence(messageThreadId: number | null = null) {
  const fixture = await createWorkspace();
  const { workspace, actorUserId, telegramChatId } = fixture;
  if (messageThreadId != null) await topics.register(workspace.workspaceId, actorUserId, telegramChatId,
    { messageThreadId, name: "Integration destination" }, t0);
  const reminder = await reminders.create(workspace.workspaceId, actorUserId, reminderDraftSchema.parse({
    title: "Integration dispatch", messageThreadId, assignment: { mode: "person", responsibleUserId: actorUserId },
    schedule: { version: 1, frequency: "once", date: "2030-01-01", timing: { kind: "timed", timeLocal: "12:00" } },
    timezone: "UTC", notificationPolicy: { ignoreQuietHours: true },
  }), { now: t0 });
  const occurrence = await occurrences.materialize(workspace.workspaceId, reminder.reminderId,
    { occurrenceId: randomUUID(), now: dueAt });
  expect(occurrence).not.toBeNull();
  return { ...fixture, reminder, occurrence: occurrence! };
}

describe.runIf(enabled)("isolated YDB onboarding writes", () => {
  afterAll(async () => {
    try {
      // Discover a workspace if its commit succeeded but the test did not receive
      // the result. Every predicate is limited to this run's random identifiers.
      if (ownedChats.size) {
        const result = await query(`
          DECLARE $chat_ids AS List<Int64>;
          SELECT workspace_id FROM telegram_chat_workspaces WHERE telegram_chat_id IN $chat_ids;
        `, { $chat_ids: TypedValues.list(Types.INT64, [...ownedChats]) });
        for (const row of mapResultRows(result.resultSets[0])) ownedWorkspaces.add(String(row.workspace_id));
      }
      await query(`
        DECLARE $workspace_ids AS List<Utf8>;
        DECLARE $actor_ids AS List<Int64>;
        DECLARE $chat_ids AS List<Int64>;
        DECLARE $group_ids AS List<Utf8>;
        DECLARE $topic_ids AS List<Utf8>;
        DELETE FROM topic_connection_requests WHERE connection_id IN $topic_ids;
        DELETE FROM group_connection_requests WHERE actor_user_id IN $actor_ids;
        DELETE FROM group_connection_counters WHERE actor_user_id IN $actor_ids;
        DELETE FROM group_connections WHERE connection_id IN $group_ids;
        DELETE FROM audit_events WHERE workspace_id IN $workspace_ids;
        DELETE FROM notification_deliveries WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_occurrence_slots WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_occurrences WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_runtime WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_watchers WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminders WHERE workspace_id IN $workspace_ids;
        DELETE FROM workspace_topics WHERE workspace_id IN $workspace_ids;
        DELETE FROM workspace_members WHERE workspace_id IN $workspace_ids;
        DELETE FROM telegram_chat_workspaces WHERE telegram_chat_id IN $chat_ids;
        DELETE FROM workspaces WHERE workspace_id IN $workspace_ids;
      `, {
        $workspace_ids: TypedValues.list(Types.UTF8, [...ownedWorkspaces]),
        $actor_ids: TypedValues.list(Types.INT64, [...ownedActors]),
        $chat_ids: TypedValues.list(Types.INT64, [...ownedChats]),
        $group_ids: TypedValues.list(Types.UTF8, [...ownedGroups]),
        $topic_ids: TypedValues.list(Types.UTF8, [...ownedTopics]),
      });
    } finally {
      await (await getDriver(endpoint, database)).destroy();
    }
  }, 30_000);

  it("creates a group request idempotently, freezes its selection and atomically creates one workspace", async () => {
    const actorUserId = newActor();
    const chatId = newChat();
    const request = await createGroupRequest(actorUserId);
    await expect(groupConnections.create(actorUserId,
      { clientRequestId: request.clientRequestId, launchMode: request.launchMode }, t0)).resolves.toEqual(request);
    await expect(groupConnections.get(actorUserId + 1, request.connectionId, t0)).rejects.toMatchObject({ code: "not_found" });
    expect((await groupConnections.getByRequest(actorUserId, request.requestId))?.connectionId).toBe(request.connectionId);
    const claim = await groupConnections.beginValidation(actorUserId, request.connectionId, chatId, t0);
    await expect(groupConnections.beginValidation(actorUserId, request.connectionId, newChat(), t0))
      .rejects.toMatchObject({ code: "selection_conflict" });
    const done = await groupConnections.complete(claim, { title: "Integration group", isForum: true, timezone: "UTC" }, later(1_000));
    expect(done.state).toBe("connected");
    ownedWorkspaces.add(done.workspaceId!);
    const workspace = await workspaces.getByTelegramChatId(chatId);
    expect(workspace).toMatchObject({ workspaceId: done.workspaceId, ownerUserId: actorUserId, isForum: true });
    await expect(members.getByUserId(done.workspaceId!, actorUserId)).resolves.toMatchObject({ role: "owner", status: "active" });
    await expect(groupConnections.complete(claim, { title: "Retry", isForum: false, timezone: "UTC" }, later(2_000)))
      .resolves.toMatchObject({ state: "connected", workspaceId: done.workspaceId });
  }, 20_000);

  it("rejoins an existing group without taking its owner or restoring a removed organizer role", async () => {
    const { workspace, actorUserId: ownerId, telegramChatId } = await createWorkspace();
    const actorUserId = newActor();
    await members.observe(workspace.workspaceId, actorUserId, t0);
    await query(`
      DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64;
      UPDATE workspace_members SET role = 'organizer', status = 'removed'
      WHERE workspace_id = $workspace_id AND user_id = $actor_id;
    `, { $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId) });
    const request = await createGroupRequest(actorUserId);
    const claim = await groupConnections.beginValidation(actorUserId, request.connectionId, telegramChatId, later(1_000));
    await expect(groupConnections.complete(claim, { title: "Existing", isForum: false, timezone: "UTC" }, later(2_000)))
      .resolves.toMatchObject({ state: "connected", workspaceId: workspace.workspaceId });
    await expect(members.getByUserId(workspace.workspaceId, actorUserId)).resolves.toMatchObject({ role: "member", status: "active" });
    await expect(workspaces.getById(workspace.workspaceId)).resolves.toMatchObject({ ownerUserId: ownerId, isForum: false });
  }, 20_000);

  it("serializes duplicate group creates and concurrent allocation of actor request IDs", async () => {
    const actorUserId = newActor();
    const clientRequestId = randomUUID();
    ownedGroups.add(groupConnectionId(actorUserId, clientRequestId));
    const create = () => groupConnections.create(actorUserId, { clientRequestId, launchMode: "private_chat" }, t0);
    const same = await Promise.allSettled([create(), create()]);
    expect(same.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of same) if (result.status === "rejected") expectTransactionConflict(result.reason);
    const first = await create();
    expect(first.requestId).toBe(1);
    for (const result of same) if (result.status === "fulfilled") expect(result.value.connectionId).toBe(first.connectionId);

    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) ownedGroups.add(groupConnectionId(actorUserId, id));
    const next = await Promise.all(ids.map((id) => retrySerializable(() => groupConnections.create(actorUserId,
      { clientRequestId: id, launchMode: "private_chat" }, later(1_000)))));
    expect(next.map((item) => item.requestId).sort()).toEqual([2, 3]);
    for (const item of [first, ...next]) {
      expect((await groupConnections.getByRequest(actorUserId, item.requestId))?.connectionId).toBe(item.connectionId);
    }
  }, 30_000);

  it("recovers an abandoned group lease and fences both late completion and late rejection", async () => {
    const actorUserId = newActor();
    const telegramChatId = newChat();
    const request = await createGroupRequest(actorUserId);
    const abandoned = await groupConnections.beginValidation(actorUserId, request.connectionId, telegramChatId, t0);
    await expect(groupConnections.beginValidation(actorUserId, request.connectionId, undefined, later(29_000)))
      .rejects.toMatchObject({ code: "validation_in_progress" });
    const retry = await groupConnections.beginValidation(actorUserId, request.connectionId, undefined, later(31_000));
    expect(retry.validationToken).not.toBe(abandoned.validationToken);
    await expect(groupConnections.complete(abandoned, { title: "Stale", isForum: false, timezone: "UTC" }, later(32_000)))
      .resolves.toMatchObject({ state: "validating", validationToken: retry.validationToken });
    await expect(groupConnections.reject(abandoned, "stale_failure"))
      .resolves.toMatchObject({ state: "validating", validationToken: retry.validationToken });
    await expect(workspaces.getByTelegramChatId(telegramChatId)).resolves.toBeNull();
    const connected = await groupConnections.complete(retry, { title: "Recovered", isForum: true, timezone: "UTC" }, later(33_000));
    ownedWorkspaces.add(connected.workspaceId!);
    await expect(workspaces.getByTelegramChatId(telegramChatId))
      .resolves.toMatchObject({ workspaceId: connected.workspaceId, ownerUserId: actorUserId, displayName: "Recovered" });
  }, 20_000);

  it("keeps one owner when different actors concurrently connect the same Telegram group", async () => {
    const telegramChatId = newChat();
    const actors = [newActor(), newActor()];
    const requests = await Promise.all(actors.map(createGroupRequest));
    const claims = await Promise.all(requests.map((request) =>
      groupConnections.beginValidation(request.actorUserId, request.connectionId, telegramChatId, t0)));
    const metadata = { title: "Concurrent group", isForum: true, timezone: "UTC" };
    const results = await Promise.allSettled(claims.map((claim) => groupConnections.complete(claim, metadata, later(1_000))));
    for (const result of results) if (result.status === "rejected") expectTransactionConflict(result.reason);
    const connected = results.flatMap((result) => result.status === "fulfilled" && result.value.state === "connected" ? [result.value] : []);
    expect(connected).toHaveLength(1);
    const workspace = (await workspaces.getByTelegramChatId(telegramChatId))!;
    ownedWorkspaces.add(workspace.workspaceId);
    expect(workspace.ownerUserId).toBe(connected[0].actorUserId);
    const other = requests.find((request) => request.actorUserId !== workspace.ownerUserId)!;
    const retry = await groupConnections.beginValidation(other.actorUserId, other.connectionId, undefined, later(31_000));
    await expect(groupConnections.complete(retry, metadata, later(32_000)))
      .resolves.toMatchObject({ state: "connected", workspaceId: workspace.workspaceId });
    await expect(workspaces.getByTelegramChatId(telegramChatId)).resolves.toMatchObject({ ownerUserId: workspace.ownerUserId });
    await expect(members.getByUserId(workspace.workspaceId, other.actorUserId)).resolves.toMatchObject({ role: "member", status: "active" });
  }, 30_000);

  it("rejects local authorization changes between group validation and completion", async () => {
    const { workspace, telegramChatId } = await createWorkspace();
    const actorUserId = newActor();
    await members.observe(workspace.workspaceId, actorUserId, t0);
    const request = await createGroupRequest(actorUserId);
    const claim = await groupConnections.beginValidation(actorUserId, request.connectionId, telegramChatId, later(1_000));
    await query(`
      DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64; DECLARE $now AS Timestamp;
      UPDATE workspace_members SET status = 'removed', updated_at = $now
      WHERE workspace_id = $workspace_id AND user_id = $actor_id;
    `, { $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId), $now: timestampValue(later(2_000)) });
    await expect(groupConnections.complete(claim, { title: "Existing", isForum: true, timezone: "UTC" }, later(3_000)))
      .resolves.toMatchObject({ state: "rejected", errorCode: "membership_changed" });
    await expect(members.getByUserId(workspace.workspaceId, actorUserId)).resolves.toMatchObject({ status: "removed" });
  }, 20_000);

  it("allows one concurrent topic claim and commits its confirmed catalog entry with the result", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    const results = await Promise.allSettled([
      topicConnections.claim(connection.connectionId, later(1_000)),
      topicConnections.claim(connection.connectionId, later(1_000)),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled" && result.value != null);
    expect(winners).toHaveLength(1);
    // The SDK can report the invalidated transaction as ABORTED or transaction
    // NotFound. Reading and retrying must never grant another send.
    for (const result of results) {
      if (result.status === "rejected") expectTransactionConflict(result.reason);
    }
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
    await expect(topicConnections.claim(connection.connectionId, later(2_000))).resolves.toBeNull();
    const done = await topicConnections.finish(connection.connectionId, "succeeded", undefined, later(3_000));
    expect(done?.state).toBe("succeeded");
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([
      { messageThreadId: 42, name: "Проверка", isClosed: false, unavailableReason: null },
    ]);
    await expect(topicConnections.finish(connection.connectionId, "unknown", "late_response", later(4_000)))
      .resolves.toMatchObject({ state: "succeeded" });
  }, 20_000);

  it("recovers a crashed topic send through duplicate callbacks without another claim or a late downgrade", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(1_000));
    const saved = (await topicConnections.get(connection.connectionId))!;
    expect(effectiveTopicConnection(saved, later(62_000)).state).toBe("unknown");
    await expect(topicConnections.claim(connection.connectionId, later(62_000))).resolves.toBeNull();
    const results = await Promise.all([
      retrySerializable(() => topicConnections.finish(connection.connectionId, "succeeded", undefined, later(63_000))),
      retrySerializable(() => topicConnections.finish(connection.connectionId, "succeeded", undefined, later(63_000))),
      retrySerializable(() => topicConnections.finish(connection.connectionId, "unknown", "late_timeout", later(63_000))),
    ]);
    expect(results.slice(0, 2).every((result) => result?.state === "succeeded")).toBe(true);
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "succeeded" });
    expect(await topics.list(workspace.workspaceId)).toHaveLength(1);
    await expect(topicConnections.finish(connection.connectionId, "failed", "late_error", later(64_000)))
      .resolves.toMatchObject({ state: "succeeded" });
  }, 30_000);

  it.each([false, true])("roundtrips absent topic errors and preserves a failure code (legacy empty SQL: %s)", async (legacyEmptyError) => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    const expectCleanRead = async (state: "pending" | "sending" | "succeeded", verificationStartedAt: Date | null) => {
      if (legacyEmptyError) await query(`DECLARE $connection_id AS Utf8;
        UPDATE topic_connection_requests SET error_code = '' WHERE connection_id = $connection_id;`,
      { $connection_id: TypedValues.utf8(connection.connectionId) });
      const saved = await topicConnections.get(connection.connectionId);
      expect(saved?.state).toBe(state);
      expect(saved?.errorCode).toBeUndefined();
      expect(saved?.verificationStartedAt).toEqual(verificationStartedAt);
    };
    await expectCleanRead("pending", null);
    const claimed = await topicConnections.claim(connection.connectionId, later(1_000));
    expect(claimed?.verificationStartedAt).toEqual(later(1_000));
    await expectCleanRead("sending", later(1_000));
    await topicConnections.finish(connection.connectionId, "succeeded", undefined, later(2_000));
    await expectCleanRead("succeeded", later(1_000));

    const failed = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId, 52);
    await topicConnections.claim(failed.connection.connectionId, later(3_000));
    await topicConnections.finish(failed.connection.connectionId, "failed", "topic_closed", later(4_000));
    await expect(topicConnections.get(failed.connection.connectionId)).resolves.toMatchObject({
      state: "failed", errorCode: "topic_closed", verificationStartedAt: later(3_000),
    });
  }, 20_000);

  it("rejects an old successful probe after a newer failure and accepts fresh verification evidence", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.register(workspace.workspaceId, actorUserId, telegramChatId, { messageThreadId: 42, name: "Original" }, t0);
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(1_000));
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ verificationStartedAt: later(1_000) });
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(2_000));

    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(3_000)))
      .rejects.toBeInstanceOf(TopicUnavailableError);
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: "topic_deleted", updatedAt: later(2_000) });
    expect((await topics.list(workspace.workspaceId))[0].name).toBe("Original");

    const fresh = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(fresh.connection.connectionId, later(5_000));
    await expect(topicConnections.finish(fresh.connection.connectionId, "succeeded", undefined, later(6_000)))
      .resolves.toMatchObject({ state: "succeeded", verificationStartedAt: later(5_000) });
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: null, updatedAt: later(5_000) });
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(4_000));
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: null, updatedAt: later(5_000) });
  }, 20_000);

  it("keeps the probe start watermark when success commits before a newer failure response arrives", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.register(workspace.workspaceId, actorUserId, telegramChatId, { messageThreadId: 42, name: "Original" }, t0);
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(1_000));
    await topicConnections.finish(connection.connectionId, "succeeded", undefined, later(3_000));
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: null, updatedAt: later(1_000) });

    // This failure response arrives after finish(T3), but its send started at T2.
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(2_000));
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: "topic_deleted", updatedAt: later(2_000) });
    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(4_000)))
      .resolves.toMatchObject({ state: "succeeded" });
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: "topic_deleted", updatedAt: later(2_000) });
  }, 20_000);

  it.each(["equal", "absent"] as const)("does not clear unavailability with %s verification evidence", async (evidence) => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.register(workspace.workspaceId, actorUserId, telegramChatId, { messageThreadId: 42, name: "Original" }, t0);
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(2_000));
    if (evidence === "absent") await query(`DECLARE $connection_id AS Utf8;
      UPDATE topic_connection_requests SET verification_started_at = NULL WHERE connection_id = $connection_id;`,
    { $connection_id: TypedValues.utf8(connection.connectionId) });
    expect((await topicConnections.get(connection.connectionId))?.verificationStartedAt)
      .toEqual(evidence === "equal" ? later(2_000) : null);
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(2_000));
    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(3_000)))
      .rejects.toBeInstanceOf(TopicUnavailableError);
    expect(await readTopicEvidence(workspace.workspaceId)).toEqual({ unavailableReason: "topic_deleted", updatedAt: later(2_000) });
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
  }, 20_000);

  it("rolls back the catalog if completing the verified topic operation fails", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(1_000));
    let failedAfterCatalogWrite = false;
    const injected = new Error("Injected failure before operation result");
    const runSession: SessionRunner = (operation) => withSession(endpoint, database, (session) => {
      const wrapped = new Proxy(session, {
        get(target, property) {
          if (property === "executeQuery") return async (...args: Parameters<TableSession["executeQuery"]>) => {
            if (typeof args[0] === "string" && args[0].includes("UPDATE topic_connection_requests SET") && decodeYdbValue(args[1]?.$state) === "succeeded") {
              failedAfterCatalogWrite = true;
              throw injected;
            }
            return target.executeQuery(...args);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return operation(wrapped);
    });
    const failing = new TopicConnectionsRepository(endpoint, database, runSession);
    await expect(failing.finish(connection.connectionId, "succeeded", undefined, later(2_000))).rejects.toBe(injected);
    expect(failedAfterCatalogWrite).toBe(true);
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([]);
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(3_000)))
      .resolves.toMatchObject({ state: "succeeded" });
    expect(await topics.list(workspace.workspaceId)).toHaveLength(1);
  }, 20_000);

  it("rechecks authorization before claiming and never revives an expired send", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    const setRole = (role: string) => query(`
      DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64; DECLARE $role AS Utf8;
      UPDATE workspace_members SET role = $role WHERE workspace_id = $workspace_id AND user_id = $actor_id;
    `, { $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId), $role: TypedValues.utf8(role) });
    await setRole("member");
    await expect(topicConnections.claim(connection.connectionId, later(1_000))).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "pending" });
    await setRole("owner");
    await topicConnections.claim(connection.connectionId, later(2_000));
    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(15 * 60_000)))
      .resolves.toMatchObject({ state: "unknown", errorCode: "expired" });
    await expect(topicConnections.claim(connection.connectionId, later(16 * 60_000))).resolves.toBeNull();
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([]);
  }, 20_000);

  it("cannot commit callback success when manager access is revoked after its transactional check", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await topicConnections.claim(connection.connectionId, later(1_000));
    let revokedAfterCheck = false;
    const runSession: SessionRunner = (operation) => withSession(endpoint, database, (session) => operation(new Proxy(session, {
      get(target, property) {
        if (property === "executeQuery") return async (...args: Parameters<TableSession["executeQuery"]>) => {
          const result = await target.executeQuery(...args);
          if (!revokedAfterCheck && typeof args[0] === "string" && args[0].includes("SELECT member.role AS role")) {
            revokedAfterCheck = true;
            await query(`DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64;
              UPDATE workspace_members SET status = 'removed'
              WHERE workspace_id = $workspace_id AND user_id = $actor_id;`, {
              $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId),
            });
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })));
    const repository = new TopicConnectionsRepository(endpoint, database, runSession);
    const result = await Promise.allSettled([repository.finish(connection.connectionId, "succeeded", undefined, later(2_000))]);
    expect(revokedAfterCheck).toBe(true);
    expect(result[0].status).toBe("rejected");
    if (result[0].status === "rejected" && !(result[0].reason instanceof TopicRegistrationForbiddenError)) {
      expectTransactionConflict(result[0].reason);
    }
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([]);
  }, 20_000);

  it.each(["owner", "organizer"] as const)("accepts a manager topic observation by an active %s in the bound chat", async (role) => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    if (role === "organizer") await query(`DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64;
      UPDATE workspace_members SET role = 'organizer' WHERE workspace_id = $workspace_id AND user_id = $actor_id;`,
    { $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId) });
    await topics.observeForManager(workspace.workspaceId, actorUserId, telegramChatId,
      { messageThreadId: 42, name: "Verified command", messageDate: 100, updateId: 10 }, later(1_000));
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([
      { messageThreadId: 42, name: "Verified command", isClosed: false, unavailableReason: null },
    ]);
  }, 20_000);

  it.each(["demoted", "removed", "archived", "chat_rebound"] as const)("rejects topic observation after access is %s without creating or changing catalog rows", async (change) => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.observe(workspace.workspaceId,
      { messageThreadId: 42, name: "Original", messageDate: 100, updateId: 10 }, t0);
    await changeManagerAccess(workspace.workspaceId, actorUserId, change);
    for (const messageThreadId of [42, 52]) {
      await expect(topics.observeForManager(workspace.workspaceId, actorUserId, telegramChatId,
        { messageThreadId, name: "Unauthorized", messageDate: 101, updateId: 11 }, later(1_000)))
        .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    }
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([
      { messageThreadId: 42, name: "Original", isClosed: false, unavailableReason: null },
    ]);
  }, 20_000);

  it.each(["removed", "chat_rebound"] as const)("cannot commit a manager observation when access is %s after the authorization read", async (change) => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.observe(workspace.workspaceId,
      { messageThreadId: 42, name: "Original", messageDate: 100, updateId: 10 }, t0);
    let changedAfterCheck = false;
    const runSession: SessionRunner = (operation) => withSession(endpoint, database, (session) => operation(new Proxy(session, {
      get(target, property) {
        if (property === "executeQuery") return async (...args: Parameters<TableSession["executeQuery"]>) => {
          const result = await target.executeQuery(...args);
          if (!changedAfterCheck && typeof args[0] === "string" && args[0].includes("SELECT member.role AS role")) {
            expect(mapResultRows(result.resultSets[0])).toEqual([{ role: "owner" }]);
            changedAfterCheck = true;
            await changeManagerAccess(workspace.workspaceId, actorUserId, change);
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })));
    const repository = new TopicsRepository(endpoint, database, runSession);
    const observation = { messageThreadId: 42, name: "Unauthorized", messageDate: 101, updateId: 11 };
    const result = await Promise.allSettled([
      repository.observeForManager(workspace.workspaceId, actorUserId, telegramChatId, observation, later(1_000)),
    ]);
    expect(changedAfterCheck).toBe(true);
    expect(result[0].status).toBe("rejected");
    if (result[0].status === "rejected" && !(result[0].reason instanceof TopicRegistrationForbiddenError)) {
      expectTransactionConflict(result[0].reason);
    }
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([
      { messageThreadId: 42, name: "Original", isClosed: false, unavailableReason: null },
    ]);
    await expect(topics.observeForManager(workspace.workspaceId, actorUserId, telegramChatId, observation, later(2_000)))
      .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
  }, 20_000);

  it.each(["open", "closed", "deleted", "missing", "moved", "chat_moved"] as const)("validates the real dispatch join for a %s destination", async (change) => {
    const { workspace, telegramChatId, occurrence } = await createDueOccurrence(42);
    const reservation = await deliveries.reserve(workspace.workspaceId, occurrence.occurrenceId, dueAt);
    expect(reservation?.delivery.messageThreadId).toBe(42);
    const workspaceParam = { $workspace_id: TypedValues.utf8(workspace.workspaceId) };
    if (change === "closed") await topics.observe(workspace.workspaceId,
      { messageThreadId: 42, isClosed: true, messageDate: 200, updateId: 200 }, dueAt);
    if (change === "deleted") await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", dueAt);
    if (change === "missing") await query(`DECLARE $workspace_id AS Utf8;
      DELETE FROM workspace_topics WHERE workspace_id = $workspace_id AND message_thread_id = 42;`, workspaceParam);
    if (change === "moved") await query(`DECLARE $workspace_id AS Utf8;
      UPDATE reminder_occurrences SET message_thread_id = NULL WHERE workspace_id = $workspace_id;`, workspaceParam);
    if (change === "chat_moved") await query(`DECLARE $workspace_id AS Utf8; DECLARE $chat_id AS Int64;
      UPDATE workspaces SET telegram_chat_id = $chat_id WHERE workspace_id = $workspace_id;`,
      { ...workspaceParam, $chat_id: TypedValues.int64(newChat()) });
    const result = await deliveries.beginSend(workspace.workspaceId, reservation!.delivery.deliveryKey,
      new Date(dueAt.getTime() + 1_000));
    expect(result.valid).toBe(change === "open");
    if (change === "open") expect(result.targetChatId).toBe(telegramChatId);
    await expect(deliveries.getByKey(workspace.workspaceId, reservation!.delivery.deliveryKey))
      .resolves.toMatchObject({ status: change === "open" ? "sending" : "cancelled", messageThreadId: 42 });
  }, 20_000);

  it("grants one send across concurrent dispatchers and scopes the delivery fence to its workspace", async () => {
    const { workspace, occurrence } = await createDueOccurrence(42);
    const reservation = await deliveries.reserve(workspace.workspaceId, occurrence.occurrenceId, dueAt);
    const deliveryKey = reservation!.delivery.deliveryKey;
    await expect(deliveries.beginSend(randomUUID(), deliveryKey, dueAt)).resolves.toEqual({ valid: false, targetChatId: null });
    await expect(deliveries.getByKey(workspace.workspaceId, deliveryKey)).resolves.toMatchObject({ status: "reserved" });
    const results = await Promise.allSettled([
      deliveries.beginSend(workspace.workspaceId, deliveryKey, dueAt),
      deliveries.beginSend(workspace.workspaceId, deliveryKey, dueAt),
    ]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.valid)).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expectTransactionConflict(result.reason);
    await expect(deliveries.beginSend(workspace.workspaceId, deliveryKey, dueAt)).resolves.toMatchObject({ valid: false });
    await expect(deliveries.getByKey(workspace.workspaceId, deliveryKey)).resolves.toMatchObject({ status: "sending" });
    await deliveries.recordResult(workspace.workspaceId, deliveryKey, { status: "sent", telegramMessageId: 777 }, dueAt);
    await expect(deliveries.recordResult(workspace.workspaceId, deliveryKey, { status: "sent", telegramMessageId: 888 }, dueAt))
      .resolves.toMatchObject({ status: "sent", telegramMessageId: 777 });
  }, 30_000);

  it("rejects changed topic payloads and revoked managers without catalog writes", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    const { connection, input } = await createTopicRequest(workspace.workspaceId, actorUserId, telegramChatId);
    await expect(topicConnections.create(workspace.workspaceId, actorUserId, telegramChatId, { ...input, messageThreadId: 52 }, later(1_000)))
      .rejects.toBeInstanceOf(TopicConnectionConflictError);
    await topicConnections.claim(connection.connectionId, later(1_000));
    await query(`
      DECLARE $workspace_id AS Utf8; DECLARE $actor_id AS Int64;
      UPDATE workspace_members SET status = 'removed'
      WHERE workspace_id = $workspace_id AND user_id = $actor_id;
    `, { $workspace_id: TypedValues.utf8(workspace.workspaceId), $actor_id: TypedValues.int64(actorUserId) });
    await expect(topicConnections.finish(connection.connectionId, "succeeded", undefined, later(2_000)))
      .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    await expect(topicConnections.get(connection.connectionId)).resolves.toMatchObject({ state: "sending" });
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([]);
  }, 20_000);

  it("merges independent topic events and ignores failure reports older than re-verification", async () => {
    const { workspace, actorUserId, telegramChatId } = await createWorkspace();
    await topics.observe(workspace.workspaceId, { messageThreadId: 42, name: "Новое имя", messageDate: 101, updateId: 11 }, t0);
    await topics.observe(workspace.workspaceId, { messageThreadId: 42, isClosed: true, messageDate: 100, updateId: 10 }, later(1_000));
    await expect(topics.list(workspace.workspaceId)).resolves.toEqual([
      { messageThreadId: 42, name: "Новое имя", isClosed: true, unavailableReason: null },
    ]);
    await topics.observe(workspace.workspaceId, { messageThreadId: 42, isClosed: false, messageDate: 102, updateId: 12 }, later(2_000));
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(3_000));
    expect((await topics.list(workspace.workspaceId))[0].unavailableReason).toBe("topic_deleted");
    await topics.register(workspace.workspaceId, actorUserId, telegramChatId, { messageThreadId: 42, name: "Новое имя" }, later(5_000));
    await topics.markUnavailable(workspace.workspaceId, 42, "topic_deleted", later(4_000));
    expect((await topics.list(workspace.workspaceId))[0].unavailableReason).toBeNull();
    await topics.markUnavailable(workspace.workspaceId, 999, "topic_deleted", later(6_000));
    expect(await topics.list(workspace.workspaceId)).toHaveLength(1);
  }, 20_000);

  it("preserves a due delivery after failed retirement and resumes it only after fenced cleanup succeeds", async () => {
    const { workspace, actorUserId } = await createWorkspace();
    const reminder = await reminders.create(workspace.workspaceId, actorUserId, reminderDraftSchema.parse({
      title: "Integration retirement", assignment: { mode: "person", responsibleUserId: actorUserId },
      schedule: { version: 1, frequency: "once", date: "2030-01-01", timing: { kind: "timed", timeLocal: "12:00" } },
      timezone: "UTC", notificationPolicy: { ignoreQuietHours: true },
    }), { now: t0 });
    const occurrenceId = randomUUID();
    const occurrence = await occurrences.materialize(workspace.workspaceId, reminder.reminderId,
      { occurrenceId, now: new Date("2030-01-01T12:00:00Z") });
    expect(occurrence).not.toBeNull();
    const parameters = { $workspace_id: TypedValues.utf8(workspace.workspaceId), $occurrence_id: TypedValues.utf8(occurrenceId) };
    await query(`
      DECLARE $workspace_id AS Utf8; DECLARE $occurrence_id AS Utf8;
      UPDATE reminder_occurrences SET latest_message_chat_id = -100123,
        latest_message_id = 77, message_sync_required = true, message_sync_retire_only = true,
        delivery_lock_key = 'integration-sync'
      WHERE workspace_id = $workspace_id AND occurrence_id = $occurrence_id;
    `, parameters);
    const read = async () => {
      const result = await query(`
        DECLARE $workspace_id AS Utf8; DECLARE $occurrence_id AS Utf8;
        SELECT latest_message_chat_id, latest_message_id, message_sync_required, message_sync_retire_only,
          state_revision, delivery_lock_key, delivery_locked_at, notification_sequence, next_notification_at
        FROM reminder_occurrences
        WHERE workspace_id = $workspace_id AND occurrence_id = $occurrence_id;
      `, parameters);
      return mapResultRows(result.resultSets[0])[0];
    };
    await occurrences.finishMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision, "wrong-sync", true);
    expect((await read()).latest_message_id).toBe(77);
    await occurrences.finishMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision + 1, "integration-sync", true);
    expect((await read()).latest_message_id).toBe(77);
    await occurrences.finishMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision, "integration-sync", false);
    const afterFailedRetirement = await read();
    expect(afterFailedRetirement).toMatchObject({ latest_message_id: 77, latest_message_chat_id: -100123,
      message_sync_required: true, message_sync_retire_only: true, delivery_lock_key: null, delivery_locked_at: null });
    expect(parseYdbTimestamp(afterFailedRetirement.next_notification_at)).toEqual(dueAt);
    await expect(deliveries.reserve(workspace.workspaceId, occurrenceId, dueAt)).resolves.toBeNull();
    expect(await read()).toEqual(afterFailedRetirement);
    const pendingDeliveries = await query(`DECLARE $workspace_id AS Utf8; DECLARE $occurrence_id AS Utf8;
      SELECT delivery_key FROM notification_deliveries
      WHERE workspace_id = $workspace_id AND occurrence_id = $occurrence_id;`, parameters);
    expect(mapResultRows(pendingDeliveries.resultSets[0])).toEqual([]);

    const sync = await occurrences.beginMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision, dueAt);
    expect(sync?.retireOnly).toBe(true);
    await occurrences.finishMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision, sync!.syncKey, true);
    expect(await read()).toMatchObject({ latest_message_id: null, latest_message_chat_id: null,
      message_sync_required: false, message_sync_retire_only: false, delivery_lock_key: null });
    const reservation = await deliveries.reserve(workspace.workspaceId, occurrenceId, dueAt);
    expect(reservation?.delivery).toMatchObject({ scheduledAt: dueAt, sequence: afterFailedRetirement.notification_sequence });
    await expect(deliveries.beginSend(workspace.workspaceId, reservation!.delivery.deliveryKey, dueAt))
      .resolves.toMatchObject({ valid: true });
    await deliveries.recordResult(workspace.workspaceId, reservation!.delivery.deliveryKey,
      { status: "sent", telegramMessageId: 888 }, dueAt);
    // A duplicated old retirement completion cannot detach the replacement card.
    await occurrences.finishMessageSync(workspace.workspaceId, occurrenceId, occurrence!.stateRevision, sync!.syncKey, true);
    expect(await read()).toMatchObject({ latest_message_id: 888, latest_message_chat_id: workspace.telegramChatId });
  }, 20_000);
});
