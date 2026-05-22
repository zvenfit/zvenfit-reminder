import { describe, expect, it } from "vitest";
import { parseYdbTimestamp, parseYdbTimestampRequired } from "./ydb-utils.js";

describe("parseYdbTimestamp", () => {
  it("parses microseconds as number", () => {
    const micros = 1_704_067_200_000_000;
    expect(parseYdbTimestamp(micros)?.toISOString()).toBe(new Date(micros / 1000).toISOString());
  });

  it("parses microseconds as bigint", () => {
    const micros = 1_704_067_200_000_000n;
    expect(parseYdbTimestamp(micros)?.toISOString()).toBe(new Date(Number(micros / 1000n)).toISOString());
  });

  it("parses object with microseconds field", () => {
    const value = { microseconds: 1_704_067_200_000_000 };
    expect(parseYdbTimestamp(value)?.toISOString()).toBe(new Date(1_704_067_200_000).toISOString());
  });

  it("parses ISO string", () => {
    expect(parseYdbTimestamp("2026-05-05T09:00:00.000Z")?.toISOString()).toBe("2026-05-05T09:00:00.000Z");
  });

  it("returns null for invalid value", () => {
    expect(parseYdbTimestamp({})).toBeNull();
  });

  it("throws for required invalid value", () => {
    expect(() => parseYdbTimestampRequired(null, "due_at")).toThrow();
  });
});
