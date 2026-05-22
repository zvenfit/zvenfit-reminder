import { TypedValues } from "ydb-sdk";

export type YdbRow = {
  items?: Array<{ name?: string; value?: unknown }> | null;
};

export function getField(row: YdbRow, name: string): unknown {
  const item = row.items?.find((entry) => entry.name === name);
  return item?.value;
}

export function timestampValue(date: Date) {
  return TypedValues.timestamp(date);
}

// YDB SDK может вернуть timestamp в разных форматах
export function parseYdbTimestamp(value: unknown): Date | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "bigint") {
    return new Date(Number(value / 1000n));
  }

  if (typeof value === "number") {
    // microseconds since epoch (YDB) или milliseconds (JS)
    return value > 1e12 ? new Date(value / 1000) : new Date(value);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if ("microseconds" in record) {
      const micros = record.microseconds;
      if (typeof micros === "bigint") {
        return new Date(Number(micros / 1000n));
      }
      if (typeof micros === "number") {
        return new Date(micros / 1000);
      }
    }

    if ("value" in record) {
      return parseYdbTimestamp(record.value);
    }

    if (typeof record.toString === "function") {
      const asString = record.toString();
      if (/^\d+$/.test(asString)) {
        const numeric = Number(asString);
        return new Date(numeric > 1e12 ? numeric / 1000 : numeric);
      }
    }
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  return null;
}

export function parseYdbTimestampRequired(value: unknown, fieldName: string): Date {
  const parsed = parseYdbTimestamp(value);
  if (!parsed) {
    throw new Error(`Invalid YDB timestamp for ${fieldName}`);
  }
  return parsed;
}
