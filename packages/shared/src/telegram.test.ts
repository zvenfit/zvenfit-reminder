import { describe, expect, it } from "vitest";
import {
  buildOccurrenceMessage,
  escapeHtml,
  occurrenceCallbackData,
  parseOccurrenceCallbackData,
} from "./telegram.js";
import type { ReminderOccurrence } from "./reminder-domain.js";

describe("escapeHtml", () => {
  it("escapes special chars", () => {
    expect(escapeHtml(`a & b < c`)).toBe("a &amp; b &lt; c");
  });
});

describe("occurrence Telegram UX", () => {
  const occurrence: ReminderOccurrence = {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    reminderVersion: 1,
    stateRevision: 1,
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    dueLocalDate: "2026-08-25",
    allDay: false,
    reminderStartAt: new Date("2026-08-25T15:00:00.000Z"),
    status: "pending",
    notificationState: "waiting",
    assignment: { mode: "person", responsibleUserId: 42 },
    kind: "payment",
    title: "Передать <показания>",
    description: "Через личный кабинет & приложение",
    actionUrl: "https://example.com/pay?for=a&b=1",
    amountMinor: 123_450,
    currency: "RUB",
    visibility: "group",
    timezone: "Europe/Moscow",
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 },
    nextNotificationAt: new Date("2026-08-25T15:00:00.000Z"),
    notificationSequence: 0,
    snoozedBy: null,
    snoozedAt: null,
    snoozeUntil: null,
    latestMessageChatId: null,
    latestMessageId: null,
    completedBy: null,
    completedAt: null,
    undoUntil: null,
    cancelledBy: null,
    cancellationReason: null,
    cancelledAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  it("formats arbitrary reminder content and mentions the responsible person", () => {
    const message = buildOccurrenceMessage(
      occurrence,
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(message).toContain("Передать &lt;показания&gt;");
    expect(message).toContain("1 234,50 ₽");
    expect(message).toContain("tg://user?id=42");
    expect(message).toContain("личный кабинет &amp; приложение");
    expect(message).toContain(
      '<a href="https://example.com/pay?for=a&amp;b=1">Перейти к оплате · example.com</a>',
    );
  });

  it("does not publish legacy cleartext payment links", () => {
    const message = buildOccurrenceMessage({
      ...occurrence,
      actionUrl: "http://example.com/pay",
    });

    expect(message).toContain("Ссылка на оплату скрыта: нужен HTTPS");
    expect(message).not.toContain('href="http://example.com/pay"');
  });

  it("mentions active watchers only for an escalation delivery", () => {
    const message = buildOccurrenceMessage(
      occurrence,
      new Date("2026-08-27T15:00:00.000Z"),
      { escalationWatchers: [{ userId: 10, displayName: "Анна & Олег" }] },
    );
    expect(message).toContain("Нужна помощь наблюдателей");
    expect(message).toContain('tg://user?id=10');
    expect(message).toContain("Анна &amp; Олег");
  });

  it("keeps callback data compact and round-trippable", () => {
    const data = occurrenceCallbackData("snooze", "550e8400-e29b-41d4-a716-446655440000");
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseOccurrenceCallbackData(data)).toEqual({
      action: "snooze",
      occurrenceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parseOccurrenceCallbackData(occurrenceCallbackData("undo", "occurrence-a"))).toEqual({
      action: "undo",
      occurrenceId: "occurrence-a",
    });
  });
});
