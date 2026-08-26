import type {
  DeliveryType,
  ReminderOccurrence,
  SnoozePreset,
} from "./reminder-domain.js";

const INITIAL_DEADLINE_SIGNAL_GRACE_MS = 6 * 60 * 1_000;
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export type OccurrenceMessageState =
  | "initial"
  | "deadline_reached"
  | "overdue"
  | "snoozed"
  | "completed"
  | "cancelled"
  | "paused";

export interface OccurrenceMessageOptions {
  deliveryType?: DeliveryType;
  escalationWatchers?: Array<{ userId: number; displayName: string }>;
}

export interface RenderedOccurrenceMessage {
  state: OccurrenceMessageState;
  text: string;
}

export type ParsedOccurrenceCallbackData =
  | { action: "done" | "undo"; occurrenceId: string }
  | { action: "snooze"; occurrenceId: string; snoozePreset: SnoozePreset };

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function occurrenceCallbackData(
  action: "done" | "snooze" | "undo",
  occurrenceId: string,
  snoozePreset: SnoozePreset = "one_hour",
): string {
  if (!occurrenceId || occurrenceId.includes(":") || occurrenceId.length > 50) {
    throw new Error("Occurrence ID is not callback-safe");
  }
  const code = action === "done"
    ? "od"
    : action === "undo"
    ? "ou"
    : snoozePreset === "one_hour"
    ? "os"
    : snoozePreset === "evening"
    ? "oe"
    : snoozePreset === "tomorrow_morning"
    ? "ot"
    : null;
  if (!code) {
    throw new Error("Unsupported snooze preset");
  }
  const data = `${code}:${occurrenceId}`;
  if (new TextEncoder().encode(data).byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Occurrence ID is not callback-safe");
  }
  return data;
}

export function parseOccurrenceCallbackData(
  data: string,
): ParsedOccurrenceCallbackData | null {
  if (new TextEncoder().encode(data).byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return null;
  }
  const [code, occurrenceId, extra] = data.split(":");
  if (extra || !occurrenceId || occurrenceId.length > 50) {
    return null;
  }
  if (code === "od") {
    return { action: "done", occurrenceId };
  }
  if (code === "os") {
    return { action: "snooze", occurrenceId, snoozePreset: "one_hour" };
  }
  if (code === "oe") {
    return { action: "snooze", occurrenceId, snoozePreset: "evening" };
  }
  if (code === "ot") {
    return { action: "snooze", occurrenceId, snoozePreset: "tomorrow_morning" };
  }
  if (code === "ou") {
    return { action: "undo", occurrenceId };
  }
  return null;
}

function formatOccurrenceAmount(occurrence: ReminderOccurrence): string | null {
  if (occurrence.amountMinor == null || !occurrence.currency) {
    return null;
  }
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: occurrence.currency,
      maximumFractionDigits: 2,
    }).format(occurrence.amountMinor / 100);
  } catch {
    return `${occurrence.amountMinor / 100} ${occurrence.currency}`;
  }
}

function formatOccurrenceActionLink(occurrence: ReminderOccurrence): string | null {
  if (!occurrence.actionUrl) return null;
  try {
    const url = new URL(occurrence.actionUrl);
    if (occurrence.kind === "payment" && url.protocol !== "https:") {
      return "Ссылка на оплату скрыта: нужен HTTPS";
    }
    const label = occurrence.kind === "payment"
      ? `Перейти к оплате · ${url.hostname}`
      : "Открыть ссылку";
    return `<a href="${escapeHtml(url.toString())}">${escapeHtml(label)}</a>`;
  } catch {
    return null;
  }
}

function formatOccurrenceDue(occurrence: ReminderOccurrence): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    ...(occurrence.allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
    timeZone: occurrence.timezone,
  }).format(occurrence.dueAt);
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

