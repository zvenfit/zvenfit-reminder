import {
  buildOccurrenceMessage,
  occurrenceCallbackData,
  type ScheduleSpec,
} from "@zvenfit-reminder/shared";
import { InlineKeyboard } from "grammy";
import type { OccurrenceActionResult } from "./occurrence-actions.js";

export interface OccurrencePresentationContext {
  schedule?: ScheduleSpec;
  nextOccurrenceAt?: Date | null;
}

function isRecurring(
  presentation: OccurrencePresentationContext | undefined,
): boolean {
  return presentation?.schedule?.frequency !== undefined &&
    presentation.schedule.frequency !== "once";
}

export function occurrenceKeyboard(
  occurrence: OccurrenceActionResult["occurrence"],
  presentation: OccurrencePresentationContext = {},
): InlineKeyboard {
  const completionLabel = isRecurring(presentation)
    ? occurrence.kind === "payment"
      ? "✅ Оплатил этот срок"
      : "✅ Выполнил этот срок"
    : occurrence.kind === "payment"
      ? "✅ Оплатил"
      : "✅ Выполнил";
  return new InlineKeyboard()
    .text(
      completionLabel,
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
  const { occurrence, action, presentation } = result;
  const recurring = isRecurring(presentation);
  const text = buildOccurrenceMessage(
    occurrence,
    occurrence.updatedAt ?? new Date(),
    presentation,
  );
  if (action === "done") {
    return {
      text,
      keyboard: new InlineKeyboard().text(
        recurring
          ? "↩️ Вернуть этот срок"
          : occurrence.kind === "payment"
            ? "↩️ Отменить оплату"
            : "↩️ Отменить выполнение",
        occurrenceCallbackData("undo", occurrence.occurrenceId),
      ),
      callbackNotice: recurring
        ? occurrence.kind === "payment"
          ? "Этот срок оплачен"
          : "Этот срок выполнен"
        : occurrence.kind === "payment"
          ? "Оплачено"
          : "Готово",
    };
  }
  if (action === "snooze") {
    return {
      text,
      keyboard: occurrenceKeyboard(occurrence, presentation),
      callbackNotice: "Напомню позже",
    };
  }
  return {
    text,
    keyboard: occurrenceKeyboard(occurrence, presentation),
    callbackNotice: recurring ? "Этот срок снова активен" : "Снова активно",
  };
}
