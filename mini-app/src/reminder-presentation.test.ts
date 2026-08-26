import { describe, expect, it } from "vitest";
import {
  cancellationReasonLabel,
  firstSignalPresentation,
  leadNotificationLabel,
  nextSignalPresentation,
  repeatNotificationLabel,
} from "./reminder-presentation";

describe("reminder presentation", () => {
  it("describes the supported first and repeat signal policies", () => {
    expect(leadNotificationLabel(0)).toBe("В момент срока");
    expect(leadNotificationLabel(60)).toBe("За 1 час до срока");
    expect(leadNotificationLabel(1_440)).toBe("За 1 день до срока");
    expect(leadNotificationLabel(0, { allDay: true, allDayAnchorTime: "08:30" }))
      .toBe("В день срока, в 08:30");
    expect(leadNotificationLabel(60, { allDay: true, allDayAnchorTime: "08:30" }))
      .toBe("В день срока, в 07:30");
    expect(leadNotificationLabel(1_440, { allDay: true, allDayAnchorTime: "08:30" }))
      .toBe("За 1 день до срока, в 08:30");
    expect(repeatNotificationLabel(360)).toBe("Каждые 6 часов");
  });

  it("uses the occurrence timezone for an exact signal around a DST change", () => {
    const presentation = nextSignalPresentation(
      "2026-03-29T01:30:00.000Z",
      "Europe/Berlin",
      new Date("2026-03-29T00:30:00.000Z"),
    );

    expect(presentation?.exact).toContain("03:30");
    expect(presentation?.relative).toBe("Через 1 ч");
  });

  it("keeps the year visible across a calendar boundary", () => {
    const presentation = nextSignalPresentation(
      "2027-01-01T06:00:00.000Z",
      "Europe/Moscow",
      new Date("2026-12-31T20:00:00.000Z"),
    );

    expect(presentation?.exact).toContain("2027");
    expect(presentation?.exact).toContain("09:00");
    expect(presentation?.relative).toBe("Через 10 ч");
  });

  it("does not call a delayed signal upcoming", () => {
    expect(nextSignalPresentation(
      "2026-08-26T09:00:00.000Z",
      "Europe/Moscow",
      new Date("2026-08-26T09:01:00.000Z"),
    )?.relative).toBe("Ожидает отправки");
    expect(nextSignalPresentation("not-an-instant", "Europe/Moscow")).toBeNull();
  });

  it("shows that a past requested lead starts immediately after saving", () => {
    const presentation = firstSignalPresentation({
      dueLocalDate: "2026-08-26",
      notificationTimeLocal: "12:00",
      leadMinutes: 1_440,
      timezone: "Europe/Moscow",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      ignoreQuietHours: false,
      now: new Date("2026-08-26T08:30:00.000Z"),
    });

    expect(presentation).toMatchObject({
      label: "Сразу после сохранения · выбранное время уже прошло",
      effectiveAt: "2026-08-26T08:30:00.000Z",
      clampedToNow: true,
      adjustedForQuietHours: false,
    });
  });

  it("shows the effective end of quiet hours after applying not-before", () => {
    const presentation = firstSignalPresentation({
      dueLocalDate: "2026-08-27",
      notificationTimeLocal: "09:00",
      leadMinutes: 1_440,
      timezone: "Europe/Moscow",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      ignoreQuietHours: false,
      allDay: true,
      now: new Date("2026-08-26T20:30:00.000Z"),
    });

    expect(presentation.label).toContain("первый сигнал после тихих часов");
    expect(presentation.label).toContain("08:00");
    expect(presentation).toMatchObject({
      effectiveAt: "2026-08-27T05:00:00.000Z",
      clampedToNow: true,
      adjustedForQuietHours: true,
    });
  });

  it("maps only internal cancellation codes and preserves human text", () => {
    expect(cancellationReasonLabel("reminder_archived")).toBe("Серия архивирована");
    expect(cancellationReasonLabel("missed_while_paused"))
      .toBe("Срок наступил, пока серия была на паузе");
    expect(cancellationReasonLabel("Создано два одинаковых поручения"))
      .toBe("Создано два одинаковых поручения");
    expect(cancellationReasonLabel(null)).toBeNull();
  });
});
