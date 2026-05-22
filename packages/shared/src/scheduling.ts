import { DateTime } from "luxon";

export const DEFAULT_REMINDER_GRACE_MINUTES = 24 * 60;

export interface DueWindow {
  dueAt: Date;
  periodKey: string;
}

export function parseTimeLocal(timeLocal: string): { hour: number; minute: number } {
  const parts = timeLocal.trim().split(":");
  if (parts.length !== 2) {
    throw new Error(`Invalid time format: ${timeLocal}`);
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) {
    throw new Error(`Invalid time value: ${timeLocal}`);
  }
  return { hour, minute };
}

// День 31 в феврале → последний день месяца
export function getEffectiveDayOfMonth(dayOfMonth: number, year: number, month: number): number {
  const daysInMonth = DateTime.utc(year, month).daysInMonth ?? 28;
  return Math.min(dayOfMonth, daysInMonth);
}

// Следующая дата срабатывания recurring-правила
export function buildRecurringDueAt(
  dayOfMonth: number,
  timeLocal: string,
  timezone: string,
  reference: Date = new Date(),
): DueWindow | null {
  const { hour, minute } = parseTimeLocal(timeLocal);
  const now = DateTime.fromJSDate(reference, { zone: timezone });

  const effectiveDay = getEffectiveDayOfMonth(dayOfMonth, now.year, now.month);
  let candidate = now.set({
    day: effectiveDay,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  if (candidate > now) {
    return {
      dueAt: candidate.toJSDate(),
      periodKey: candidate.toFormat("yyyy-MM"),
    };
  }

  const nextMonth = now.plus({ months: 1 });
  const nextEffectiveDay = getEffectiveDayOfMonth(dayOfMonth, nextMonth.year, nextMonth.month);
  candidate = nextMonth.set({
    day: nextEffectiveDay,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  return {
    dueAt: candidate.toJSDate(),
    periodKey: candidate.toFormat("yyyy-MM"),
  };
}

// Текущее срабатывание recurring-правила, если время уже наступило в этом месяце
export function getCurrentRecurringDueAt(
  dayOfMonth: number,
  timeLocal: string,
  timezone: string,
  reference: Date = new Date(),
): DueWindow | null {
  const { hour, minute } = parseTimeLocal(timeLocal);
  const now = DateTime.fromJSDate(reference, { zone: timezone });
  const effectiveDay = getEffectiveDayOfMonth(dayOfMonth, now.year, now.month);
  const dueAt = now.set({
    day: effectiveDay,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  if (dueAt > now) {
    return null;
  }

  return {
    dueAt: dueAt.toJSDate(),
    periodKey: dueAt.toFormat("yyyy-MM"),
  };
}

export function shouldSendReminder(
  dueAt: Date,
  reference: Date = new Date(),
  graceMinutes = DEFAULT_REMINDER_GRACE_MINUTES,
): boolean {
  const due = DateTime.fromJSDate(dueAt);
  const now = DateTime.fromJSDate(reference);
  const diffMinutes = now.diff(due, "minutes").minutes;
  return diffMinutes >= 0 && diffMinutes < graceMinutes;
}

// Устаревший alias для тестов с коротким окном
export function isRecurringDueNow(
  dayOfMonth: number,
  timeLocal: string,
  timezone: string,
  reference: Date = new Date(),
  windowMinutes = 5,
): DueWindow | null {
  const due = getCurrentRecurringDueAt(dayOfMonth, timeLocal, timezone, reference);
  if (!due || !shouldSendReminder(due.dueAt, reference, windowMinutes)) {
    return null;
  }
  return due;
}

export function isOneoffDueNow(
  dueAt: Date,
  reference: Date = new Date(),
  graceMinutes = DEFAULT_REMINDER_GRACE_MINUTES,
): boolean {
  return shouldSendReminder(dueAt, reference, graceMinutes);
}

export function formatAmount(amount: number | null): string {
  if (amount == null) {
    return "";
  }
  return `${(amount / 100).toLocaleString("ru-RU", { minimumFractionDigits: 0 })} ₽`;
}

export function formatDueDate(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat("dd.MM.yyyy HH:mm");
}
