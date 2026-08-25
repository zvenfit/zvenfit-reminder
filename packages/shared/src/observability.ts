import { randomUUID } from "node:crypto";

export type FunctionLogLevel = "INFO" | "WARN" | "ERROR" | "FATAL";

export type FunctionLogValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[];

export interface FunctionLogFields {
  [key: string]: FunctionLogValue | undefined;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const YDB_CODE_PATTERN = /\bcode\s*=\s*(\d{4,10})\b/i;

export function normalizeRequestId(value: unknown): string | null {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
}

export function createRequestId(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeRequestId(candidate);
    if (normalized) return normalized;
  }
  return randomUUID();
}

export function operationalErrorFields(error: unknown): {
  error_code: string;
  error_name: string;
} {
  if (!(error instanceof Error)) {
    return { error_code: "unknown_error", error_name: "UnknownError" };
  }

  const normalizedName = (error.name || "Error")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "error";
  const ydbCode = error.message.match(YDB_CODE_PATTERN)?.[1];
  if (ydbCode) {
    return { error_code: `ydb_${ydbCode}`, error_name: normalizedName };
  }

  return {
    error_code: normalizedName,
    error_name: normalizedName,
  };
}

export function writeFunctionLog(
  level: FunctionLogLevel,
  message: string,
  fields: FunctionLogFields = {},
): void {
  const payload: Record<string, FunctionLogValue> = {
    message,
    level,
    stream_name: "zvenfit-reminder",
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  const serialized = JSON.stringify(payload);
  if (level === "ERROR" || level === "FATAL") {
    console.error(serialized);
  } else if (level === "WARN") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}
