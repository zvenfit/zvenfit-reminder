import { describe, expect, it } from "vitest";
import {
  buildTimezoneOptions,
  describeTimezone,
  formatTimezoneOffset,
} from "./timezones";

describe("timezone presentation", () => {
  it("shows a friendly Moscow label and local wall-clock time", () => {
    const instant = new Date("2026-01-15T12:34:00.000Z");

    expect(describeTimezone("Europe/Moscow", instant)).toMatchObject({
      city: "Москва",
      region: "Европа",
      offset: "UTC+3",
      localTime: "15:34",
      optionLabel: "Москва · UTC+3 · Европа",
    });
  });

  it("uses the current offset for daylight-saving timezones", () => {
    expect(formatTimezoneOffset("America/New_York", new Date("2026-01-15T12:00:00.000Z")))
      .toBe("UTC−5");
    expect(formatTimezoneOffset("America/New_York", new Date("2026-07-15T12:00:00.000Z")))
      .toBe("UTC−4");
    expect(formatTimezoneOffset("Asia/Calcutta", new Date("2026-01-15T12:00:00.000Z")))
      .toBe("UTC+5:30");
  });

  it("includes worldwide IANA options and rejects invalid identifiers", () => {
    const options = buildTimezoneOptions(new Date("2026-01-15T12:00:00.000Z"));

    expect(options[0]?.id).toBe("Europe/Moscow");
    expect(options.some((option) => option.id === "Europe/Moscow")).toBe(true);
    expect(options.some((option) => option.id === "America/New_York")).toBe(true);
    expect(options.length).toBeGreaterThan(20);
    expect(describeTimezone("Mars/Olympus_Mons")).toBeNull();
  });
});
