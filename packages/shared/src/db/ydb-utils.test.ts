import { describe, expect, it } from "vitest";
import { decodeYdbValue, mapResultRow, parseJsonDocument, parseYdbTimestamp, parseYdbTimestampRequired } from "./ydb-utils.js";

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

describe("parseJsonDocument", () => {
  it("returns fallback for missing value", () => {
    expect(parseJsonDocument(undefined, [])).toEqual([]);
  });

  it("parses json string", () => {
    expect(parseJsonDocument("[1,2]", [])).toEqual([1, 2]);
  });

  it("returns array as-is", () => {
    expect(parseJsonDocument([3, 4], [])).toEqual([3, 4]);
  });
});

describe("mapResultRow", () => {
  it("maps positional SDK values to column names", () => {
    const mapped = mapResultRow(
      [{ name: "created_at" }, { name: "title" }],
      {
        items: [{ uint64Value: "1779558781261000" }, { textValue: "Test" }],
      },
    );

    expect(mapped.title).toBe("Test");
    expect(parseYdbTimestamp(mapped.created_at)?.toISOString()).toBe(
      new Date(1779558781261000 / 1000).toISOString(),
    );
  });

  it("decodes null and long values", () => {
    expect(decodeYdbValue({ nullFlagValue: "NULL_VALUE" })).toBeNull();
    expect(decodeYdbValue({ nullFlagValue: 0 })).toBeNull();
    expect(decodeYdbValue({ int64Value: { low: 500000, high: 0, toString: () => "500000" } })).toBe(500000);
    expect(
      decodeYdbValue({ int64Value: { low: -996274391, high: -2, toString: () => "-5291241687" } }),
    ).toBe(-5291241687);
    expect(
      decodeYdbValue({ uint64Value: { low: -788294456, high: 414335, toString: () => "1779558781261000" } }),
    ).toBe(1779558781261000);
  });
});
