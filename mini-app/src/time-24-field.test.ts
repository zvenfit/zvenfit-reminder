import { describe, expect, it } from "vitest";
import { formatTimeDraft, isLocalTime24 } from "./time-24-field";

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
});
