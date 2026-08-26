function normalizeRussianDateLabel(value: string): string {
  return value.replace(/\s+г\./gu, "").replace(/,\s*/gu, " · ");
}

function roundedDurationLabel(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(value: Date, timezone: string): ZonedParts {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function localDateTimeToInstant(
  localDate: string,
  localTime: string,
  timezone: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!dateMatch || !timeMatch) return null;
  const target = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  let candidate = new Date(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(candidate, timezone);
    const observedWallTime = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const correction = target - observedWallTime;
    if (correction === 0) break;
    candidate = new Date(candidate.getTime() + correction);
  }
  const resolved = zonedParts(candidate, timezone);
  const resolvedDate = `${String(resolved.year).padStart(4, "0")}-${String(resolved.month).padStart(2, "0")}-${String(resolved.day).padStart(2, "0")}`;
  const resolvedTime = `${String(resolved.hour).padStart(2, "0")}:${String(resolved.minute).padStart(2, "0")}`;
  return resolvedDate === localDate && resolvedTime === localTime ? candidate : null;
}

function offsetLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days, 12));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function firstValidInstantAtOrAfter(
  localDate: string,
  localTime: string,
  timezone: string,
): Date | null {
  const [hour, minute] = localTime.split(":").map(Number);
  const [year, month, day] = localDate.split("-").map(Number);
  const wallTime = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  for (let offset = 0; offset <= 24 * 60; offset += 1) {
    const candidate = new Date(wallTime + offset * 60_000);
    const candidateDate = `${String(candidate.getUTCFullYear()).padStart(4, "0")}-${String(candidate.getUTCMonth() + 1).padStart(2, "0")}-${String(candidate.getUTCDate()).padStart(2, "0")}`;
    const candidateTime = `${String(candidate.getUTCHours()).padStart(2, "0")}:${String(candidate.getUTCMinutes()).padStart(2, "0")}`;
    const instant = localDateTimeToInstant(candidateDate, candidateTime, timezone);
    if (instant) return instant;
  }
  return null;
}

function adjustForQuietHours(
  instant: Date,
  timezone: string,
  quietHoursStart: string,
  quietHoursEnd: string,
  ignoreQuietHours: boolean,
): Date {
  if (ignoreQuietHours || quietHoursStart === quietHoursEnd) return instant;
  const [startHour, startMinute] = quietHoursStart.split(":").map(Number);
  const [endHour, endMinute] = quietHoursEnd.split(":").map(Number);
  const start = (startHour ?? 0) * 60 + (startMinute ?? 0);
  const end = (endHour ?? 0) * 60 + (endMinute ?? 0);
  const local = zonedParts(instant, timezone);
  const current = local.hour * 60 + local.minute;
  const isQuiet = start < end
    ? current >= start && current < end
    : current >= start || current < end;
  if (!isQuiet) return instant;

  const localDate = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const wakeDate = start < end || current < end ? localDate : offsetLocalDate(localDate, 1);
  return firstValidInstantAtOrAfter(wakeDate, quietHoursEnd, timezone) ?? instant;
}

function exactSignalLabel(value: Date, timezone: string): string {
  return normalizeRussianDateLabel(new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(value));
}

