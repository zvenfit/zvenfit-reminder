import type { ReminderOccurrence, SnoozePreset, SnoozeSelection } from "./api";

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface SnoozePresetOption {
  preset: SnoozePreset;
  title: string;
  absoluteLabel: string;
  previewLocalDate: string;
  selection: SnoozeSelection;
}

export interface CustomSnoozeDraft {
  localDate: string;
  localTime: string;
  minDate: string;
  maxDate: string;
}

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const EVENING_TIME = "18:00";
const DEFAULT_MORNING_TIME = "09:00";
const MINIMUM_SNOOZE_SECONDS = 15 * 60;
const CUSTOM_ROUNDING_MINUTES = 15;
const ONE_HOUR_MILLISECONDS = 60 * 60 * 1_000;
const MAX_LOCAL_GAP_SEARCH_MINUTES = 24 * 60;
const OFFSET_DISCOVERY_WINDOW_HOURS = 36;

function dateKey(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function timeLabel(parts: Pick<ZonedParts, "hour" | "minute">): string {
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function zonedParts(value: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetCalendarDate(
  parts: Pick<ZonedParts, "year" | "month" | "day">,
  days: number,
): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function normalizedMorningTime(value: string): string {
  return LOCAL_TIME_PATTERN.test(value) ? value : DEFAULT_MORNING_TIME;
}

function localDateTimeToInstant(
  localDate: string,
  localTime: string,
  timezone: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dateMatch || !LOCAL_TIME_PATTERN.test(localTime)) return null;
  const [hour, minute] = localTime.split(":").map(Number);
  const targetParts = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: hour ?? 0,
    minute: minute ?? 0,
  };
  const targetWallTime = Date.UTC(
    targetParts.year,
    targetParts.month - 1,
    targetParts.day,
    targetParts.hour,
    targetParts.minute,
  );
  let candidate = new Date(targetWallTime);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(candidate, timezone);
    const observedWallTime = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const correction = targetWallTime - observedWallTime;
    if (correction === 0) break;
    candidate = new Date(candidate.getTime() + correction);
  }
  const resolved = zonedParts(candidate, timezone);
  return dateKey(resolved) === localDate && timeLabel(resolved) === localTime
    ? candidate
    : null;
}

function possibleLocalDateTimeInstants(
  localDate: string,
  localTime: string,
  timezone: string,
): Date[] {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dateMatch || !LOCAL_TIME_PATTERN.test(localTime)) return [];
  const [hour, minute] = localTime.split(":").map(Number);
  const targetWallTime = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hour ?? 0,
    minute ?? 0,
  );
  const offsets = new Set<number>();
  for (
    let offsetHours = -OFFSET_DISCOVERY_WINDOW_HOURS;
    offsetHours <= OFFSET_DISCOVERY_WINDOW_HOURS;
    offsetHours += 3
  ) {
    const sample = new Date(targetWallTime + offsetHours * 60 * 60 * 1_000);
    const observed = zonedParts(sample, timezone);
    offsets.add(Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    ) - sample.getTime());
  }

  return Array.from(offsets, (offset) => new Date(targetWallTime - offset))
    .filter((candidate) => {
      const observed = zonedParts(candidate, timezone);
      return dateKey(observed) === localDate && timeLabel(observed) === localTime;
    })
    .filter((candidate, index, candidates) =>
      candidates.findIndex((value) => value.getTime() === candidate.getTime()) === index)
    .sort((left, right) => left.getTime() - right.getTime());
}

