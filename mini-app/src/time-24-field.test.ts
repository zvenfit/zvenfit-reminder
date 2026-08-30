import { describe, expect, it } from "vitest";
import {
  formatTimeDraft,
  isLocalTime24,
  resolveTimeDraftChange,
  validateTimeDraft,
} from "./time-24-field";

describe("24-hour time input", () => {
  it("formats four typed digits as HH:MM", () => {
    expect(formatTimeDraft("1845")).toBe("18:45");
    expect(formatTimeDraft("930")).toBe("09:30");
  });

  it("accepts only real 24-hour values", () => {
    expect(isLocalTime24("00:00")).toBe(true);
    expect(isLocalTime24("23:59")).toBe(true);
    expect(isLocalTime24("12:30 PM")).toBe(false);
    expect(isLocalTime24("24:00")).toBe(false);
  });

  it("preserves an invalid draft and exposes an error after blur", () => {
    const change = resolveTimeDraftChange("2460", false);

    expect(change).toEqual({
      draft: "24:60",
      error: null,
      committedValue: null,
    });
    expect(validateTimeDraft(change.draft)).toBe("Введите время от 00:00 до 23:59");
  });

  it("clears the visible error and commits after a valid compact edit", () => {
    const recovered = resolveTimeDraftChange("930", true);

    expect(recovered).toEqual({
      draft: "09:30",
      error: null,
      committedValue: "09:30",
    });
  });

  it("never commits an invalid edit while its error is visible", () => {
    expect(resolveTimeDraftChange("9999", true)).toEqual({
      draft: "99:99",
      error: "Введите время от 00:00 до 23:59",
      committedValue: null,
    });
  });
});
