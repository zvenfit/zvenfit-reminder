import {
  buildOccurrenceMessage,
  escapeHtml,
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
    .text("⏰ +1 час", occurrenceCallbackData("snooze", occurrence.occurrenceId));
}

function formatOccurrenceInstant(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(instant);
}

export function renderOccurrenceAction(
  result: OccurrenceActionResult,
  actor: { id: number; displayName: string },
): { text: string; keyboard: InlineKeyboard; callbackNotice: string } {
  const { occurrence, action } = result;
  const actorName = escapeHtml(actor.displayName || "Участник");
  const actorMention = `<a href="tg://user?id=${actor.id}">${actorName}</a>`;
  const base = buildOccurrenceMessage(occurrence);
  if (action === "done") {
    const completedAt = occurrence.completedAt
      ? formatOccurrenceInstant(occurrence.completedAt, occurrence.timezone)
      : null;
    const undoUntil = occurrence.undoUntil
      ? formatOccurrenceInstant(occurrence.undoUntil, occurrence.timezone)
      : null;
    return {
      text: `${base}\n\n✅ ${occurrence.kind === "payment" ? "Оплачено" : "Выполнено"}: ${actorMention}${
        completedAt ? `\nКогда: ${escapeHtml(completedAt)}` : ""
      }${undoUntil ? `\nОтменить можно до ${escapeHtml(undoUntil)}` : ""}`,
      keyboard: new InlineKeyboard().text(
        occurrence.kind === "payment" ? "↩️ Отменить оплату" : "↩️ Отменить выполнение",
        occurrenceCallbackData("undo", occurrence.occurrenceId),
      ),
      callbackNotice: occurrence.kind === "payment" ? "Оплачено" : "Готово",
    };
  }
  if (action === "snooze") {
    const nextAt = occurrence.nextNotificationAt
      ? formatOccurrenceInstant(occurrence.nextNotificationAt, occurrence.timezone)
      : "позже";
    return {
      text: `${base}\n\n⏰ Отложено: ${escapeHtml(nextAt)}\nИзменил: ${actorMention}`,
      keyboard: occurrenceKeyboard(occurrence),
      callbackNotice: "Напомню позже",
    };
  }
  return {
    text: `${base}\n\n↩️ ${occurrence.kind === "payment" ? "Оплата отменена" : "Выполнение отменено"}: ${actorMention}`,
    keyboard: occurrenceKeyboard(occurrence),
    callbackNotice: "Снова активно",
  };
}
