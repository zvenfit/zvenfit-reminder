import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATION_DELAY_MINUTES,
  DEFAULT_ESCALATION_REPEAT_MINUTES,
  DEFAULT_REPEAT_INTERVAL_MINUTES,
  occurrenceDraftUpdateSchema,
  reminderDraftSchema,
  reminderDraftUpdateSchema,
  scheduleSpecSchema,
  snoozeSelectionSchema,
} from "./reminder-domain.js";

const minimalDraft = {
  title: "Передать показания",
  assignment: { mode: "person" as const, responsibleUserId: 123 },
  schedule: {
    version: 1 as const,
    frequency: "once" as const,
    date: "2026-08-25",
    timing: { kind: "timed" as const, timeLocal: "18:00" },
  },
  timezone: "Europe/Moscow",
};

describe("reminderDraftSchema", () => {
  it("applies the product defaults", () => {
    const result = reminderDraftSchema.parse(minimalDraft);

    expect(result.kind).toBe("task");
    expect(result.visibility).toBe("group");
    expect(result.description).toBeNull();
    expect(result.watcherUserIds).toEqual([]);
    expect(result.notificationPolicy).toEqual({
      leadMinutes: 0,
      repeatIntervalMinutes: DEFAULT_REPEAT_INTERVAL_MINUTES,
      ignoreQuietHours: false,
      escalation: {
        enabled: true,
        delayMinutes: DEFAULT_ESCALATION_DELAY_MINUTES,
        repeatMinutes: DEFAULT_ESCALATION_REPEAT_MINUTES,
      },
    });
  });

  it("requires amount and currency together", () => {
    const result = reminderDraftSchema.safeParse({
      ...minimalDraft,
      amountMinor: 12_500_00,
    });

    expect(result.success).toBe(false);
  });

  it("infers a payment for legacy clients that send money without a kind", () => {
    const result = reminderDraftSchema.parse({
      ...minimalDraft,
      amountMinor: 89_000,
      currency: "RUB",
    });

    expect(result.kind).toBe("payment");
  });

  it("rejects anyone assignment for a private reminder", () => {
    const result = reminderDraftSchema.safeParse({
      ...minimalDraft,
      visibility: "private",
      assignment: { mode: "anyone" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects additional watchers for a private reminder", () => {
    const result = reminderDraftSchema.safeParse({
      ...minimalDraft,
      visibility: "private",
      watcherUserIds: [456],
    });

    expect(result.success).toBe(false);
  });

  it("accepts an optional HTTPS action and money in minor units", () => {
    const result = reminderDraftSchema.parse({
      ...minimalDraft,
      actionUrl: "https://example.com/pay",
      amountMinor: 1_250_000,
      currency: "RUB",
    });

    expect(result.amountMinor).toBe(1_250_000);
    expect(result.currency).toBe("RUB");
  });

  it("preserves payments without a known amount", () => {
    const result = reminderDraftSchema.parse({
      ...minimalDraft,
      kind: "payment",
    });

    expect(result.kind).toBe("payment");
    expect(result.amountMinor).toBeNull();
  });

  it("keeps kind absent in legacy update payloads", () => {
    const result = reminderDraftUpdateSchema.parse(minimalDraft);

    expect(result.kind).toBeUndefined();
  });

  it("accepts a nullable lead only for occurrence compatibility updates", () => {
    const input = {
      ...minimalDraft,
      notificationPolicy: {
        leadMinutes: null,
        repeatIntervalMinutes: 360,
        ignoreQuietHours: false,
        escalation: { enabled: false as const },
      },
    };

    expect(occurrenceDraftUpdateSchema.parse(input).notificationPolicy.leadMinutes)
      .toBeNull();
    expect(reminderDraftUpdateSchema.safeParse(input).success).toBe(false);
  });

  it("requires HTTPS for payment links while retaining HTTP task links", () => {
    expect(reminderDraftSchema.safeParse({
      ...minimalDraft,
      kind: "payment",
      actionUrl: "http://example.com/pay",
    }).success).toBe(false);
    expect(reminderDraftSchema.safeParse({
      ...minimalDraft,
      kind: "task",
      actionUrl: "http://example.com/context",
    }).success).toBe(true);
  });

  it("rejects non-HTTP actions and invalid timezones", () => {
    expect(
      reminderDraftSchema.safeParse({
        ...minimalDraft,
        actionUrl: "ftp://example.com/file",
      }).success,
    ).toBe(false);
    expect(
      reminderDraftSchema.safeParse({
        ...minimalDraft,
        actionUrl: "not a URL",
      }).success,
    ).toBe(false);
    expect(
      reminderDraftSchema.safeParse({
        ...minimalDraft,
        timezone: "Mars/Olympus_Mons",
      }).success,
    ).toBe(false);
    expect(
      reminderDraftSchema.safeParse({
        ...minimalDraft,
        timezone: "local",
      }).success,
    ).toBe(false);
  });

  it("rejects the responsible person as a watcher", () => {
    expect(
      reminderDraftSchema.safeParse({
        ...minimalDraft,
        watcherUserIds: [123],
      }).success,
    ).toBe(false);
  });
});

describe("scheduleSpecSchema", () => {
  it("allows 29 February as a yearly schedule", () => {
    expect(
      scheduleSpecSchema.safeParse({
        version: 1,
        frequency: "yearly",
        startDate: "2026-01-01",
        timing: { kind: "allDay" },
        interval: 1,
        month: 2,
        day: 29,
        overflow: "lastDay",
      }).success,
    ).toBe(true);
  });

  it("rejects impossible month-day combinations", () => {
    expect(
      scheduleSpecSchema.safeParse({
        version: 1,
        frequency: "yearly",
        startDate: "2026-01-01",
        timing: { kind: "allDay" },
        interval: 1,
        month: 4,
        day: 31,
        overflow: "lastDay",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate weekdays and invalid local dates", () => {
    expect(
      scheduleSpecSchema.safeParse({
        version: 1,
        frequency: "weekly",
        startDate: "2026-02-30",
        timing: { kind: "timed", timeLocal: "09:00" },
        interval: 1,
        weekdays: [1, 1],
      }).success,
    ).toBe(false);
  });
});

describe("snoozeSelectionSchema", () => {
  it("accepts named presets, custom local time, and bounded legacy durations", () => {
    expect(snoozeSelectionSchema.parse({
      type: "preset",
      preset: "tomorrow_morning",
    })).toEqual({ type: "preset", preset: "tomorrow_morning" });
    expect(snoozeSelectionSchema.parse({
      type: "custom",
      localDate: "2026-08-27",
      localTime: "18:30",
    })).toEqual({ type: "custom", localDate: "2026-08-27", localTime: "18:30" });
    expect(snoozeSelectionSchema.safeParse({ type: "duration", minutes: 15 }).success)
      .toBe(true);
    expect(snoozeSelectionSchema.safeParse({ type: "duration", minutes: 43_200 }).success)
      .toBe(true);
  });

  it("rejects malformed, mixed, or out-of-range selections", () => {
    for (const value of [
      { type: "preset", preset: "later" },
      { type: "preset", preset: "one_hour", minutes: 60 },
      { type: "custom", localDate: "2026-02-30", localTime: "18:30" },
      { type: "custom", localDate: "2026-08-27", localTime: "24:00" },
      { type: "duration", minutes: 14 },
      { type: "duration", minutes: 43_201 },
      { type: "duration", minutes: 60.5 },
    ]) {
      expect(snoozeSelectionSchema.safeParse(value).success).toBe(false);
    }
  });
});