function localDateTimeToUniqueInstant(
  localDate: string,
  localTime: string,
  timezone: string,
): Date | null {
  const candidates = possibleLocalDateTimeInstants(localDate, localTime, timezone);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function nextValidLocalDateTime(
  localDate: string,
  localTime: string,
  timezone: string,
): { instant: Date; localDate: string; localTime: string } | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dateMatch || !LOCAL_TIME_PATTERN.test(localTime)) return null;
  const [hour, minute] = localTime.split(":").map(Number);
  const targetWallTime = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hour ?? 0,
    minute ?? 0,
  );
  for (let offsetMinutes = 0; offsetMinutes <= MAX_LOCAL_GAP_SEARCH_MINUTES; offsetMinutes += 1) {
    const candidate = new Date(targetWallTime + offsetMinutes * 60 * 1_000);
    const candidateDate = [
      candidate.getUTCFullYear(),
      String(candidate.getUTCMonth() + 1).padStart(2, "0"),
      String(candidate.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const candidateTime = `${String(candidate.getUTCHours()).padStart(2, "0")}:${String(
      candidate.getUTCMinutes(),
    ).padStart(2, "0")}`;
    const instant = localDateTimeToInstant(candidateDate, candidateTime, timezone);
    if (instant) {
      return { instant, localDate: candidateDate, localTime: candidateTime };
    }
  }
  return null;
}

function nextUnambiguousLocalDateTime(
  localDate: string,
  localTime: string,
  timezone: string,
): { instant: Date; localDate: string; localTime: string } | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dateMatch || !LOCAL_TIME_PATTERN.test(localTime)) return null;
  const [hour, minute] = localTime.split(":").map(Number);
  const targetWallTime = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hour ?? 0,
    minute ?? 0,
  );
  for (let offsetMinutes = 0; offsetMinutes <= MAX_LOCAL_GAP_SEARCH_MINUTES; offsetMinutes += 1) {
    const candidate = new Date(targetWallTime + offsetMinutes * 60 * 1_000);
    const candidateDate = [
      candidate.getUTCFullYear(),
      String(candidate.getUTCMonth() + 1).padStart(2, "0"),
      String(candidate.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const candidateTime = `${String(candidate.getUTCHours()).padStart(2, "0")}:${String(
      candidate.getUTCMinutes(),
    ).padStart(2, "0")}`;
    const instant = localDateTimeToUniqueInstant(candidateDate, candidateTime, timezone);
    if (instant) {
      return { instant, localDate: candidateDate, localTime: candidateTime };
    }
  }
  return null;
}

function validCalendarDate(value: string | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const candidate = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  ));
  return candidate.getUTCFullYear() === Number(match[1]) &&
    candidate.getUTCMonth() + 1 === Number(match[2]) &&
    candidate.getUTCDate() === Number(match[3])
    ? value ?? null
    : null;
}

