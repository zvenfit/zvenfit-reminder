import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import { reminderDraftSchema, reminderDraftUpdateSchema } from "../reminder-domain.js";
import type { SessionRunner } from "./client.js";
import { assertTopicAvailable, registerTopicInTransaction, TopicsRepository, TopicUnavailableError, TopicRegistrationForbiddenError, type TopicObservation } from "./topics-repository.js";
import type { QueryParameters, SerializableTransaction } from "./transaction.js";
import { decodeYdbValue } from "./ydb-utils.js";

type Row = Record<string, string | number | boolean | null>;
function resultSet(rows: Row[]) {
  const names = rows[0] ? Object.keys(rows[0]) : [];
  return { columns: names.map((name) => ({ name })), rows: rows.map((row) => ({ items: names.map((name) => {
    const value = row[name];
    if (value == null) return { nullFlagValue: "NULL_VALUE" };
    return typeof value === "string" ? { textValue: value } : typeof value === "boolean" ? { boolValue: value } : { int64Value: value };
  }) })) };
}
function repositoryDouble(rows: Row[] = []) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "topics" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (_query: string, _params?: QueryParameters) => ({ resultSets: [resultSet(rows)] })),
  };
  const runSession: SessionRunner = async (operation) => operation(session as unknown as TableSession);
  return { session, repository: new TopicsRepository("", "", runSession) };
}

function observedTopicsDouble() {
  const { repository, session } = repositoryDouble();
  let stored: Row | undefined;
  session.executeQuery.mockImplementation(async (query, parameters = {}) => {
    if (query.includes("UPSERT INTO workspace_topics")) {
      stored = Object.fromEntries(Object.entries(parameters)
        .filter(([key]) => key !== "$updated_at")
        .map(([key, value]) => [key.slice(1), decodeYdbValue(value)])) as Row;
      return { resultSets: [] };
    }
    return { resultSets: [resultSet(stored ? [stored] : [])] };
  });
  return { repository, session, stored: () => stored };
}

