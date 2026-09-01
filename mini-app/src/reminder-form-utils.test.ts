import { describe, expect, it } from "vitest";
import {
  intervalMetadataFor,
  isoWeekdayInTimezone,
  leadMinutesFromDraft,
  leadTimeDraftFromMinutes,
  leadTimeMaximum,
  localCalendarDate,
  maxValidYearlyDay,
} from "./reminder-form-utils";

describe("workspace-timezone form defaults", () => {
  it("resolves the local calendar date on opposite sides of midnight", () => {
    const reference = new Date("2026-08-30T21:30:00.000Z");

    expect(localCalendarDate(reference, "America/New_York")).toBe("2026-08-30");
    expect(localCalendarDate(reference, "Europe/Moscow")).toBe("2026-08-31");
  });

  it("applies day offsets as calendar days across a DST transition", () => {
    const beforeSpringForward = new Date("2026-03-08T06:30:00.000Z");

    expect(localCalendarDate(beforeSpringForward, "America/New_York", -1)).toBe("2026-03-07");
    expect(localCalendarDate(beforeSpringForward, "America/New_York")).toBe("2026-03-08");
    expect(localCalendarDate(beforeSpringForward, "America/New_York", 1)).toBe("2026-03-09");
  });

  it("uses the ISO weekday of the workspace rather than the device", () => {
    const reference = new Date("2026-08-30T22:30:00.000Z");

    expect(isoWeekdayInTimezone(reference, "America/New_York")).toBe(7);
    expect(isoWeekdayInTimezone(reference, "Europe/Moscow")).toBe(1);
  });
});

describe("calendar constraints", () => {
  it("allows February 29 for a yearly rule and respects shorter months", () => {
    expect(maxValidYearlyDay(2)).toBe(29);
    expect(maxValidYearlyDay(4)).toBe(30);
    expect(maxValidYearlyDay(12)).toBe(31);
  });

  it("rejects an invalid month", () => {
    expect(() => maxValidYearlyDay(0)).toThrow(RangeError);
    expect(() => maxValidYearlyDay(13)).toThrow(RangeError);
  });
});

describe("frequency interval metadata", () => {
  it("matches the backend limits and exposes Russian unit labels", () => {
    expect(intervalMetadataFor("daily")).toEqual({ min: 1, max: 365, unitLabel: "дней" });
    expect(intervalMetadataFor("weekly")).toEqual({ min: 1, max: 52, unitLabel: "недель" });
    expect(intervalMetadataFor("monthly")).toEqual({ min: 1, max: 120, unitLabel: "месяцев" });
    expect(intervalMetadataFor("yearly")).toEqual({ min: 1, max: 20, unitLabel: "лет" });
  });

  it("does not expose interval controls for a one-off deadline", () => {
    expect(intervalMetadataFor("once")).toBeNull();
  });
});

describe("first signal lead draft", () => {
  it("uses days for whole-day leads and hours for shorter leads", () => {
    expect(leadTimeDraftFromMinutes(10_080)).toEqual({ amount: "7", unit: "days" });
    expect(leadTimeDraftFromMinutes(720)).toEqual({ amount: "12", unit: "hours" });
    expect(leadTimeDraftFromMinutes(0)).toEqual({ amount: "0", unit: "hours" });
  });

  it("converts arbitrary hour and day amounts to integer minutes", () => {
    expect(leadMinutesFromDraft("36", "hours")).toBe(2_160);
    expect(leadMinutesFromDraft("5", "days")).toBe(7_200);
    expect(leadMinutesFromDraft("1.5", "hours")).toBe(90);
  });

  it("rejects empty, over-year, and sub-minute values", () => {
    expect(leadMinutesFromDraft("", "hours")).toBeNull();
    expect(leadMinutesFromDraft("366", "days")).toBeNull();
    expect(leadMinutesFromDraft("0.001", "hours")).toBeNull();
    expect(leadTimeMaximum("hours")).toBe(8_760);
    expect(leadTimeMaximum("days")).toBe(365);
  });
});