function calendarDateLabel(localDate: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T12:00:00.000Z`)).replace(/\u00a0/gu, " ");
}

function relativeDateTimeLabel(localDate: string, localTime: string, today: string): string {
  const todayParts = today.split("-").map(Number);
  const tomorrow = offsetCalendarDate({
    year: todayParts[0] ?? 0,
    month: todayParts[1] ?? 1,
    day: todayParts[2] ?? 1,
  }, 1);
  if (localDate === today) return `сегодня, ${localTime}`;
  if (localDate === tomorrow) return `завтра, ${localTime}`;
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(new Date(`${localDate}T12:00:00Z`));
  return `${formatted}, ${localTime}`;
}

export function buildSnoozePresetOptions({
  now,
  timezone,
  morningTime,
}: {
  now: Date;
  timezone: string;
  morningTime: string;
}): SnoozePresetOption[] {
  const localNow = zonedParts(now, timezone);
  const today = dateKey(localNow);
  const inOneHour = zonedParts(new Date(now.getTime() + ONE_HOUR_MILLISECONDS), timezone);
  const options: SnoozePresetOption[] = [{
    preset: "one_hour",
    title: "Через час",
    absoluteLabel: relativeDateTimeLabel(dateKey(inOneHour), timeLabel(inOneHour), today),
    previewLocalDate: dateKey(inOneHour),
    selection: { type: "preset", preset: "one_hour" },
  }];

  const evening = nextValidLocalDateTime(today, EVENING_TIME, timezone);
  if (evening && evening.instant.getTime() - now.getTime() >= MINIMUM_SNOOZE_SECONDS * 1_000) {
    options.push({
      preset: "evening",
      title: "Сегодня вечером",
      absoluteLabel: relativeDateTimeLabel(evening.localDate, evening.localTime, today),
      previewLocalDate: evening.localDate,
      selection: { type: "preset", preset: "evening" },
    });
  }

  const tomorrow = offsetCalendarDate(localNow, 1);
  const tomorrowMorning = normalizedMorningTime(morningTime);
  const morning = nextValidLocalDateTime(tomorrow, tomorrowMorning, timezone);
  if (morning) {
    options.push({
      preset: "tomorrow_morning",
      title: "Завтра утром",
      absoluteLabel: relativeDateTimeLabel(morning.localDate, morning.localTime, today),
      previewLocalDate: morning.localDate,
      selection: { type: "preset", preset: "tomorrow_morning" },
    });
  }
  return options;
}

export function buildCustomSnoozeDraft(
  now: Date,
  timezone: string,
): CustomSnoozeDraft {
  const localNow = zonedParts(now, timezone);
  const suggested = zonedParts(new Date(now.getTime() + ONE_HOUR_MILLISECONDS), timezone);
  const pseudoLocalMilliseconds = Date.UTC(
    suggested.year,
    suggested.month - 1,
    suggested.day,
    suggested.hour,
    suggested.minute,
    suggested.second,
  );
  const roundingMilliseconds = CUSTOM_ROUNDING_MINUTES * 60 * 1_000;
  const rounded = new Date(
    Math.ceil(pseudoLocalMilliseconds / roundingMilliseconds) * roundingMilliseconds,
  );
  const roundedLocalDate = [
    rounded.getUTCFullYear(),
    String(rounded.getUTCMonth() + 1).padStart(2, "0"),
    String(rounded.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const roundedLocalTime = `${String(rounded.getUTCHours()).padStart(2, "0")}:${String(
    rounded.getUTCMinutes(),
  ).padStart(2, "0")}`;
  const suggestedCustomTime = nextUnambiguousLocalDateTime(
    roundedLocalDate,
    roundedLocalTime,
    timezone,
  );
  return {
    localDate: suggestedCustomTime?.localDate ?? roundedLocalDate,
    localTime: suggestedCustomTime?.localTime ?? roundedLocalTime,
    minDate: dateKey(localNow),
    maxDate: offsetCalendarDate(localNow, 30),
  };
}

export function formatSnoozeDeadline(
  occurrence: Pick<ReminderOccurrence, "allDay" | "dueAt" | "dueLocalDate" | "timezone">,
): string {
  const dueInstant = new Date(occurrence.dueAt);
  const hasValidInstant = Number.isFinite(dueInstant.getTime());
  const localDate = occurrence.allDay
    ? validCalendarDate(occurrence.dueLocalDate) ??
      (hasValidInstant ? dateKey(zonedParts(dueInstant, occurrence.timezone)) : null)
    : hasValidInstant
      ? dateKey(zonedParts(dueInstant, occurrence.timezone))
      : null;
  if (!localDate) return "по прежнему плану";
  if (occurrence.allDay) return `${calendarDateLabel(localDate)} · весь день`;
  const localDue = zonedParts(dueInstant, occurrence.timezone);
  return `${calendarDateLabel(localDate)} · ${timeLabel(localDue)}`;
}

export function snoozeQuietHoursHint({
  ignoreQuietHours,
  quietHoursStart,
  quietHoursEnd,
}: {
  ignoreQuietHours?: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}): string {
  if (quietHoursStart === quietHoursEnd) {
    return "Тихие часы выключены и не сдвинут сигнал.";
  }
  if (ignoreQuietHours) {
    return "Для этой задачи разрешена доставка в тихие часы — они не сдвинут сигнал.";
  }
  return `Если время попадёт в тихие часы ${quietHoursStart}–${quietHoursEnd}, сигнал придёт после их окончания.`;
}

export function resolveSnoozeSelectionForPreview(
  selection: SnoozeSelection,
  {
    now,
    timezone,
    morningTime,
  }: {
    now: Date;
    timezone: string;
    morningTime: string;
  },
): Date | null {
  if (selection.type === "custom") {
    return localDateTimeToUniqueInstant(selection.localDate, selection.localTime, timezone);
  }
  if (selection.preset === "one_hour") {
    return new Date(now.getTime() + ONE_HOUR_MILLISECONDS);
  }
  const localNow = zonedParts(now, timezone);
  if (selection.preset === "tomorrow_morning") {
    return nextValidLocalDateTime(
      offsetCalendarDate(localNow, 1),
      normalizedMorningTime(morningTime),
      timezone,
    )?.instant ?? null;
  }
  const today = dateKey(localNow);
  const todayEvening = nextValidLocalDateTime(today, EVENING_TIME, timezone)?.instant ?? null;
  const minimum = now.getTime() + MINIMUM_SNOOZE_SECONDS * 1_000;
  if (todayEvening && todayEvening.getTime() >= minimum) return todayEvening;
  return nextValidLocalDateTime(
    offsetCalendarDate(localNow, 1),
    EVENING_TIME,
    timezone,
  )?.instant ?? null;
}

export function formatSnoozeInstant(
  value: string,
  timezone: string,
  reference = new Date(),
): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "позже";
  const local = zonedParts(instant, timezone);
  const today = dateKey(zonedParts(reference, timezone));
  return relativeDateTimeLabel(dateKey(local), timeLabel(local), today);
}