export function resolveOccurrenceMessageState(
  occurrence: ReminderOccurrence,
  now: Date,
  options: OccurrenceMessageOptions = {},
): OccurrenceMessageState {
  if (occurrence.status === "completed") return "completed";
  if (occurrence.status === "cancelled") return "cancelled";
  if (occurrence.notificationState === "stopped") return "paused";
  if (occurrence.snoozeUntil && occurrence.snoozeUntil > now) return "snoozed";

  const deadlinePassed = occurrence.dueAt <= now;
  const deadlineReached = deadlinePassed &&
    options.deliveryType === "initial" &&
    occurrence.reminderStartAt.getTime() === occurrence.dueAt.getTime() &&
    now.getTime() - occurrence.dueAt.getTime() <= INITIAL_DEADLINE_SIGNAL_GRACE_MS;
  if (deadlineReached) return "deadline_reached";
  return deadlinePassed ? "overdue" : "initial";
}

export function renderOccurrenceMessage(
  occurrence: ReminderOccurrence,
  now: Date = new Date(),
  options: OccurrenceMessageOptions = {},
): RenderedOccurrenceMessage {
  const state = resolveOccurrenceMessageState(occurrence, now, options);
  const formattedDue = formatOccurrenceDue(occurrence);
  const icon = state === "overdue"
    ? "🔴"
    : state === "snoozed"
    ? "💤"
    : state === "completed"
    ? "✅"
    : state === "cancelled"
    ? "⏹"
    : state === "paused"
    ? "⏸"
    : "🔔";
  const lines = [`${icon} <b>${escapeHtml(occurrence.title)}</b>`];

  if (state === "completed") {
    const actorName = escapeHtml(occurrence.completedByDisplayName ?? "Участник");
    const actor = occurrence.completedBy == null
      ? actorName
      : `<a href="tg://user?id=${occurrence.completedBy}">${actorName}</a>`;
    lines.push(`${occurrence.kind === "payment" ? "Оплачено" : "Выполнено"}: ${actor}`);
    if (occurrence.completedAt) {
      lines.push(
        `Когда: ${escapeHtml(formatOccurrenceInstant(occurrence.completedAt, occurrence.timezone))}`,
      );
    }
    if (occurrence.undoUntil && occurrence.undoUntil > now) {
      lines.push(
        `Отменить можно до ${escapeHtml(formatOccurrenceInstant(occurrence.undoUntil, occurrence.timezone))}`,
      );
    }
  } else if (state === "cancelled") {
    lines.push("Напоминание завершено");
  } else if (state === "paused") {
    lines.push("Напоминание приостановлено", "Новых сигналов не будет");
  } else if (state === "snoozed") {
    lines.push(
      `Следующий сигнал: ${escapeHtml(
        formatOccurrenceInstant(occurrence.snoozeUntil!, occurrence.timezone),
      )}`,
      `Срок не изменился: ${escapeHtml(formattedDue)}`,
    );
  } else if (state === "deadline_reached") {
    lines.push(`Срок наступил: ${escapeHtml(formattedDue)}`);
  } else if (state === "overdue") {
    lines.push(`Просрочено: ${escapeHtml(formattedDue)}`);
  } else {
    lines.push(`${occurrence.allDay ? "Срок" : "До"}: ${escapeHtml(formattedDue)}`);
  }

  const amount = formatOccurrenceAmount(occurrence);
  const actionLink = formatOccurrenceActionLink(occurrence);
  if (amount) {
    lines.push(`Сумма: ${escapeHtml(amount)}`);
  }
  if (occurrence.description) {
    lines.push(escapeHtml(occurrence.description));
  }
  if (actionLink) {
    lines.push(actionLink);
  }
  if (occurrence.visibility === "group" && occurrence.assignment.mode === "person") {
    lines.push(
      `<a href="tg://user?id=${occurrence.assignment.responsibleUserId}">Ответственный</a>`,
    );
  }
  if (
    occurrence.visibility === "group" &&
    options.deliveryType === "escalation" &&
    options.escalationWatchers?.length
  ) {
    const mentions = options.escalationWatchers.map(({ userId, displayName }) =>
      `<a href="tg://user?id=${userId}">${escapeHtml(displayName)}</a>`
    ).join(" ");
    lines.push(`⚠️ Нужна помощь наблюдателей: ${mentions}`);
  }
  return { state, text: lines.join("\n") };
}

export function buildOccurrenceMessage(
  occurrence: ReminderOccurrence,
  now: Date = new Date(),
  options: OccurrenceMessageOptions = {},
): string {
  return renderOccurrenceMessage(occurrence, now, options).text;
}
