import type { ScheduleSpec } from "./api";

export type ReminderFrequency = ScheduleSpec["frequency"];
export type RecurringFrequency = Exclude<ReminderFrequency, "once">;

export interface IntervalMetadata {
  min: 1;
  max: number;
  unitLabel: "дней" | "недель" | "месяцев" | "лет";
}

const INTERVAL_METADATA: Readonly<Record<RecurringFrequency, IntervalMetadata>> = {
  daily: { min: 1, max: 365, unitLabel: "дней" },
  weekly: { min: 1, max: 52, unitLabel: "недель" },
  monthly: { min: 1, max: 120, unitLabel: "месяцев" },
  yearly: { min: 1, max: 20, unitLabel: "лет" },
};

const YEARLY_MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function calendarDateParts(reference: Date, timezone: string): CalendarDateParts {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(reference);

  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = Number(parts.find((candidate) => candidate.type === type)?.value);
    if (!Number.isInteger(value)) {
      throw new RangeError(`Unable to resolve ${type} in timezone ${timezone}`);
    }
    return value;
  };

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
  };
}

function shiftedCalendarDate(
  { year, month, day }: CalendarDateParts,
  dayOffset: number,
): CalendarDateParts {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + dayOffset);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatCalendarDate({ year, month, day }: CalendarDateParts): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

export function localCalendarDate(
  reference: Date,
  timezone: string,
  dayOffset = 0,
): string {
  if (!Number.isInteger(dayOffset)) {
    throw new RangeError("dayOffset must be an integer");
  }
  return formatCalendarDate(shiftedCalendarDate(calendarDateParts(reference, timezone), dayOffset));
}

export function isoWeekdayInTimezone(reference: Date, timezone: string): number {
  const { year, month, day } = calendarDateParts(reference, timezone);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCDay() || 7;
}

export function maxValidYearlyDay(month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("month must be an integer from 1 to 12");
  }
  return YEARLY_MONTH_MAX_DAYS[month - 1];
}

export function intervalMetadataFor(
  frequency: ReminderFrequency,
): IntervalMetadata | null {
  return frequency === "once" ? null : INTERVAL_METADATA[frequency];
}
