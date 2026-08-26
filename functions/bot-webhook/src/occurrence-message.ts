import {
  buildOccurrenceMessage,
  occurrenceCallbackData,
} from "@zvenfit-reminder/shared";
import { InlineKeyboard } from "grammy";
import type { OccurrenceActionResult } from "./occurrence-actions.js";

export function occurrenceKeyboard(
  occurrence: OccurrenceActionResult["occurrence"],
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      occurrence.kind === "payment" ? "✅ Оплатил" : "✅ Выполнил",
      occurrenceCallbackData("done", occurrence.occurrenceId),
    )
    .text("⏰ +1 час", occurrenceCallbackData("snooze", occurrence.occurrenceId))
    .row()
    .text(
      "Вечером",
      occurrenceCallbackData("snooze", occurrence.occurrenceId, "evening"),
    )
    .text(
      "Завтра утром",
      occurrenceCallbackData("snooze", occurrence.occurrenceId, "tomorrow_morning"),
    );
}

export function renderOccurrenceAction(
  result: OccurrenceActionResult,
  _actor: { id: number; displayName: string },
): { text: string; keyboard: InlineKeyboard; callbackNotice: string } {
  const { occurrence, action } = result;
  const text = buildOccurrenceMessage(occurrence, occurrence.updatedAt ?? new Date());
  if (action === "done") {
    return {
      text,
      keyboard: new InlineKeyboard().text(
        occurrence.kind === "payment" ? "↩️ Отменить оплату" : "↩️ Отменить выполнение",
        occurrenceCallbackData("undo", occurrence.occurrenceId),
      ),
      callbackNotice: occurrence.kind === "payment" ? "Оплачено" : "Готово",
    };
  }
  if (action === "snooze") {
    return {
      text,
      keyboard: occurrenceKeyboard(occurrence),
      callbackNotice: "Напомню позже",
    };
  }
  return {
    text,
    keyboard: occurrenceKeyboard(occurrence),
    callbackNotice: "Снова активно",
  };
}
