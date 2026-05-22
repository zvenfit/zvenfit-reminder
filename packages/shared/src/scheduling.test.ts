import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDER_GRACE_MINUTES,
  getCurrentRecurringDueAt,
  getEffectiveDayOfMonth,
  isOneoffDueNow,
  isRecurringDueNow,
  parseTimeLocal,
  shouldSendReminder,
} from "./scheduling.js";

describe("parseTimeLocal", () => {
  it("parses valid time", () => {
    expect(parseTimeLocal("09:30")).toEqual({ hour: 9, minute: 30 });
  });

  it("throws on invalid time", () => {
    expect(() => parseTimeLocal("25:00")).toThrow();
  });
});

describe("getEffectiveDayOfMonth", () => {
  it("clamps day 31 to last day of February", () => {
    expect(getEffectiveDayOfMonth(31, 2026, 2)).toBe(28);
  });

  it("keeps day when month has enough days", () => {
    expect(getEffectiveDayOfMonth(15, 2026, 3)).toBe(15);
  });
});

describe("shouldSendReminder", () => {
  it("allows retry within 24h grace period", () => {
    const dueAt = new Date("2026-05-05T06:00:00.000Z");
    const reference = new Date("2026-05-05T08:00:00.000Z");
    expect(shouldSendReminder(dueAt, reference, DEFAULT_REMINDER_GRACE_MINUTES)).toBe(true);
  });

  it("rejects reminders older than grace period", () => {
    const dueAt = new Date("2026-05-05T06:00:00.000Z");
    const reference = new Date("2026-05-06T07:00:00.000Z");
    expect(shouldSendReminder(dueAt, reference, DEFAULT_REMINDER_GRACE_MINUTES)).toBe(false);
  });
});

describe("getCurrentRecurringDueAt", () => {
  it("returns due date after scheduled time in current month", () => {
    const reference = new Date("2026-05-05T06:02:00.000Z");
    const result = getCurrentRecurringDueAt(5, "09:00", "Europe/Moscow", reference);
    expect(result?.periodKey).toBe("2026-05");
  });
});

describe("isRecurringDueNow", () => {
  it("returns due window within 5 minutes after scheduled time", () => {
    const reference = new Date("2026-05-05T06:02:00.000Z");
    const result = isRecurringDueNow(5, "09:00", "Europe/Moscow", reference, 5);
    expect(result).not.toBeNull();
    expect(result?.periodKey).toBe("2026-05");
  });

  it("returns null before scheduled time", () => {
    const reference = new Date("2026-05-05T05:00:00.000Z");
    expect(isRecurringDueNow(5, "09:00", "Europe/Moscow", reference, 5)).toBeNull();
  });
});

describe("isOneoffDueNow", () => {
  it("returns true within window", () => {
    const dueAt = new Date("2026-05-05T06:00:00.000Z");
    const reference = new Date("2026-05-05T06:03:00.000Z");
    expect(isOneoffDueNow(dueAt, reference, 5)).toBe(true);
  });

  it("returns false outside short window", () => {
    const dueAt = new Date("2026-05-05T06:00:00.000Z");
    const reference = new Date("2026-05-05T06:10:00.000Z");
    expect(isOneoffDueNow(dueAt, reference, 5)).toBe(false);
  });

  it("returns true within default grace period", () => {
    const dueAt = new Date("2026-05-05T06:00:00.000Z");
    const reference = new Date("2026-05-05T08:00:00.000Z");
    expect(isOneoffDueNow(dueAt, reference)).toBe(true);
  });
});
