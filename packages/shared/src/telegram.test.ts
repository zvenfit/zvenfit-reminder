import { describe, expect, it } from "vitest";
import {
  buildOccurrenceMessage,
  escapeHtml,
  occurrenceCallbackData,
  parseOccurrenceCallbackData,
  renderOccurrenceMessage,
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
    leadMinutes: 0,
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 },
    watcherUserIds: [],
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
      {
        deliveryType: "escalation",
        escalationWatchers: [{ userId: 10, displayName: "Анна & Олег" }],
      },
    );
    expect(message).toContain("Нужна помощь наблюдателей");
    expect(message).toContain('tg://user?id=10');
    expect(message).toContain("Анна &amp; Олег");
  });

  it.each([
    {
      label: "a non-escalation delivery",
      item: occurrence,
      deliveryType: "repeat" as const,
    },
    {
      label: "a private occurrence",
      item: { ...occurrence, visibility: "private" as const },
      deliveryType: "escalation" as const,
    },
  ])("does not mention watchers for $label", ({ item, deliveryType }) => {
    const message = buildOccurrenceMessage(
      item,
      new Date("2026-08-27T15:00:00.000Z"),
      {
        deliveryType,
        escalationWatchers: [{ userId: 10, displayName: "Анна & Олег" }],
      },
    );

    expect(message).not.toContain("Нужна помощь наблюдателей");
    expect(message).not.toContain("tg://user?id=10");
  });

  it("renders an initial signal scheduled at the deadline as the deadline arriving", () => {
    const message = buildOccurrenceMessage(
      occurrence,
      new Date("2026-08-25T15:00:01.000Z"),
      { deliveryType: "initial" },
    );

    expect(message).toContain("🔔 <b>");
    expect(message).toContain("Срок наступил: 25 августа");
    expect(message).not.toContain("Просрочено:");
  });

  it("keeps repeat signals after the deadline overdue", () => {
    const message = buildOccurrenceMessage(
      { ...occurrence, notificationSequence: 1 },
      new Date("2026-08-25T15:00:01.000Z"),
      { deliveryType: "repeat" },
    );

    expect(message).toContain("🔴 <b>");
    expect(message).toContain("Просрочено: 25 августа");
    expect(message).not.toContain("Срок наступил:");
  });

  it("keeps a quiet-hours-delayed initial signal overdue", () => {
    const message = buildOccurrenceMessage(
      {
        ...occurrence,
        reminderStartAt: new Date("2026-08-26T05:00:00.000Z"),
      },
      new Date("2026-08-26T05:00:01.000Z"),
      { deliveryType: "initial" },
    );

    expect(message).toContain("🔴 <b>");
    expect(message).toContain("Просрочено: 25 августа");
  });

  it("keeps a substantially delayed initial signal overdue", () => {
    const message = buildOccurrenceMessage(
      occurrence,
      new Date("2026-08-25T15:06:01.000Z"),
      { deliveryType: "initial" },
    );

    expect(message).toContain("🔴 <b>");
    expect(message).toContain("Просрочено: 25 августа");
  });

  it("renders completion instead of retaining an overdue prefix", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        status: "completed",
        notificationState: "stopped",
        completedBy: 42,
        completedByDisplayName: "Иван <Петров> & Ко",
        completedAt: new Date("2026-08-26T09:05:00.000Z"),
        undoUntil: new Date("2026-08-26T09:15:00.000Z"),
      },
      new Date("2026-08-26T09:06:00.000Z"),
    );

    expect(rendered.state).toBe("completed");
    expect(rendered.text).toContain("✅ <b>");
    expect(rendered.text).toContain("Оплачено:");
    expect(rendered.text).toContain("Иван &lt;Петров&gt; &amp; Ко");
    expect(rendered.text).toContain("Отменить можно до");
    expect(rendered.text).not.toContain("🔴");
    expect(rendered.text).not.toContain("Просрочено:");
  });

  it("distinguishes a recurring task cadence from repeated signals", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        kind: "task",
      },
      new Date("2026-08-25T15:00:01.000Z"),
      {
        deliveryType: "initial",
        schedule: {
          version: 1,
          frequency: "daily",
          interval: 1,
          startDate: "2026-08-25",
          timing: { kind: "timed", timeLocal: "18:00" },
        },
      },
    );

    expect(rendered.text).toContain("🔁 Ритм задачи: Каждый день · 18:00");
  });

  it("makes recurring completion scope and the next deadline explicit", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        kind: "task",
        status: "completed",
        notificationState: "stopped",
        completedBy: 42,
        completedByDisplayName: "Иван",
        completedAt: new Date("2026-08-30T09:06:00.000Z"),
        undoUntil: new Date("2026-08-30T09:16:00.000Z"),
      },
      new Date("2026-08-30T09:07:00.000Z"),
      {
        schedule: {
          version: 1,
          frequency: "daily",
          interval: 1,
          startDate: "2026-08-25",
          timing: { kind: "timed", timeLocal: "12:00" },
        },
        nextOccurrenceAt: new Date("2026-08-31T09:00:00.000Z"),
      },
    );

    expect(rendered.text).toContain("Этот срок выполнен:");
    expect(rendered.text).toContain("Следующий срок: 31 августа в 12:00");
    expect(rendered.text).toContain("🔁 Ритм задачи: Каждый день · 12:00");
  });

  it("keeps one-off completion language and labels the schedule as one-off", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        status: "completed",
        notificationState: "stopped",
        completedBy: 42,
        completedByDisplayName: "Иван",
        completedAt: new Date("2026-08-25T15:05:00.000Z"),
      },
      new Date("2026-08-25T15:06:00.000Z"),
      {
        schedule: {
          version: 1,
          frequency: "once",
          date: "2026-08-25",
          timing: { kind: "timed", timeLocal: "18:00" },
        },
      },
    );

    expect(rendered.text).toContain("Оплачено:");
    expect(rendered.text).not.toContain("Этот срок оплачен:");
    expect(rendered.text).toContain("Ритм задачи: Один раз · 25 августа · 18:00");
    expect(rendered.text).not.toContain("🔁 Ритм задачи:");
    expect(rendered.text).not.toContain("Следующий срок:");
  });

  it("renders snooze as the only primary state while retaining the deadline", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        status: "overdue",
        snoozedBy: 42,
        snoozedAt: new Date("2026-08-26T09:05:00.000Z"),
        snoozeUntil: new Date("2026-08-26T10:05:00.000Z"),
        nextNotificationAt: new Date("2026-08-26T10:05:00.000Z"),
      },
      new Date("2026-08-26T09:06:00.000Z"),
    );

    expect(rendered.state).toBe("snoozed");
    expect(rendered.text).toContain("💤 <b>");
    expect(rendered.text).toContain("Следующий сигнал: 26 августа в 13:05");
    expect(rendered.text).toContain("Срок не изменился: 25 августа");
    expect(rendered.text).not.toContain("Просрочено:");
  });

  it.each([
    {
      expectedState: "cancelled" as const,
      overrides: { status: "cancelled" as const, notificationState: "stopped" as const },
      marker: "⏹ <b>",
      copy: "Напоминание завершено",
    },
    {
      expectedState: "paused" as const,
      overrides: { status: "overdue" as const, notificationState: "stopped" as const },
      marker: "⏸ <b>",
      copy: "Напоминание приостановлено",
    },
  ])("renders $expectedState without an overdue suffix", ({
    expectedState,
    overrides,
    marker,
    copy,
  }) => {
    const rendered = renderOccurrenceMessage(
      { ...occurrence, ...overrides },
      new Date("2026-08-26T09:06:00.000Z"),
    );

    expect(rendered.state).toBe(expectedState);
    expect(rendered.text).toContain(marker);
    expect(rendered.text).toContain(copy);
    if (expectedState === "paused") {
      expect(rendered.text).toContain("Новых сигналов не будет");
    }
    expect(rendered.text).not.toContain("Просрочено:");
  });

  it("stops treating an expired snooze as the current state", () => {
    const rendered = renderOccurrenceMessage(
      {
        ...occurrence,
        status: "overdue",
        snoozeUntil: new Date("2026-08-26T09:05:00.000Z"),
      },
      new Date("2026-08-26T09:06:00.000Z"),
    );

    expect(rendered.state).toBe("overdue");
    expect(rendered.text).toContain("Просрочено:");
    expect(rendered.text).not.toContain("Следующий сигнал:");
  });

  it.each([
    { preset: "one_hour" as const, code: "os" },
    { preset: "evening" as const, code: "oe" },
    { preset: "tomorrow_morning" as const, code: "ot" },
  ])("keeps the $preset snooze callback compact and round-trippable", ({ preset, code }) => {
    const occurrenceId = "550e8400-e29b-41d4-a716-446655440000";
    const data = occurrenceCallbackData("snooze", occurrenceId, preset);

    expect(data.length).toBeLessThanOrEqual(64);
    expect(data).toBe(`${code}:${occurrenceId}`);
    expect(parseOccurrenceCallbackData(data)).toEqual({
      action: "snooze",
      occurrenceId,
      snoozePreset: preset,
    });
  });

  it("keeps legacy one-hour callbacks backward compatible", () => {
    expect(parseOccurrenceCallbackData("os:occurrence-a")).toEqual({
      action: "snooze",
      occurrenceId: "occurrence-a",
      snoozePreset: "one_hour",
    });
    expect(parseOccurrenceCallbackData(occurrenceCallbackData("undo", "occurrence-a"))).toEqual({
      action: "undo",
      occurrenceId: "occurrence-a",
    });
  });

  it("keeps every preset callback within Telegram's limit at the maximum ID length", () => {
    const occurrenceId = "a".repeat(50);

    for (const preset of ["one_hour", "evening", "tomorrow_morning"] as const) {
      const data = occurrenceCallbackData("snooze", occurrenceId, preset);
      expect(new TextEncoder().encode(data).byteLength)
        .toBeLessThanOrEqual(64);
    }
  });

  it("rejects callback IDs that exceed Telegram's UTF-8 byte limit", () => {
    const oversizedId = "я".repeat(31);

    expect(() => occurrenceCallbackData("snooze", oversizedId, "evening"))
      .toThrow("Occurrence ID is not callback-safe");
    expect(parseOccurrenceCallbackData(`oe:${oversizedId}`)).toBeNull();
  });
});
