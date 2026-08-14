export const DEFAULT_TIMEZONE = "Europe/Moscow";

export interface TimezonePresentation {
  id: string;
  city: string;
  region: string;
  offset: string;
  offsetMinutes: number;
  localTime: string;
  optionLabel: string;
}

const FALLBACK_TIMEZONES = [
  DEFAULT_TIMEZONE,
  "Europe/Kaliningrad",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "Europe/Minsk",
  "Europe/Berlin",
  "Europe/London",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Almaty",
  "Asia/Tashkent",
  "Asia/Dubai",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

const FEATURED_TIMEZONE_ORDER = new Map(
  FALLBACK_TIMEZONES.map((timezone, index) => [timezone, index]),
);

const CITY_NAMES: Record<string, string> = {
  UTC: "Всемирное время",
  Kaliningrad: "Калининград",
  Moscow: "Москва",
  Samara: "Самара",
  Yekaterinburg: "Екатеринбург",
  Omsk: "Омск",
  Novosibirsk: "Новосибирск",
  Krasnoyarsk: "Красноярск",
  Irkutsk: "Иркутск",
  Yakutsk: "Якутск",
  Vladivostok: "Владивосток",
  Magadan: "Магадан",
  Kamchatka: "Камчатка",
  Minsk: "Минск",
  Berlin: "Берлин",
  London: "Лондон",
  Tbilisi: "Тбилиси",
  Yerevan: "Ереван",
  Almaty: "Алматы",
  Tashkent: "Ташкент",
  Dubai: "Дубай",
  Istanbul: "Стамбул",
  Tokyo: "Токио",
  Shanghai: "Шанхай",
  New_York: "Нью-Йорк",
  Los_Angeles: "Лос-Анджелес",
};

const REGION_NAMES: Record<string, string> = {
  UTC: "Без привязки к городу",
  Africa: "Африка",
  America: "Америка",
  Antarctica: "Антарктида",
  Arctic: "Арктика",
  Asia: "Азия",
  Atlantic: "Атлантика",
  Australia: "Австралия",
  Europe: "Европа",
  Indian: "Индийский океан",
  Pacific: "Тихий океан",
};

type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

function supportedTimezoneIds(): string[] {
  let runtimeTimezones: string[] = [];
  try {
    runtimeTimezones = (Intl as IntlWithSupportedValues).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    runtimeTimezones = [];
  }
  return [...new Set([...FALLBACK_TIMEZONES, ...runtimeTimezones])];
}

function timezoneLocation(timezone: string): { city: string; region: string } {
  if (timezone === "UTC") {
    return { city: CITY_NAMES.UTC, region: REGION_NAMES.UTC };
  }
  const parts = timezone.split("/");
  const rawRegion = parts[0] ?? timezone;
  const rawCity = parts.at(-1) ?? timezone;
  return {
    city: CITY_NAMES[rawCity] ?? rawCity.replaceAll("_", " "),
    region: REGION_NAMES[rawRegion] ?? rawRegion.replaceAll("_", " "),
  };
}

function timezoneOffsetMinutes(timezone: string, instant: Date): number {
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
  if (!offsetPart || offsetPart === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offsetPart);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function formatOffsetMinutes(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "−" : "+";
  const absoluteMinutes = Math.abs(minutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const remainder = absoluteMinutes % 60;
  return `UTC${sign}${hours}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
}

export function formatTimezoneOffset(timezone: string, instant = new Date()): string {
  return formatOffsetMinutes(timezoneOffsetMinutes(timezone, instant));
}

export function describeTimezone(
  timezone: string,
  instant = new Date(),
): TimezonePresentation | null {
  try {
    const { city, region } = timezoneLocation(timezone);
    const offsetMinutes = timezoneOffsetMinutes(timezone, instant);
    const offset = formatOffsetMinutes(offsetMinutes);
    const localTime = new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(instant);
    return {
      id: timezone,
      city,
      region,
      offset,
      offsetMinutes,
      localTime,
      optionLabel: `${city} · ${offset} · ${region}`,
    };
  } catch {
    return null;
  }
}

export function buildTimezoneOptions(instant = new Date()): TimezonePresentation[] {
  const options = supportedTimezoneIds()
    .map((timezone) => describeTimezone(timezone, instant))
    .filter((timezone): timezone is TimezonePresentation => timezone !== null);
  return options.sort((left, right) => {
    const leftFeaturedIndex = FEATURED_TIMEZONE_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightFeaturedIndex = FEATURED_TIMEZONE_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    const featuredDifference = leftFeaturedIndex - rightFeaturedIndex;
    if (featuredDifference !== 0) return featuredDifference;
    const offsetDifference = left.offsetMinutes - right.offsetMinutes;
    if (offsetDifference !== 0) return offsetDifference;
    return left.city.localeCompare(right.city, "ru");
  });
}

export function detectDeviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
}
