import { describe, expect, it } from "vitest";
import type { ScheduleSpec } from "./reminder-domain.js";
import {
  adjustForQuietHours,
  calculateFirstEscalationAt,
  calculateFirstNotificationAt,
  calculateNextEscalationAt,
  calculateNextNotificationAt,
  calculateSnoozedNotificationAt,
  getNextScheduledDeadline,
  isWithinQuietHours,
  previewScheduledDeadlines,
} from "./reminder-scheduling.js";

const quietHours = { startLocal: "22:00", endLocal: "08:00" };

describe("getNextScheduledDeadline", () => {
  it("converts a one-off local deadline to an instant", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "once",
        date: "2026-08-25",
        timing: { kind: "timed", timeLocal: "18:00" },
      },
      "Europe/Moscow",
      new Date("2026-08-20T00:00:00.000Z"),
    );

    expect(result?.dueAt.toISOString()).toBe("2026-08-25T15:00:00.000Z");
    expect(result?.notificationAnchorAt.toISOString()).toBe("2026-08-25T15:00:00.000Z");
    expect(result?.allDay).toBe(false);
  });

  it("returns null for a past one-off deadline", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "once",
        date: "2026-08-20",
        timing: { kind: "timed", timeLocal: "18:00" },
      },
      "Europe/Moscow",
      new Date("2026-08-20T16:00:00.000Z"),
    );

    expect(result).toBeNull();
  });

  it("uses 09:00 for all-day notification and end of day for overdue state", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "once",
        date: "2026-08-25",
        timing: { kind: "allDay" },
      },
      "Europe/Moscow",
      new Date("2026-08-20T00:00:00.000Z"),
    );

    expect(result?.notificationAnchorAt.toISOString()).toBe("2026-08-25T06:00:00.000Z");
    expect(result?.dueAt.toISOString()).toBe("2026-08-25T20:59:59.999Z");
    expect(result?.allDay).toBe(true);
  });

  it("calculates an every-two-days schedule from its anchor", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "daily",
        startDate: "2026-08-10",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 2,
      },
      "Europe/Moscow",
      new Date("2026-08-11T12:00:00.000Z"),
    );

    expect(result?.dueLocalDate).toBe("2026-08-12");
  });

  it("skips inactive weeks for interval schedules", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "weekly",
        startDate: "2026-08-10",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 2,
        weekdays: [1, 4],
      },
      "Europe/Moscow",
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(result?.dueLocalDate).toBe("2026-08-24");
  });

  it("uses the next recurrence after today's scheduled time", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "monthly",
        startDate: "2026-01-01",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 1,
        day: { type: "dayOfMonth", value: 13, overflow: "lastDay" },
      },
      "Europe/Moscow",
      new Date("2026-08-13T07:00:00.000Z"),
    );

    expect(result?.dueLocalDate).toBe("2026-09-13");
  });

  it("selects the first schedule date after a long-overdue occurrence closes", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "monthly",
        startDate: "2026-01-01",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 1,
        day: { type: "dayOfMonth", value: 25, overflow: "lastDay" },
      },
      "Europe/Moscow",
      new Date("2026-09-27T12:00:00.000Z"),
    );

    expect(result?.dueLocalDate).toBe("2026-10-25");
  });

  it("anchors every-N-month schedules to their start month", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "monthly",
        startDate: "2026-01-01",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 3,
        day: { type: "dayOfMonth", value: 15, overflow: "lastDay" },
      },
      "Europe/Moscow",
      new Date("2026-05-01T00:00:00.000Z"),
    );

    expect(result?.dueLocalDate).toBe("2026-07-15");
  });
});

