import { DateTime } from "luxon";
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  type DeadlineTiming,
  type MonthlyDay,
  type ScheduleSpec,
  localTimeSchema,
  scheduleSpecSchema,
} from "./reminder-domain.js";

export interface ScheduledDeadline {
  dueAt: Date;
  dueLocalDate: string;
  allDay: boolean;
  notificationAnchorAt: Date;
}

export interface ScheduleOptions {
  defaultAllDayReminderTime?: string;
}

export interface QuietHours {
  startLocal: string;
  endLocal: string;
}

function assertTimezone(timezone: string): void {
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function assertInstant(instant: Date, label: string): void {
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

function parseLocalTime(timeLocal: string): { hour: number; minute: number } {
  localTimeSchema.parse(timeLocal);
  const [hour, minute] = timeLocal.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

function localDate(value: string, timezone: string): DateTime {
  const result = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  if (!result.isValid) {
    throw new Error(`Invalid local date ${value} in ${timezone}`);
  }
  return result;
}

function setLocalTime(date: DateTime, timeLocal: string): DateTime {
  const { hour, minute } = parseLocalTime(timeLocal);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function buildDeadline(
  date: DateTime,
  timing: DeadlineTiming,
  defaultAllDayReminderTime: string,
): ScheduledDeadline {
  const day = date.startOf("day");
  const dueLocalDate = day.toFormat("yyyy-MM-dd");

  if (timing.kind === "allDay") {
    return {
      dueAt: day.endOf("day").toJSDate(),
      dueLocalDate,
      allDay: true,
      notificationAnchorAt: setLocalTime(day, defaultAllDayReminderTime).toJSDate(),
    };
  }

  const due = setLocalTime(day, timing.timeLocal);
  return {
    dueAt: due.toJSDate(),
    dueLocalDate,
    allDay: false,
    notificationAnchorAt: due.toJSDate(),
  };
}

function effectiveMonthlyDay(day: MonthlyDay, month: DateTime): number {
  const daysInMonth = month.daysInMonth ?? 28;
  return day.type === "lastDay" ? daysInMonth : Math.min(day.value, daysInMonth);
}

function monthDifference(left: DateTime, right: DateTime): number {
  return (left.year - right.year) * 12 + left.month - right.month;
}

function nextDaily(
  schedule: Extract<ScheduleSpec, { frequency: "daily" }>,
  now: DateTime,
  defaultAllDayReminderTime: string,
): ScheduledDeadline {
  const anchor = localDate(schedule.startDate, now.zoneName ?? "UTC");
  const elapsedDays = Math.max(0, Math.floor(now.startOf("day").diff(anchor, "days").days));
  let index = Math.floor(elapsedDays / schedule.interval);

  for (;;) {
    const date = anchor.plus({ days: index * schedule.interval });
    const candidate = buildDeadline(date, schedule.timing, defaultAllDayReminderTime);
    if (candidate.dueAt > now.toJSDate()) {
      return candidate;
    }
    index += 1;
  }
}

function nextWeekly(
  schedule: Extract<ScheduleSpec, { frequency: "weekly" }>,
  now: DateTime,
  defaultAllDayReminderTime: string,
): ScheduledDeadline {
  const start = localDate(schedule.startDate, now.zoneName ?? "UTC");
  const anchorWeek = start.startOf("week");
  const elapsedWeeks = Math.max(0, Math.floor(now.startOf("week").diff(anchorWeek, "weeks").weeks));
  let index = Math.floor(elapsedWeeks / schedule.interval);
  const weekdays = [...schedule.weekdays].sort((left, right) => left - right);

  for (;;) {
    const week = anchorWeek.plus({ weeks: index * schedule.interval });
    for (const weekday of weekdays) {
      const date = week.plus({ days: weekday - 1 });
      if (date < start) {
        continue;
      }
      const candidate = buildDeadline(date, schedule.timing, defaultAllDayReminderTime);
      if (candidate.dueAt > now.toJSDate()) {
        return candidate;
      }
    }
    index += 1;
  }
}

function nextMonthly(
  schedule: Extract<ScheduleSpec, { frequency: "monthly" }>,
  now: DateTime,
  defaultAllDayReminderTime: string,
): ScheduledDeadline {
  const start = localDate(schedule.startDate, now.zoneName ?? "UTC");
  const anchorMonth = start.startOf("month");
  const elapsedMonths = Math.max(0, monthDifference(now.startOf("month"), anchorMonth));
  let index = Math.floor(elapsedMonths / schedule.interval);

  for (;;) {
    const month = anchorMonth.plus({ months: index * schedule.interval });
    const date = month.set({ day: effectiveMonthlyDay(schedule.day, month) });
    if (date >= start) {
      const candidate = buildDeadline(date, schedule.timing, defaultAllDayReminderTime);
      if (candidate.dueAt > now.toJSDate()) {
        return candidate;
      }
    }
    index += 1;
  }
}

function nextYearly(
  schedule: Extract<ScheduleSpec, { frequency: "yearly" }>,
  now: DateTime,
  defaultAllDayReminderTime: string,
): ScheduledDeadline {
  const zone = now.zoneName ?? "UTC";
  const start = localDate(schedule.startDate, zone);
  const elapsedYears = Math.max(0, now.year - start.year);
  let index = Math.floor(elapsedYears / schedule.interval);

  for (;;) {
    const year = start.year + index * schedule.interval;
    const month = DateTime.fromObject({ year, month: schedule.month, day: 1 }, { zone });
    const day = Math.min(schedule.day, month.daysInMonth ?? 28);
    const date = month.set({ day });
    if (date >= start) {
      const candidate = buildDeadline(date, schedule.timing, defaultAllDayReminderTime);
      if (candidate.dueAt > now.toJSDate()) {
        return candidate;
      }
    }
    index += 1;
  }
}

export function getNextScheduledDeadline(
  input: ScheduleSpec,
  timezone: string,
  reference: Date = new Date(),
  options: ScheduleOptions = {},
): ScheduledDeadline | null {
  assertTimezone(timezone);
  assertInstant(reference, "Reference");
  const schedule = scheduleSpecSchema.parse(input);
  const defaultAllDayReminderTime =
    options.defaultAllDayReminderTime ?? DEFAULT_ALL_DAY_REMINDER_TIME;
  localTimeSchema.parse(defaultAllDayReminderTime);
  const now = DateTime.fromJSDate(reference, { zone: timezone });

  switch (schedule.frequency) {
    case "once": {
      const candidate = buildDeadline(
        localDate(schedule.date, timezone),
        schedule.timing,
        defaultAllDayReminderTime,
      );
      return candidate.dueAt > reference ? candidate : null;
    }
    case "daily":
      return nextDaily(schedule, now, defaultAllDayReminderTime);
    case "weekly":
      return nextWeekly(schedule, now, defaultAllDayReminderTime);
    case "monthly":
      return nextMonthly(schedule, now, defaultAllDayReminderTime);
    case "yearly":
      return nextYearly(schedule, now, defaultAllDayReminderTime);
  }

  return null;
}

export function previewScheduledDeadlines(
  schedule: ScheduleSpec,
  timezone: string,
  reference: Date,
  count: number,
  options: ScheduleOptions = {},
): ScheduledDeadline[] {
  if (!Number.isInteger(count) || count < 0 || count > 100) {
    throw new Error("Preview count must be an integer between 0 and 100");
  }

  const result: ScheduledDeadline[] = [];
  let cursor = reference;
  while (result.length < count) {
    const next = getNextScheduledDeadline(schedule, timezone, cursor, options);
    if (!next) {
      break;
    }
    result.push(next);
    cursor = next.dueAt;
  }
  return result;
}

export function isWithinQuietHours(
  instant: Date,
  timezone: string,
  quietHours: QuietHours,
): boolean {
  assertTimezone(timezone);
  assertInstant(instant, "Instant");
  const { hour: startHour, minute: startMinute } = parseLocalTime(quietHours.startLocal);
  const { hour: endHour, minute: endMinute } = parseLocalTime(quietHours.endLocal);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) {
    return false;
  }

  const local = DateTime.fromJSDate(instant, { zone: timezone });
  const current = local.hour * 60 + local.minute;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function adjustForQuietHours(
  instant: Date,
  timezone: string,
  quietHours: QuietHours,
  ignoreQuietHours = false,
): Date {
  assertInstant(instant, "Instant");
  assertTimezone(timezone);
  if (ignoreQuietHours || !isWithinQuietHours(instant, timezone, quietHours)) {
    return instant;
  }

  const local = DateTime.fromJSDate(instant, { zone: timezone });
  const { hour: startHour, minute: startMinute } = parseLocalTime(quietHours.startLocal);
  const { hour: endHour, minute: endMinute } = parseLocalTime(quietHours.endLocal);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const current = local.hour * 60 + local.minute;
  const wakeDate = start < end || current < end ? local : local.plus({ days: 1 });

  return wakeDate
    .set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 })
    .toJSDate();
}

export function calculateFirstNotificationAt(
  deadline: ScheduledDeadline,
  leadMinutes: number,
  timezone: string,
  quietHours: QuietHours,
  options: { ignoreQuietHours?: boolean; notBefore?: Date } = {},
): Date {
  assertInstant(deadline.notificationAnchorAt, "Notification anchor");
  if (options.notBefore) {
    assertInstant(options.notBefore, "Not-before instant");
  }
  if (!Number.isInteger(leadMinutes) || leadMinutes < 0) {
    throw new Error("Lead time must be a non-negative integer number of minutes");
  }

  const desired = DateTime.fromJSDate(deadline.notificationAnchorAt)
    .minus({ minutes: leadMinutes })
    .toJSDate();
  const candidate = options.notBefore && desired < options.notBefore ? options.notBefore : desired;
  return adjustForQuietHours(candidate, timezone, quietHours, options.ignoreQuietHours);
}

export function calculateNextNotificationAt(
  deliveredAt: Date,
  repeatIntervalMinutes: number,
  timezone: string,
  quietHours: QuietHours,
  ignoreQuietHours = false,
): Date {
  assertInstant(deliveredAt, "Delivery instant");
  if (!Number.isInteger(repeatIntervalMinutes) || repeatIntervalMinutes < 15) {
    throw new Error("Repeat interval must be at least 15 whole minutes");
  }

  const desired = DateTime.fromJSDate(deliveredAt)
    .plus({ minutes: repeatIntervalMinutes })
    .toJSDate();
  return adjustForQuietHours(desired, timezone, quietHours, ignoreQuietHours);
}

export function calculateSnoozedNotificationAt(
  requestedAt: Date,
  reference: Date,
  timezone: string,
  quietHours: QuietHours,
  ignoreQuietHours = false,
): Date {
  assertInstant(requestedAt, "Requested snooze instant");
  assertInstant(reference, "Reference");
  if (requestedAt <= reference) {
    throw new Error("Snooze instant must be in the future");
  }
  return adjustForQuietHours(requestedAt, timezone, quietHours, ignoreQuietHours);
}

export function calculateFirstEscalationAt(
  dueAt: Date,
  delayMinutes: number,
  timezone: string,
  quietHours: QuietHours,
  ignoreQuietHours = false,
): Date {
  assertInstant(dueAt, "Due instant");
  if (!Number.isInteger(delayMinutes) || delayMinutes < 0) {
    throw new Error("Escalation delay must be a non-negative integer number of minutes");
  }

  const desired = DateTime.fromJSDate(dueAt).plus({ minutes: delayMinutes }).toJSDate();
  return adjustForQuietHours(desired, timezone, quietHours, ignoreQuietHours);
}

export function calculateNextEscalationAt(
  escalatedAt: Date,
  repeatIntervalMinutes: number,
  timezone: string,
  quietHours: QuietHours,
  ignoreQuietHours = false,
): Date {
  assertInstant(escalatedAt, "Escalation instant");
  if (!Number.isInteger(repeatIntervalMinutes) || repeatIntervalMinutes < 60) {
    throw new Error("Escalation repeat interval must be at least 60 whole minutes");
  }

  const desired = DateTime.fromJSDate(escalatedAt)
    .plus({ minutes: repeatIntervalMinutes })
    .toJSDate();
  return adjustForQuietHours(desired, timezone, quietHours, ignoreQuietHours);
}