describe("workspace topics", () => {
  it("registers from UI only after transactional membership and workspace checks", async () => {
    const { repository, session } = repositoryDouble();
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "organizer" }])] });
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: " Оплаты " }))
      .resolves.toEqual({ messageThreadId: 42, name: "Оплаты", isClosed: false, unavailableReason: null });
    const [access, , write] = session.executeQuery.mock.calls;
    expect(access[0]).toContain("member.status = 'active'");
    expect(access[0]).toContain("workspace.status = 'active'");
    expect(decodeYdbValue(access[1]?.$actor_user_id)).toBe(20);
    expect(decodeYdbValue(access[1]?.$telegram_chat_id)).toBe(-1001234567890);
    expect(write[0]).toContain("INSERT INTO workspace_topics");
    expect(decodeYdbValue(write[1]?.$workspace_id)).toBe("group-a");
    expect(decodeYdbValue(write[1]?.$name)).toBe("Оплаты");
  });
  it("registers in an existing transaction without independently committing the operation", async () => {
    const { session } = repositoryDouble();
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    await expect(registerTopicInTransaction(
      session as unknown as SerializableTransaction, "group-a", 20, -1001234567890,
      { messageThreadId: 42, name: " Оплаты " }, new Date("2026-10-30T12:00:00Z"),
    )).resolves.toEqual({ messageThreadId: 42, name: "Оплаты", isClosed: false, unavailableReason: null });
    expect(session.beginTransaction).not.toHaveBeenCalled();
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.executeQuery.mock.calls[0][0]).toContain("workspace.telegram_chat_id = $telegram_chat_id");
  });
  it.each([{ rows: [] }, { rows: [{ role: "member" }] }])("does not register for absent, inactive or non-manager membership", async ({ rows }) => {
    const { repository, session } = repositoryDouble(rows);
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Оплаты" }))
      .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(session.executeQuery).toHaveBeenCalledOnce();
  });
  it("refreshes verification time without changing event metadata for an unchanged label", async () => {
    const { repository, session } = repositoryDouble([{ name: "Текущее имя", is_closed: false }]);
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    const now = new Date("2026-10-30T12:00:00Z");
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Текущее имя" }, now))
      .resolves.toEqual({ messageThreadId: 42, name: "Текущее имя", isClosed: false, unavailableReason: null });
    const write = session.executeQuery.mock.calls[2];
    expect(write[0]).toContain("updated_at = $updated_at");
    expect(write[0]).not.toContain("name_update_id");
    expect(write[0]).not.toContain("status_update_id");
    expect(decodeYdbValue(write[1]?.$updated_at)).toBe(now.getTime() * 1_000);
  });
  it("updates a list label without altering Telegram availability or event ordering", async () => {
    const { repository, session } = repositoryDouble([{ name: "Тема №42", is_closed: false }]);
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Оплаты" }))
      .resolves.toEqual({ messageThreadId: 42, name: "Оплаты", isClosed: false, unavailableReason: null });
    const write = session.executeQuery.mock.calls[2];
    expect(write[0]).toContain("UPDATE workspace_topics SET name = $name");
    expect(write[0]).not.toContain("name_update_id");
    expect(write[0]).not.toContain("status_update_id");
    expect(write[0]).not.toContain("is_closed");
    expect(decodeYdbValue(write[1]?.$workspace_id)).toBe("group-a");
  });
  it("keeps verification time monotonic when an older registration finishes late", async () => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: false, updated_at: "2026-10-30T12:01:00Z" }]);
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    await repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Оплаты" }, new Date("2026-10-30T12:00:00Z"));
    expect(decodeYdbValue(session.executeQuery.mock.calls[2][1]?.$updated_at)).toBe(Date.parse("2026-10-30T12:01:00Z") * 1_000);
  });
  it("cannot reopen a closed topic through UI registration", async () => {
    const { repository, session } = repositoryDouble([{ name: "Архив", is_closed: true }]);
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Оплаты" }))
      .rejects.toBeInstanceOf(TopicUnavailableError);
    expect(session.executeQuery).toHaveBeenCalledTimes(2);
  });
  it("scopes catalog reads and registration to the actual workspace", async () => {
    const { repository, session } = repositoryDouble();
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 100, name: "Оплаты", updateId: 15 });
    const write = session.executeQuery.mock.calls[1];
    expect(write[0]).toContain("UPSERT INTO workspace_topics");
    expect(decodeYdbValue(write[1]?.$workspace_id)).toBe("group-a");
    expect(decodeYdbValue(write[1]?.$message_thread_id)).toBe(42);
    await repository.list("group-b");
    const read = session.executeQuery.mock.calls.at(-1)!;
    expect(read[0]).toContain("WHERE workspace_id = $workspace_id");
    expect(decodeYdbValue(read[1]?.$workspace_id)).toBe("group-b");
  });
  it.each(["owner", "organizer"])("authorizes a /topic observation and writes in the same transaction for %s", async (role) => {
    const { repository, session } = repositoryDouble();
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role }])] });
    await repository.observeForManager("group-a", 20, -1001234567890,
      { messageThreadId: 42, messageDate: 100, updateId: 15, name: "Оплаты" });
    expect(session.beginTransaction).toHaveBeenCalledExactlyOnceWith({ serializableReadWrite: {} });
    const access = session.executeQuery.mock.calls[0];
    expect(access[0]).toContain("member.status = 'active'");
    expect(access[0]).toContain("workspace.status = 'active'");
    expect(access[0]).toContain("workspace.telegram_chat_id = $telegram_chat_id");
    expect(decodeYdbValue(access[1]?.$workspace_id)).toBe("group-a");
    expect(decodeYdbValue(access[1]?.$actor_user_id)).toBe(20);
    expect(decodeYdbValue(access[1]?.$telegram_chat_id)).toBe(-1001234567890);
    expect(session.executeQuery).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Object), { txId: "topics" });
    expect(session.executeQuery).toHaveBeenNthCalledWith(3, expect.stringContaining("UPSERT INTO workspace_topics"), expect.any(Object), { txId: "topics" });
    expect(session.commitTransaction).toHaveBeenCalledExactlyOnceWith({ txId: "topics" });
    expect(session.rollbackTransaction).not.toHaveBeenCalled();
  });
  it.each([
    { label: "demoted actor", rows: [{ role: "member" }] },
    { label: "inactive actor, closed workspace or mismatched Telegram chat", rows: [] },
  ])("rejects /topic after transactional recheck for $label", async ({ rows }) => {
    const { repository, session } = repositoryDouble(rows);
    await expect(repository.observeForManager("group-a", 20, -1001234567890,
      { messageThreadId: 42, messageDate: 100, updateId: 15, name: "Подмена" }))
      .rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(session.executeQuery).toHaveBeenCalledOnce();
    expect(session.executeQuery.mock.calls[0][0]).not.toMatch(/UPSERT|UPDATE|INSERT/);
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.rollbackTransaction).toHaveBeenCalledExactlyOnceWith({ txId: "topics" });
  });
  it("keeps known names and closed status during ordinary activity", async () => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: true,
      name_update_id: 11, name_message_date: 99, status_update_id: 12, status_message_date: 100 }]);
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 101, updateId: 13, fallbackName: "Старое имя" });
    expect(session.executeQuery).toHaveBeenCalledOnce();
  });
  it("ignores duplicate and out-of-order topic events", async () => {
    const { repository, session } = repositoryDouble([{ name: "Счета", is_closed: true,
      name_update_id: 12, name_message_date: 100, status_update_id: 12, status_message_date: 100 }]);
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 100, name: "Старое имя", isClosed: false, updateId: 11 });
    expect(session.executeQuery).toHaveBeenCalledOnce();
  });
  it("accepts a newer event after Telegram resets update IDs following inactivity", async () => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: true,
      name_update_id: 500, name_message_date: 100, status_update_id: 500, status_message_date: 100 }]);
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 700000, updateId: 5, isClosed: false });
    expect(decodeYdbValue(session.executeQuery.mock.calls[1][1]?.$is_closed)).toBe(false);
  });
  it("does not move observation time backwards when partial events finish out of order", async () => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: false,
      name_update_id: 11, name_message_date: 101, status_update_id: 0, status_message_date: 0,
      updated_at: "2026-10-30T12:01:00Z" }]);
    await repository.observe("group-a", { messageThreadId: 42, isClosed: true, messageDate: 100, updateId: 10 }, new Date("2026-10-30T12:00:00Z"));
    expect(decodeYdbValue(session.executeQuery.mock.calls[1][1]?.$updated_at)).toBe(Date.parse("2026-10-30T12:01:00Z") * 1_000);
  });
  it.each([
    { order: [0, 1], renameDate: 99 },
    { order: [1, 0], renameDate: 99 },
    { order: [0, 1], renameDate: 100 },
    { order: [1, 0], renameDate: 100 },
    { order: [0, 1], renameDate: 101 },
    { order: [1, 0], renameDate: 101 },
  ])("merges rename and close independently: %j", async ({ order, renameDate }) => {
    const { repository, stored } = observedTopicsDouble();
    const events: TopicObservation[] = [
      { messageThreadId: 42, name: "Счета", messageDate: renameDate, updateId: 13 },
      { messageThreadId: 42, isClosed: true, messageDate: 100, updateId: 12 },
    ];
    for (const index of order) await repository.observe("group-a", events[index]);
    expect(stored()).toMatchObject({
      name: "Счета", is_closed: true,
      name_update_id: 13, name_message_date: renameDate,
      status_update_id: 12, status_message_date: 100,
    });
  });
  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ])("keeps the latest name and reopened status in delivery order %j", async (...order) => {
    const { repository, stored } = observedTopicsDouble();
    const events: TopicObservation[] = [
      { messageThreadId: 42, isClosed: true, messageDate: 100, updateId: 12 },
      { messageThreadId: 42, isClosed: false, messageDate: 100, updateId: 13 },
      { messageThreadId: 42, name: "Счета", messageDate: 101, updateId: 14 },
    ];
    for (const index of order) await repository.observe("group-a", events[index]);
    expect(stored()).toMatchObject({
      name: "Счета", is_closed: false,
      name_update_id: 14, name_message_date: 101,
      status_update_id: 13, status_message_date: 100,
    });
  });
  it("does not let ordinary activity hide a delayed close or rename", async () => {
    const { repository, stored } = observedTopicsDouble();
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 200, updateId: 20, fallbackName: "Старое имя" });
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 100, updateId: 10, isClosed: true });
    await repository.observe("group-a", { messageThreadId: 42, messageDate: 101, updateId: 11, name: "Счета" });
    expect(stored()).toMatchObject({ name: "Счета", is_closed: true });
  });
  it.each([{ rows: [] }, { rows: [{ is_closed: true }] },
    { rows: [{ is_closed: false, unavailable_reason: "topic_closed" }] },
    { rows: [{ is_closed: false, unavailable_reason: "topic_deleted" }] },
  ])("rejects unknown, closed and unavailable destinations inside the write transaction", async ({ rows }) => {
    const { session } = repositoryDouble(rows);
    await expect(assertTopicAvailable(session as unknown as SerializableTransaction, "group-a", 42)).rejects.toBeInstanceOf(TopicUnavailableError);
    expect(decodeYdbValue(session.executeQuery.mock.calls[0][1]?.$workspace_id)).toBe("group-a");
  });
  it.each(["topic_closed", "topic_deleted"] as const)("returns the stored unavailability reason %s", async (reason) => {
    const { repository } = repositoryDouble([{ message_thread_id: 42, name: "Оплаты", is_closed: false, unavailable_reason: reason }]);
    await expect(repository.list("group-a")).resolves.toEqual([
      { messageThreadId: 42, name: "Оплаты", isClosed: false, unavailableReason: reason },
    ]);
  });
  it("marks only an existing destination that was not observed or verified after the send started", async () => {
    const { repository, session } = repositoryDouble();
    const claimedAt = new Date("2026-10-30T12:00:00Z");
    await repository.markUnavailable("group-a", 42, "topic_deleted", claimedAt);
    const [query, parameters] = session.executeQuery.mock.calls[0];
    expect(query).toContain("UPDATE workspace_topics SET");
    expect(query).not.toMatch(/INSERT|UPSERT|name_update_id|status_update_id|is_closed/);
    expect(query).toContain("workspace_id = $workspace_id AND message_thread_id = $message_thread_id");
    expect(query).toContain("updated_at <= $failure_observed_at");
    expect(decodeYdbValue(parameters?.$workspace_id)).toBe("group-a");
    expect(decodeYdbValue(parameters?.$message_thread_id)).toBe(42);
    expect(decodeYdbValue(parameters?.$unavailable_reason)).toBe("topic_deleted");
    expect(decodeYdbValue(parameters?.$failure_observed_at)).toBe(claimedAt.getTime() * 1_000);
  });
  it("clears a delivery failure only after successful registration of an open topic", async () => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: false, unavailable_reason: "topic_deleted", updated_at: "2026-10-30T12:00:00Z" }]);
    session.executeQuery.mockResolvedValueOnce({ resultSets: [resultSet([{ role: "owner" }])] });
    await expect(repository.register("group-a", 20, -1001234567890, { messageThreadId: 42, name: "Оплаты" }, new Date("2026-10-30T12:00:01Z")))
      .resolves.toMatchObject({ unavailableReason: null });
    expect(session.executeQuery.mock.calls[2][0]).toContain("unavailable_reason = NULL");
    expect(session.executeQuery.mock.calls[2][0]).not.toContain("is_closed =");
  });
  it.each([
    { observation: { isClosed: false, messageDate: 101, updateId: 13 }, writes: true, reason: null },
    { observation: { isClosed: false, messageDate: 99, updateId: 11 }, writes: false, reason: "topic_closed" },
    { observation: { name: "Новое имя", messageDate: 101, updateId: 13 }, writes: true, reason: "topic_closed" },
    { observation: { fallbackName: "Старое имя", messageDate: 101, updateId: 13 }, writes: false, reason: "topic_closed" },
  ])("clears unavailability only for an accepted explicit reopen: %j", async ({ observation, writes, reason }) => {
    const { repository, session } = repositoryDouble([{ name: "Оплаты", is_closed: true, unavailable_reason: "topic_closed",
      name_update_id: 10, name_message_date: 98, status_update_id: 12, status_message_date: 100 }]);
    await repository.observe("group-a", { messageThreadId: 42, ...observation });
    expect(session.executeQuery).toHaveBeenCalledTimes(writes ? 2 : 1);
    if (writes) expect(decodeYdbValue(session.executeQuery.mock.calls[1][1]?.$unavailable_reason)).toBe(reason);
  });
  it("accepts a known open topic and preserves the ordinary-chat default", async () => {
    const { session } = repositoryDouble([{ is_closed: false }]);
    await expect(assertTopicAvailable(session as unknown as SerializableTransaction, "group-a", 42)).resolves.toBeUndefined();
    await expect(assertTopicAvailable(session as unknown as SerializableTransaction, "group-a", null)).resolves.toBeUndefined();
    expect(session.executeQuery).toHaveBeenCalledOnce();
  });
});

const draft = {
  title: "Оплатить", assignment: { mode: "person", responsibleUserId: 20 },
  schedule: { version: 1, frequency: "once", date: "2026-12-01", timing: { kind: "timed", timeLocal: "12:00" } },
  timezone: "Europe/Moscow",
};
describe("forum destination validation", () => {
  it("defaults new reminders to the chat and leaves omitted PATCH destinations untouched", () => {
    expect(reminderDraftSchema.parse(draft).messageThreadId).toBeNull();
    expect(reminderDraftUpdateSchema.parse(draft).messageThreadId).toBeUndefined();
  });
  it("rejects topic destinations for private reminders and invalid IDs", () => {
    expect(reminderDraftSchema.safeParse({ ...draft, visibility: "private", messageThreadId: 42 }).success).toBe(false);
    for (const messageThreadId of [0, 1, -1, 4.2, "42", Number.MAX_SAFE_INTEGER + 1]) {
      expect(reminderDraftSchema.safeParse({ ...draft, messageThreadId }).success).toBe(false);
    }
    expect(reminderDraftSchema.parse({ ...draft, messageThreadId: 42 }).messageThreadId).toBe(42);
  });
});