export function leadNotificationLabel(
  minutes: number,
  options: { allDay?: boolean; allDayAnchorTime?: string } = {},
): string {
  const knownLabels: Record<number, string> = {
    0: "В момент срока",
    60: "За 1 час до срока",
    1_440: "За 1 день до срока",
    10_080: "За 1 неделю до срока",
  };
  if (!options.allDay) {
    return knownLabels[minutes] ?? `За ${roundedDurationLabel(minutes * 60_000)} до срока`;
  }

  const anchorTime = options.allDayAnchorTime ?? "09:00";
  const [anchorHour = 9, anchorMinute = 0] = anchorTime.split(":").map(Number);
  const shiftedMinutes = anchorHour * 60 + anchorMinute - minutes;
  const dayOffset = Math.floor(shiftedMinutes / (24 * 60));
  const minuteOfDay = ((shiftedMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const signalTime = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(
    minuteOfDay % 60,
  ).padStart(2, "0")}`;

  if (dayOffset === 0) return `В день срока, в ${signalTime}`;
  if (dayOffset === -1) return `За 1 день до срока, в ${signalTime}`;
  if (dayOffset === -7) return `За 1 неделю до срока, в ${signalTime}`;
  return `За ${Math.abs(dayOffset)} дн до срока, в ${signalTime}`;
}

export function repeatNotificationLabel(minutes: number): string {
  const knownLabels: Record<number, string> = {
    60: "Каждый час",
    180: "Каждые 3 часа",
    360: "Каждые 6 часов",
    720: "Каждые 12 часов",
    1_440: "Раз в день",
  };
  return knownLabels[minutes] ?? `Каждые ${roundedDurationLabel(minutes * 60_000)}`;
}

export interface FirstSignalPresentation {
  label: string;
  effectiveAt: string | null;
  clampedToNow: boolean;
  adjustedForQuietHours: boolean;
}

export function firstSignalPresentation({
  dueLocalDate,
  notificationTimeLocal,
  leadMinutes,
  timezone,
  quietHoursStart,
  quietHoursEnd,
  ignoreQuietHours,
  allDay = false,
  now,
}: {
  dueLocalDate: string;
  notificationTimeLocal: string;
  leadMinutes: number;
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  ignoreQuietHours: boolean;
  allDay?: boolean;
  now: Date;
}): FirstSignalPresentation {
  const requestedLabel = leadNotificationLabel(leadMinutes, {
    allDay,
    allDayAnchorTime: notificationTimeLocal,
  });
  const anchor = localDateTimeToInstant(dueLocalDate, notificationTimeLocal, timezone);
  if (!anchor || !Number.isInteger(leadMinutes) || leadMinutes < 0) {
    return {
      label: requestedLabel,
      effectiveAt: null,
      clampedToNow: false,
      adjustedForQuietHours: false,
    };
  }

  const desired = new Date(anchor.getTime() - leadMinutes * 60_000);
  const clampedToNow = desired.getTime() < now.getTime();
  const candidate = clampedToNow ? now : desired;
  const effective = adjustForQuietHours(
    candidate,
    timezone,
    quietHoursStart,
    quietHoursEnd,
    ignoreQuietHours,
  );
  const adjustedForQuietHours = effective.getTime() !== candidate.getTime();
  const exact = exactSignalLabel(effective, timezone);
  const label = clampedToNow
    ? adjustedForQuietHours
      ? `Выбранное время уже прошло · первый сигнал после тихих часов, ${exact}`
      : "Сразу после сохранения · выбранное время уже прошло"
    : adjustedForQuietHours
      ? `${requestedLabel} · перенесено на ${exact}`
      : requestedLabel;

  return {
    label,
    effectiveAt: effective.toISOString(),
    clampedToNow,
    adjustedForQuietHours,
  };
}

const CANCELLATION_REASON_LABELS: Record<string, string> = {
  reminder_archived: "Серия архивирована",
  missed_while_paused: "Срок наступил, пока серия была на паузе",
};

export function cancellationReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return CANCELLATION_REASON_LABELS[reason] ?? reason;
}

export interface NextSignalPresentation {
  exact: string;
  relative: string;
}

export function nextSignalPresentation(
  value: string,
  timezone: string,
  now: Date = new Date(),
): NextSignalPresentation | null {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;

  const exact = normalizeRussianDateLabel(new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(instant));
  const remaining = instant.getTime() - now.getTime();

  return {
    exact,
    relative: remaining <= 0 ? "Ожидает отправки" : `Через ${roundedDurationLabel(remaining)}`,
  };
}
