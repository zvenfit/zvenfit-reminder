import type { ScheduleSpec } from "./api";

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

function parseLocalDate(value: string): LocalDateParts {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function formatLocalDate(parts: LocalDateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function asUtcDate(parts: LocalDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = asUtcDate(parts);
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dayOrdinal(parts: LocalDateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekday(parts: LocalDateParts): number {
  return asUtcDate(parts).getUTCDay() || 7;
}

function monthOrdinal(parts: LocalDateParts): number {
  return parts.year * 12 + parts.month - 1;
}

function localNow(reference: Date, timezone: string): LocalDateParts & { minutes: number } {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(reference).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isStillUpcomingToday(schedule: ScheduleSpec, nowMinutes: number): boolean {
  if (schedule.timing.kind === "allDay") return true;
  const [hour, minute] = schedule.timing.timeLocal.split(":").map(Number);
  return hour * 60 + minute >= nowMinutes;
}

function previewHorizonDays(
  schedule: ScheduleSpec,
  today: LocalDateParts,
  count: number,
): number {
  const start = parseLocalDate(
    schedule.frequency === "once" ? schedule.date : schedule.startDate,
  );
  const daysUntilStart = Math.max(0, dayOrdinal(start) - dayOrdinal(today));
  const occurrenceCount = Math.max(1, count);

  switch (schedule.frequency) {
    case "once":
      return daysUntilStart;
    case "daily":
      return daysUntilStart + schedule.interval * occurrenceCount + 1;
    case "weekly":
      return daysUntilStart + schedule.interval * 7 * occurrenceCount + 7;
    case "monthly":
      return daysUntilStart + schedule.interval * 31 * occurrenceCount + 31;
    case "yearly":
      return daysUntilStart + schedule.interval * 366 * occurrenceCount + 366;
  }
}

function matchesSchedule(schedule: ScheduleSpec, candidate: LocalDateParts): boolean {
  if (schedule.frequency === "once") {
    return formatLocalDate(candidate) === schedule.date;
  }

  const start = parseLocalDate(schedule.startDate);
  if (dayOrdinal(candidate) < dayOrdinal(start)) return false;

  if (schedule.frequency === "daily") {
    return (dayOrdinal(candidate) - dayOrdinal(start)) % schedule.interval === 0;
  }

  if (schedule.frequency === "weekly") {
    const candidateMonday = dayOrdinal(candidate) - (weekday(candidate) - 1);
    const startMonday = dayOrdinal(start) - (weekday(start) - 1);
    const weekDifference = Math.floor((candidateMonday - startMonday) / 7);
    return weekDifference % schedule.interval === 0 && schedule.weekdays.includes(weekday(candidate));
  }

  if (schedule.frequency === "monthly") {
    const monthDifference = monthOrdinal(candidate) - monthOrdinal(start);
    if (monthDifference % schedule.interval !== 0) return false;
    const expectedDay = schedule.day.type === "lastDay"
      ? daysInMonth(candidate.year, candidate.month)
      : Math.min(schedule.day.value, daysInMonth(candidate.year, candidate.month));
    return candidate.day === expectedDay;
  }

  const yearDifference = candidate.year - start.year;
  if (yearDifference % schedule.interval !== 0 || candidate.month !== schedule.month) return false;
  return candidate.day === Math.min(schedule.day, daysInMonth(candidate.year, schedule.month));
}

export function upcomingScheduleDates(
  schedule: ScheduleSpec,
  timezone: string,
  count = 3,
  reference = new Date(),
): string[] {
  const now = localNow(reference, timezone);
  const today = { year: now.year, month: now.month, day: now.day };
  const result: string[] = [];
  const maxDays = previewHorizonDays(schedule, today, count);

  for (let offset = 0; offset <= maxDays && result.length < count; offset += 1) {
    const candidate = addDays(today, offset);
    if (!matchesSchedule(schedule, candidate)) continue;
    if (offset === 0 && !isStillUpcomingToday(schedule, now.minutes)) continue;
    result.push(formatLocalDate(candidate));
  }
  return result;
}

export function earliestScheduleDate(
  dateGroups: Iterable<readonly string[]>,
): string | null {
  let earliest: string | null = null;
  for (const dates of dateGroups) {
    for (const date of dates) {
      if (earliest === null || date < earliest) earliest = date;
    }
  }
  return earliest;
}

export function formatScheduleDate(value: string, compact = false): string {
  const parts = parseLocalDate(value);
  const currentYear = new Date().getFullYear();
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: compact ? "short" : "long",
    ...(parts.year === currentYear ? {} : { year: "numeric" as const }),
    ...(compact ? {} : { weekday: "short" as const }),
  }).format(asUtcDate(parts)).replace(/\s+г\./gu, "").replace(/,\s*/gu, " · ");
}
