import { describe, expect, it } from "vitest";
import { emptyForm } from "./reminder-form-state";
import { DRAFT_TTL_MS, emptyTopicDraft, latestReminderDraft, parseReminderDraft, removeReminderDraft, saveReminderDraft, type ReminderDraft } from "./reminder-draft-storage";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}
function draft(): ReminderDraft {
  const form = emptyForm(10, "Europe/Moscow", new Date("2026-10-30T10:00:00Z"));
  return { version: 1, savedAt: Date.now(), actorId: 10, workspaceId: "team", entityKey: "occurrence:o1", editingReminderId: "r1", editingOccurrenceId: "o1", editScope: "occurrence",
    form: { ...form, title: "Черновик", messageThreadId: "42" }, scopedForms: { series: { ...form, messageThreadId: "12" }, occurrence: { ...form, messageThreadId: "42" } },
    occurrenceDate: "2026-10-31", occurrenceTime: "09:00", occurrenceAllDay: false, rawFields: { "occurrence:reminder-occurrence-date": "31.02.2026", "occurrence:reminder-occurrence-time": "25:99" },
    topicDrafts: { series: emptyTopicDraft(), occurrence: { link: "https://t.me/c/1/42", name: "Оплаты", clientRequestId: "uuid", operation: { connectionId: "id", state: "unknown", expiresAt: "2099-01-01T00:00:00Z" } } } };
}

describe("durable reminder drafts", () => {
  it("restores partial field input and isolated edit scopes without changing an unknown operation", () => {
    const original = draft();
    expect(parseReminderDraft(JSON.stringify(original), 10, "team")).toEqual(original);
  });
  it("rejects other actors, other workspaces, expired and corrupt versions", () => {
    const original = draft();
    expect(parseReminderDraft(JSON.stringify(original), 20, "team")).toBeNull();
    expect(parseReminderDraft(JSON.stringify(original), 10, "home")).toBeNull();
    expect(parseReminderDraft(JSON.stringify(original), 10, "team", original.savedAt + DRAFT_TTL_MS + 1)).toBeNull();
    expect(parseReminderDraft(JSON.stringify({ ...original, version: 99 }), 10, "team")).toBeNull();
    expect(parseReminderDraft('{"version":1}', 10, "team")).toBeNull();
    expect(parseReminderDraft("invalid JSON", 10, "team")).toBeNull();
  });
  it("clears only the saved entity after a successful write", () => {
    const storage = memoryStorage();
    const one = draft();
    const two = { ...draft(), entityKey: "new", savedAt: one.savedAt + 1 };
    saveReminderDraft(one, storage); saveReminderDraft(two, storage);
    expect(latestReminderDraft(10, "team", storage)?.entityKey).toBe("new");
    removeReminderDraft(two, storage);
    expect(latestReminderDraft(10, "team", storage)?.entityKey).toBe(one.entityKey);
    expect(latestReminderDraft(20, "team", storage)).toBeNull();
  });
  it("reports storage failure without losing the in-memory draft", () => {
    const storage = memoryStorage(); storage.setItem = () => { throw new Error("quota"); };
    expect(saveReminderDraft(draft(), storage)).toBe(false);
  });
  it("rejects malformed persisted operations before mounting the connection UI", () => {
    for (const operation of [null, { state: "sending" }, { connectionId: "x", state: "succeeded", expiresAt: "2099-01-01" }, { connectionId: "x", state: "unknown", expiresAt: "invalid" }]) {
      const original = draft();
      const raw = JSON.stringify({ ...original, topicDrafts: { ...original.topicDrafts, occurrence: { ...original.topicDrafts.occurrence, operation } } });
      expect(parseReminderDraft(raw, 10, "team")).toBeNull();
    }
  });
});