describe("previewScheduledDeadlines", () => {
  it("clamps day 31 to the final day of shorter months", () => {
    const schedule: ScheduleSpec = {
      version: 1,
      frequency: "monthly",
      startDate: "2026-01-01",
      timing: { kind: "timed", timeLocal: "18:00" },
      interval: 1,
      day: { type: "dayOfMonth", value: 31, overflow: "lastDay" },
    };

    const dates = previewScheduledDeadlines(
      schedule,
      "Europe/Moscow",
      new Date("2026-08-01T00:00:00.000Z"),
      3,
    );

    expect(dates.map((item) => item.dueLocalDate)).toEqual([
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
    ]);
  });

  it("resolves 29 February to the last day in non-leap years", () => {
    const schedule: ScheduleSpec = {
      version: 1,
      frequency: "yearly",
      startDate: "2024-01-01",
      timing: { kind: "allDay" },
      interval: 1,
      month: 2,
      day: 29,
      overflow: "lastDay",
    };

    const dates = previewScheduledDeadlines(
      schedule,
      "Europe/Moscow",
      new Date("2026-03-01T00:00:00.000Z"),
      2,
    );

    expect(dates.map((item) => item.dueLocalDate)).toEqual(["2027-02-28", "2028-02-29"]);
  });

  it("preserves local wall time across daylight-saving changes", () => {
    const schedule: ScheduleSpec = {
      version: 1,
      frequency: "daily",
      startDate: "2026-03-28",
      timing: { kind: "timed", timeLocal: "09:00" },
      interval: 1,
    };

    const dates = previewScheduledDeadlines(
      schedule,
      "Europe/Berlin",
      new Date("2026-03-27T00:00:00.000Z"),
      3,
    );

    expect(dates.map((item) => item.dueAt.toISOString())).toEqual([
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
    ]);
  });

  it("moves a nonexistent local time forward through a daylight-saving gap", () => {
    const result = getNextScheduledDeadline(
      {
        version: 1,
        frequency: "daily",
        startDate: "2026-03-29",
        timing: { kind: "timed", timeLocal: "02:30" },
        interval: 1,
      },
      "Europe/Berlin",
      new Date("2026-03-28T12:00:00.000Z"),
    );

    expect(result?.dueAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("quiet hours", () => {
  it("recognizes both sides of a quiet period crossing midnight", () => {
    expect(
      isWithinQuietHours(new Date("2026-08-25T20:00:00.000Z"), "Europe/Moscow", quietHours),
    ).toBe(true);
    expect(
      isWithinQuietHours(new Date("2026-08-26T02:00:00.000Z"), "Europe/Moscow", quietHours),
    ).toBe(true);
    expect(
      isWithinQuietHours(new Date("2026-08-26T05:00:00.000Z"), "Europe/Moscow", quietHours),
    ).toBe(false);
  });

  it("moves a late notification to 08:00 on the next local day", () => {
    const adjusted = adjustForQuietHours(
      new Date("2026-08-25T20:00:00.000Z"),
      "Europe/Moscow",
      quietHours,
    );

    expect(adjusted.toISOString()).toBe("2026-08-26T05:00:00.000Z");
  });

  it("treats equal quiet-hour boundaries as disabled", () => {
    expect(
      isWithinQuietHours(
        new Date("2026-08-25T20:00:00.000Z"),
        "Europe/Moscow",
        { startLocal: "08:00", endLocal: "08:00" },
      ),
    ).toBe(false);
  });
});

describe("notification timing", () => {
  const deadline = {
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    dueLocalDate: "2026-08-25",
    allDay: false,
    notificationAnchorAt: new Date("2026-08-25T15:00:00.000Z"),
  };

  it("starts in advance of the deadline", () => {
    const result = calculateFirstNotificationAt(
      deadline,
      24 * 60,
      "Europe/Moscow",
      quietHours,
    );

    expect(result.toISOString()).toBe("2026-08-24T15:00:00.000Z");
  });

  it("starts immediately after creation but still respects quiet hours", () => {
    const result = calculateFirstNotificationAt(
      deadline,
      24 * 60,
      "Europe/Moscow",
      quietHours,
      { notBefore: new Date("2026-08-24T21:00:00.000Z") },
    );

    expect(result.toISOString()).toBe("2026-08-25T05:00:00.000Z");
  });

  it("calculates the next interval from actual delivery and skips the night", () => {
    const result = calculateNextNotificationAt(
      new Date("2026-08-25T15:00:00.000Z"),
      6 * 60,
      "Europe/Moscow",
      quietHours,
    );

    expect(result.toISOString()).toBe("2026-08-26T05:00:00.000Z");
  });

  it("allows urgent reminders during quiet hours", () => {
    const result = calculateNextNotificationAt(
      new Date("2026-08-25T15:00:00.000Z"),
      6 * 60,
      "Europe/Moscow",
      quietHours,
      true,
    );

    expect(result.toISOString()).toBe("2026-08-25T21:00:00.000Z");
  });

  it("snoozes once without accepting a past instant", () => {
    const result = calculateSnoozedNotificationAt(
      new Date("2026-08-25T20:00:00.000Z"),
      new Date("2026-08-25T18:00:00.000Z"),
      "Europe/Moscow",
      quietHours,
    );

    expect(result.toISOString()).toBe("2026-08-26T05:00:00.000Z");
    expect(() =>
      calculateSnoozedNotificationAt(
        new Date("2026-08-25T17:00:00.000Z"),
        new Date("2026-08-25T18:00:00.000Z"),
        "Europe/Moscow",
        quietHours,
      ),
    ).toThrow("future");
  });

  it("starts escalation after 24 hours and repeats at most daily", () => {
    const first = calculateFirstEscalationAt(
      new Date("2026-08-25T15:00:00.000Z"),
      24 * 60,
      "Europe/Moscow",
      quietHours,
    );
    const next = calculateNextEscalationAt(
      first,
      24 * 60,
      "Europe/Moscow",
      quietHours,
    );

    expect(first.toISOString()).toBe("2026-08-26T15:00:00.000Z");
    expect(next.toISOString()).toBe("2026-08-27T15:00:00.000Z");
  });
});
