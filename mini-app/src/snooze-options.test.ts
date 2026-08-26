import { describe, expect, it } from "vitest";
import {
  buildCustomSnoozeDraft,
  buildSnoozePresetOptions,
  formatSnoozeDeadline,
  formatSnoozeInstant,
  resolveSnoozeSelectionForPreview,
  snoozeQuietHoursHint,
} from "./snooze-options";

describe("snooze options", () => {
  it("labels presets with absolute occurrence-local times", () => {
    const options = buildSnoozePresetOptions({
      now: new Date("2026-08-26T12:30:00.000Z"),
      timezone: "Europe/Moscow",
      morningTime: "09:00",
    });

    expect(options.map(({ title, absoluteLabel }) => ({ title, absoluteLabel }))).toEqual([
      { title: "Через час", absoluteLabel: "сегодня, 16:30" },
      { title: "Сегодня вечером", absoluteLabel: "сегодня, 18:00" },
      { title: "Завтра утром", absoluteLabel: "завтра, 09:00" },
    ]);
  });

  it("hides the evening choice when it is less than fifteen minutes away", () => {
    const options = buildSnoozePresetOptions({
      now: new Date("2026-08-26T14:46:00.000Z"),
      timezone: "Europe/Moscow",
      morningTime: "09:00",
    });

    expect(options.map((option) => option.preset)).toEqual(["one_hour", "tomorrow_morning"]);
  });

  it("uses the workspace morning time and crosses calendar boundaries", () => {
    const options = buildSnoozePresetOptions({
      now: new Date("2026-12-31T20:30:00.000Z"),
      timezone: "Europe/Moscow",
      morningTime: "08:30",
    });

    expect(options[0]?.absoluteLabel).toBe("завтра, 00:30");
    expect(options.at(-1)?.absoluteLabel).toBe("завтра, 08:30");
  });

  it("builds a rounded custom draft in the occurrence timezone", () => {
    expect(buildCustomSnoozeDraft(
      new Date("2026-08-26T12:37:20.000Z"),
      "Europe/Moscow",
    )).toEqual({
      localDate: "2026-08-26",
      localTime: "16:45",
      minDate: "2026-08-26",
      maxDate: "2026-09-25",
    });
  });

  it("advances the custom draft past an ambiguous autumn daylight-saving time", () => {
    expect(buildCustomSnoozeDraft(
      new Date("2026-10-25T00:20:00.000Z"),
      "Europe/Berlin",
    )).toEqual({
      localDate: "2026-10-25",
      localTime: "03:00",
      minDate: "2026-10-25",
      maxDate: "2026-11-24",
    });

    expect(resolveSnoozeSelectionForPreview(
      { type: "custom", localDate: "2026-10-25", localTime: "02:30" },
      {
        now: new Date("2026-10-25T00:20:00.000Z"),
        timezone: "Europe/Berlin",
        morningTime: "09:00",
      },
    )).toBeNull();
  });

  it("formats the unchanged deadline in the occurrence timezone", () => {
    expect(formatSnoozeDeadline({
      dueAt: "2026-08-26T21:30:00.000Z",
      timezone: "Asia/Yekaterinburg",
      allDay: false,
    })).toBe("27 августа 2026 г. · 02:30");

    expect(formatSnoozeDeadline({
      dueAt: "2026-08-26T20:59:59.999Z",
      dueLocalDate: "2026-08-26",
      timezone: "Europe/Moscow",
      allDay: true,
    })).toBe("26 августа 2026 г. · весь день");
  });

  it("explains only the quiet-hours behavior that applies", () => {
    expect(snoozeQuietHoursHint({
      quietHoursStart: "00:00",
      quietHoursEnd: "00:00",
    })).toBe("Тихие часы выключены и не сдвинут сигнал.");
    expect(snoozeQuietHoursHint({
      ignoreQuietHours: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    })).toBe("Для этой задачи разрешена доставка в тихие часы — они не сдвинут сигнал.");
    expect(snoozeQuietHoursHint({
      ignoreQuietHours: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    })).toBe("Если время попадёт в тихие часы 22:00–08:00, сигнал придёт после их окончания.");
  });

  it("formats exact server instants relative to the occurrence-local day", () => {
    expect(formatSnoozeInstant(
      "2026-08-27T05:00:00.000Z",
      "Europe/Moscow",
      new Date("2026-08-26T12:00:00.000Z"),
    )).toBe("завтра, 08:00");
  });

  it("resolves mock previews in the occurrence timezone instead of the device timezone", () => {
    expect(resolveSnoozeSelectionForPreview(
      { type: "custom", localDate: "2026-08-26", localTime: "18:15" },
      {
        now: new Date("2026-08-26T12:00:00.000Z"),
        timezone: "Asia/Yekaterinburg",
        morningTime: "08:30",
      },
    )?.toISOString()).toBe("2026-08-26T13:15:00.000Z");

    expect(resolveSnoozeSelectionForPreview(
      { type: "preset", preset: "tomorrow_morning" },
      {
        now: new Date("2026-08-26T20:00:00.000Z"),
        timezone: "Europe/Moscow",
        morningTime: "08:30",
      },
    )?.toISOString()).toBe("2026-08-27T05:30:00.000Z");
  });

  it("shows the first valid morning time through a daylight-saving gap", () => {
    const now = new Date("2026-03-28T12:00:00.000Z");
    const options = buildSnoozePresetOptions({
      now,
      timezone: "Europe/Berlin",
      morningTime: "02:30",
    });

    expect(options.at(-1)).toMatchObject({
      preset: "tomorrow_morning",
      absoluteLabel: "завтра, 03:00",
    });
    expect(resolveSnoozeSelectionForPreview(
      { type: "preset", preset: "tomorrow_morning" },
      { now, timezone: "Europe/Berlin", morningTime: "02:30" },
    )?.toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });
});
