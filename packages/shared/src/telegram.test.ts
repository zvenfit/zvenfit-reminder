import { describe, expect, it } from "vitest";
import {
  buildMentionHtml,
  buildOccurrenceMessage,
  buildReminderMessage,
  escapeHtml,
  occurrenceCallbackData,
  parseOccurrenceCallbackData,
} from "./telegram.js";
import type { ReminderOccurrence } from "./reminder-domain.js";
import type { GroupMember, Rule } from "./types.js";

const members: GroupMember[] = [
  {
    chatId: -100,
    userId: 42,
    username: "alice",
    displayName: "Alice",
    updatedAt: new Date(),
  },
  {
    chatId: -100,
    userId: 99,
    username: null,
    displayName: "Bob",
    updatedAt: new Date(),
  },
];

describe("buildMentionHtml", () => {
  it("builds tg://user links", () => {
    expect(buildMentionHtml([42, 99], members)).toBe(
      '<a href="tg://user?id=42">Alice</a> <a href="tg://user?id=99">Bob</a>',
    );
  });
});

describe("buildReminderMessage", () => {
  it("uses HTML without entities", () => {
    const rule: Rule = {
      id: "1",
      title: "Ипотека",
      amount: 5_000_000,
      ruleType: "recurring",
      dayOfMonth: 5,
      dueAt: null,
      timeLocal: "09:00",
      timezone: "Europe/Moscow",
      chatId: -100,
      mentionIds: [42],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const message = buildReminderMessage(rule, members);
    expect(message).toContain("<b>Ипотека</b>");
    expect(message).toContain('href="tg://user?id=42"');
    expect(message).not.toContain("entities");
  });
});

describe("escapeHtml", () => {
  it("escapes special chars", () => {
    expect(escapeHtml(`a & b < c`)).toBe("a &amp; b &lt; c");
  });
});

describe("universal occurrence Telegram UX", () => {
  const occurrence: ReminderOccurrence = {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    reminderVersion: 1,
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    dueLocalDate: "2026-08-25",
    allDay: false,
    reminderStartAt: new Date("2026-08-25T15:00:00.000Z"),
    status: "pending",
    notificationState: "waiting",
    assignment: { mode: "person", responsibleUserId: 42 },
    title: "Передать <показания>",
    description: "Через личный кабинет & приложение",
    actionUrl: null,
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
  });

  it("keeps callback data compact and round-trippable", () => {
    const data = occurrenceCallbackData("snooze", "550e8400-e29b-41d4-a716-446655440000");
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseOccurrenceCallbackData(data)).toEqual({
      action: "snooze",
      occurrenceId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });
});
