import { describe, expect, it } from "vitest";
import {
  formatCalendarDateDraft,
  formatCalendarDateValue,
  parseCalendarDateDraft,
  validateCalendarDateDraft,
} from "./calendar-date-field";

describe("Russian calendar date field", () => {
  it("always presents stored ISO dates as DD.MM.YYYY", () => {
    expect(formatCalendarDateValue("2026-08-30")).toBe("30.08.2026");
    expect(formatCalendarDateValue("2028-02-29")).toBe("29.02.2028");
  });

  it("formats compact typing and converts it back to ISO", () => {
    expect(formatCalendarDateDraft("30082026")).toBe("30.08.2026");
    expect(formatCalendarDateDraft("2026-08-30")).toBe("30.08.2026");
    expect(parseCalendarDateDraft("30.08.2026")).toBe("2026-08-30");
  });

  it("keeps incomplete drafts visible without treating them as dates", () => {
    expect(formatCalendarDateDraft("3008")).toBe("30.08");
    expect(parseCalendarDateDraft("30.08")).toBeNull();
  });

  it("rejects impossible dates but accepts leap day", () => {
    expect(validateCalendarDateDraft("31.02.2026", { required: true }))
      .toBe("Такой даты не существует.");
    expect(validateCalendarDateDraft("29.02.2028", { required: true })).toBeNull();
  });

  it("explains minimum and maximum boundaries in the same display format", () => {
    expect(validateCalendarDateDraft("30.08.2026", { min: "2026-08-31" }))
      .toBe("Выберите дату не раньше 31.08.2026.");
    expect(validateCalendarDateDraft("01.10.2026", { max: "2026-09-30" }))
      .toBe("Выберите дату не позже 30.09.2026.");
  });

  it("uses field-specific copy for an empty required value", () => {
    expect(validateCalendarDateDraft("", {
      required: true,
      emptyMessage: "Выберите дату срока.",
    })).toBe("Выберите дату срока.");
  });
});
