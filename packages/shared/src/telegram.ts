import type { ReminderOccurrence } from "./reminder-domain.js";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function occurrenceCallbackData(
  action: "done" | "snooze" | "undo",
  occurrenceId: string,
): string {
  if (!occurrenceId || occurrenceId.includes(":") || occurrenceId.length > 50) {
    throw new Error("Occurrence ID is not callback-safe");
  }
  const code = action === "done" ? "od" : action === "snooze" ? "os" : "ou";
  return `${code}:${occurrenceId}`;
}

export function parseOccurrenceCallbackData(
  data: string,
): { action: "done" | "snooze" | "undo"; occurrenceId: string } | null {
  const [code, occurrenceId, extra] = data.split(":");
  if (extra || !occurrenceId || occurrenceId.length > 50) {
    return null;
  }
  if (code === "od") {
    return { action: "done", occurrenceId };
  }
  if (code === "os") {
    return { action: "snooze", occurrenceId };
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

export function buildOccurrenceMessage(
  occurrence: ReminderOccurrence,
  now: Date = new Date(),
  options: {
    escalationWatchers?: Array<{ userId: number; displayName: string }>;
  } = {},
): string {
  const overdue = occurrence.dueAt <= now;
  const formattedDue = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    ...(occurrence.allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
    timeZone: occurrence.timezone,
  }).format(occurrence.dueAt);
  const amount = formatOccurrenceAmount(occurrence);
  const lines = [
    `${overdue ? "🔴" : "🔔"} <b>${escapeHtml(occurrence.title)}</b>`,
    overdue
      ? `Просрочено: ${escapeHtml(formattedDue)}`
      : `${occurrence.allDay ? "Срок" : "До"}: ${escapeHtml(formattedDue)}`,
  ];
  if (amount) {
    lines.push(`Сумма: ${escapeHtml(amount)}`);
  }
  if (occurrence.description) {
    lines.push(escapeHtml(occurrence.description));
  }
  if (occurrence.visibility === "group" && occurrence.assignment.mode === "person") {
    lines.push(
      `<a href="tg://user?id=${occurrence.assignment.responsibleUserId}">Ответственный</a>`,
    );
  }
  if (options.escalationWatchers?.length) {
    const mentions = options.escalationWatchers.map(({ userId, displayName }) =>
      `<a href="tg://user?id=${userId}">${escapeHtml(displayName)}</a>`
    ).join(" ");
    lines.push(`⚠️ Нужна помощь наблюдателей: ${mentions}`);
  }
  return lines.join("\n");
}
