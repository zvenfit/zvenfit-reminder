import type { ReminderOccurrence } from "@zvenfit-reminder/shared";
import { describe, expect, it } from "vitest";
import { occurrenceKeyboard, renderOccurrenceAction } from "./occurrence-message.js";

function paymentOccurrence(): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    kind: "payment",
    title: "Домашний интернет",
    description: null,
    actionUrl: "https://example.com/pay",
    amountMinor: 89_000,
    currency: "RUB",
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    allDay: false,
    timezone: "Europe/Moscow",
    visibility: "group",
    assignment: { mode: "person", responsibleUserId: 20 },
    status: "completed",
    notificationState: "stopped",
    completedBy: 20,
    completedByDisplayName: "Иван",
    completedAt: new Date("2026-08-25T14:00:00.000Z"),
    undoUntil: new Date("2026-08-25T14:10:00.000Z"),
    updatedAt: new Date("2026-08-25T14:00:00.000Z"),
  } as ReminderOccurrence;
}

describe("payment occurrence messages", () => {
  it("uses payment language for the action and its undo", () => {
    const occurrence = paymentOccurrence();
    const keyboard = occurrenceKeyboard(occurrence);
    const rendered = renderOccurrenceAction(
      { action: "done", occurrence },
      { id: 20, displayName: "Иван" },
    );

    expect(keyboard.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["✅ Оплатил", "⏰ +1 час"],
      ["Вечером", "Завтра утром"],
    ]);
    expect(keyboard.inline_keyboard.map((row) =>
      row.map((button) => "callback_data" in button ? button.callback_data : null)
    ))
      .toEqual([
        ["od:occurrence-a", "os:occurrence-a"],
        ["oe:occurrence-a", "ot:occurrence-a"],
      ]);
    expect(rendered.text).toContain("✅ <b>");
    expect(rendered.text).toContain("Оплачено:");
    expect(rendered.text).not.toContain("Просрочено:");
    expect(rendered.keyboard.inline_keyboard[0]?.[0]?.text).toBe("↩️ Отменить оплату");
    expect(rendered.callbackNotice).toBe("Оплачено");
  });

  it("renders snooze without retaining the overdue primary state", () => {
    const occurrence = {
      ...paymentOccurrence(),
      kind: "task" as const,
      status: "overdue" as const,
      notificationState: "waiting" as const,
      dueAt: new Date("2026-08-25T12:00:00.000Z"),
      snoozeUntil: new Date("2026-08-25T16:00:00.000Z"),
      nextNotificationAt: new Date("2026-08-25T16:00:00.000Z"),
      completedBy: null,
      completedByDisplayName: null,
      completedAt: null,
      undoUntil: null,
      updatedAt: new Date("2026-08-25T15:00:00.000Z"),
    };

    const rendered = renderOccurrenceAction(
      { action: "snooze", occurrence },
      { id: 20, displayName: "Иван" },
    );

    expect(rendered.text).toContain("💤 <b>");
    expect(rendered.text).toContain("Следующий сигнал:");
    expect(rendered.text).toContain("Срок не изменился:");
    expect(rendered.text).not.toContain("Просрочено:");
    expect(rendered.callbackNotice).toBe("Напомню позже");
  });

  it("returns undo to the current deadline state without an action suffix", () => {
    const occurrence = {
      ...paymentOccurrence(),
      kind: "task" as const,
      status: "overdue" as const,
      notificationState: "waiting" as const,
      dueAt: new Date("2026-08-25T12:00:00.000Z"),
      completedBy: null,
      completedByDisplayName: null,
      completedAt: null,
      undoUntil: null,
      updatedAt: new Date("2026-08-25T15:00:00.000Z"),
    };

    const rendered = renderOccurrenceAction(
      { action: "undo", occurrence },
      { id: 20, displayName: "Иван" },
    );

    expect(rendered.text).toContain("🔴 <b>");
    expect(rendered.text).toContain("Просрочено:");
    expect(rendered.text).not.toContain("Выполнение отменено");
    expect(rendered.callbackNotice).toBe("Снова активно");
  });
});
