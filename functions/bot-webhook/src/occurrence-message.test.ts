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
    completedAt: new Date("2026-08-25T14:00:00.000Z"),
    undoUntil: new Date("2026-08-25T14:10:00.000Z"),
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

    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe("✅ Оплатил");
    expect(rendered.text).toContain("✅ Оплачено:");
    expect(rendered.keyboard.inline_keyboard[0]?.[0]?.text).toBe("↩️ Отменить оплату");
    expect(rendered.callbackNotice).toBe("Оплачено");
  });
});
