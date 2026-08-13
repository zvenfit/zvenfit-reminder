import { TypedValues, Types } from "./client.js";

export type YdbColumn = {
  name?: string | null;
};

export type YdbRow = {
  items?: Array<unknown> | null;
};

export type YdbResultSet = {
  columns?: YdbColumn[] | null;
  rows?: YdbRow[] | null;
};

function longToNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number(value);
  }
  if (value && typeof value === "object") {
    const record = value as { low?: number; high?: number; toString?: () => string };
    if (typeof record.toString === "function" && typeof record.low === "number" && typeof record.high === "number") {
      return Number(record.toString());
    }
    if (typeof record.low === "number" && typeof record.high === "number") {
      return record.high * 0x100000000 + (record.low >>> 0);
    }
  }
  return Number(value);
}

function hasYdbValue(record: Record<string, unknown>): boolean {
  return (
    (record.textValue != null && record.textValue !== "") ||
    (record.jsonValue != null && record.jsonValue !== "") ||
    record.int32Value != null ||
    record.uint32Value != null ||
    record.int64Value != null ||
    record.uint64Value != null ||
    record.doubleValue != null ||
    record.floatValue != null ||
    record.boolValue != null
  );
}

export function decodeYdbValue(item: unknown): unknown {
  if (item == null) {
    return null;
  }

  const record = item as Record<string, unknown>;

  if ("name" in record && "value" in record) {
    return decodeYdbValue(record.value);
  }

  if (record.nullFlagValue === "NULL_VALUE" || ("nullFlagValue" in record && !hasYdbValue(record))) {
    return null;
  }

  if (record.textValue != null && record.textValue !== "") {
    return record.textValue;
  }
  if (record.jsonValue != null && record.jsonValue !== "") {
    return record.jsonValue;
  }
  if (record.int32Value != null) {
    return record.int32Value;
  }
  if (record.uint32Value != null) {
    return record.uint32Value;
  }
  if (record.int64Value != null) {
    return longToNumber(record.int64Value);
  }
  if (record.uint64Value != null) {
    return longToNumber(record.uint64Value);
  }
  if (record.doubleValue != null) {
    return record.doubleValue;
  }
  if (record.floatValue != null) {
    return record.floatValue;
  }
  if (record.boolValue != null) {
    return record.boolValue;
  }
  if ("value" in record) {
    return decodeYdbValue(record.value);
  }

  return item;
}

export function mapResultRow(columns: YdbColumn[], row: YdbRow): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  const items = row.items ?? [];

  for (let index = 0; index < columns.length; index += 1) {
    const name = columns[index]?.name;
    if (!name) {
      continue;
    }
    mapped[name] = decodeYdbValue(items[index]);
  }

  return mapped;
}

export function mapResultRows(resultSet: YdbResultSet | undefined): Record<string, unknown>[] {
  const columns = resultSet?.columns ?? [];
  return (resultSet?.rows ?? []).map((row) => mapResultRow(columns, row));
}

export function getField(data: Record<string, unknown>, name: string): unknown {
  return data[name];
}

export function timestampValue(date: Date) {
  return TypedValues.timestamp(date);
}

export function optionalInt64(value: number | null | undefined) {
  if (value == null) {
    return TypedValues.optionalNull(Types.INT64);
  }
  return TypedValues.optional(TypedValues.int64(value));
}

export function optionalUint8(value: number | null | undefined) {
  if (value == null) {
    return TypedValues.optionalNull(Types.UINT8);
  }
  return TypedValues.optional(TypedValues.uint8(value));
}

export function optionalUint32(value: number | null | undefined) {
  if (value == null) {
    return TypedValues.optionalNull(Types.UINT32);
  }
  return TypedValues.optional(TypedValues.uint32(value));
}

export function optionalTimestamp(value: Date | null | undefined) {
  if (value == null) {
    return TypedValues.optionalNull(Types.TIMESTAMP);
  }
  return TypedValues.optional(timestampValue(value));
}

export function optionalUtf8(value: string | null | undefined) {
  if (value == null) {
    return TypedValues.optionalNull(Types.UTF8);
  }
  return TypedValues.optional(TypedValues.utf8(value));
}

export function parseJsonDocument<T>(value: unknown, fallback: T): T {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "undefined" || trimmed === "null") {
      return fallback;
    }
    return JSON.parse(trimmed) as T;
  }

  if (Array.isArray(value)) {
    return value as T;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) {
      return parseJsonDocument(record.value, fallback);
    }
    return value as T;
  }

  return fallback;
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
