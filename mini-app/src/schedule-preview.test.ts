import { describe, expect, it } from "vitest";
import { formatScheduleDate, upcomingScheduleDates } from "./schedule-preview";

const reference = new Date("2026-08-17T09:00:00.000Z");

describe("upcomingScheduleDates", () => {
  it("shows the next three weekly occurrences", () => {
    expect(upcomingScheduleDates({
      version: 1,
      frequency: "weekly",
      startDate: "2026-01-01",
      timing: { kind: "timed", timeLocal: "18:00" },
      interval: 1,
      weekdays: [1, 3],
    }, "Europe/Moscow", 3, reference)).toEqual([
      "2026-08-17",
      "2026-08-19",
      "2026-08-24",
    ]);
  });

  it("uses the last day when a monthly date does not exist", () => {
    expect(upcomingScheduleDates({
      version: 1,
      frequency: "monthly",
      startDate: "2026-01-01",
      timing: { kind: "allDay" },
      interval: 1,
      day: { type: "dayOfMonth", value: 31, overflow: "lastDay" },
    }, "Europe/Moscow", 3, reference)).toEqual([
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
    ]);
  });

  it("does not show a timed occurrence that already passed today", () => {
    expect(upcomingScheduleDates({
      version: 1,
      frequency: "daily",
      startDate: "2026-01-01",
      timing: { kind: "timed", timeLocal: "10:00" },
      interval: 1,
    }, "Europe/Moscow", 2, reference)).toEqual([
      "2026-08-18",
      "2026-08-19",
    ]);
  });

  it("keeps a far-future one-off deadline in the preview", () => {
    expect(upcomingScheduleDates({
      version: 1,
      frequency: "once",
      date: "2099-08-15",
      timing: { kind: "timed", timeLocal: "09:00" },
    }, "Europe/Moscow", 1, reference)).toEqual(["2099-08-15"]);
  });

  it("covers the full valid interval for sparse yearly schedules", () => {
    expect(upcomingScheduleDates({
      version: 1,
      frequency: "yearly",
      startDate: "2026-01-01",
      timing: { kind: "timed", timeLocal: "09:00" },
      interval: 20,
      month: 1,
      day: 1,
      overflow: "lastDay",
    }, "Europe/Moscow", 3, reference)).toEqual([
      "2046-01-01",
      "2066-01-01",
      "2086-01-01",
    ]);
  });
});

describe("formatScheduleDate", () => {
  it("uses one punctuation grammar and omits the Russian year suffix", () => {
    const label = formatScheduleDate("2099-08-15");
    expect(label).toContain(" · ");
    expect(label).toContain("2099");
    expect(label).not.toContain("г.");
    expect(label).not.toContain(",");
  });
});
