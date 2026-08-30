import type {
  DeliveryType,
  ReminderOccurrence,
  ScheduleSpec,
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
  schedule?: ScheduleSpec;
  nextOccurrenceAt?: Date | null;
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

function formatDeadlineInstant(
  instant: Date,
  timezone: string,
  allDay: boolean,
): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
    timeZone: timezone,
  }).format(instant);
}

function formatOccurrenceDue(occurrence: ReminderOccurrence): string {
  return formatDeadlineInstant(
    occurrence.dueAt,
    occurrence.timezone,
    occurrence.allDay,
  );
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

const WEEKDAY_LABELS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;

function formatScheduleLocalDate(date: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

/**
 * Formats the cadence of new reminder occurrences, not the repeat interval of
 * Telegram signals for one open occurrence.
 */
export function formatScheduleCadence(schedule: ScheduleSpec): string {
  const timing = schedule.timing.kind === "allDay"
    ? "весь день"
    : schedule.timing.timeLocal;

  switch (schedule.frequency) {
    case "once":
      return `Один раз · ${formatScheduleLocalDate(schedule.date)} · ${timing}`;
    case "daily":
      return `${
        schedule.interval === 1 ? "Каждый день" : `Каждые ${schedule.interval} дн.`
      } · ${timing}`;
    case "weekly": {
      const weekdays = [...schedule.weekdays]
        .sort((left, right) => left - right)
        .map((weekday) => WEEKDAY_LABELS[weekday - 1])
        .join(", ");
      return `${
        schedule.interval === 1 ? "Каждую неделю" : `Каждые ${schedule.interval} нед.`
      } · ${weekdays} · ${timing}`;
    }
    case "monthly": {
      const day = schedule.day.type === "lastDay"
        ? "последний день"
        : `${schedule.day.value}-е число`;
      return `${
        schedule.interval === 1 ? "Каждый месяц" : `Каждые ${schedule.interval} мес.`
      } · ${day} · ${timing}`;
    }
    case "yearly":
      return `${
        schedule.interval === 1 ? "Каждый год" : `Каждые ${schedule.interval} г.`
      } · ${schedule.day}.${String(schedule.month).padStart(2, "0")} · ${timing}`;
  }
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
  const isRecurring = options.schedule?.frequency !== undefined &&
    options.schedule.frequency !== "once";

  if (state === "completed") {
    const actorName = escapeHtml(occurrence.completedByDisplayName ?? "Участник");
    const actor = occurrence.completedBy == null
      ? actorName
      : `<a href="tg://user?id=${occurrence.completedBy}">${actorName}</a>`;
    const completionLabel = occurrence.kind === "payment" ? "Оплачено" : "Выполнено";
    const recurringCompletionLabel = occurrence.kind === "payment"
      ? "Этот срок оплачен"
      : "Этот срок выполнен";
    lines.push(`${isRecurring ? recurringCompletionLabel : completionLabel}: ${actor}`);
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
    if (isRecurring && options.nextOccurrenceAt) {
      const nextDeadline = formatDeadlineInstant(
        options.nextOccurrenceAt,
        occurrence.timezone,
        options.schedule!.timing.kind === "allDay",
      );
      lines.push(
        `Следующий срок: ${escapeHtml(nextDeadline)}${
          options.schedule!.timing.kind === "allDay" ? " · весь день" : ""
        }`,
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

  if (options.schedule) {
    const cadencePrefix = options.schedule.frequency === "once" ? "" : "🔁 ";
    lines.push(`${cadencePrefix}Ритм задачи: ${escapeHtml(formatScheduleCadence(options.schedule))}`);
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
