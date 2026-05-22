import { z } from "zod";

export const createRuleSchema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().int().nonnegative().nullable().optional(),
  ruleType: z.enum(["recurring", "oneoff"]),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  timeLocal: z.string().min(4).max(5),
  timezone: z.string().optional(),
  mentionIds: z.array(z.number().int()).default([]),
});

export const updateRuleSchema = createRuleSchema.partial().extend({
  status: z.enum(["active", "paused", "archived"]).optional(),
});

export type CreateRuleBody = z.infer<typeof createRuleSchema>;
export type UpdateRuleBody = z.infer<typeof updateRuleSchema>;

export function jsonResponse(statusCode: number, body: unknown): ApiGatewayResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export interface ApiGatewayEvent {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  path?: string;
  url?: string;
  isBase64Encoded?: boolean;
}

export interface ApiGatewayResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function getPath(event: ApiGatewayEvent): string {
  if (event.path) {
    return event.path;
  }
  try {
    return new URL(event.url ?? "/").pathname;
  } catch {
    return "/";
  }
}

export function getHeader(event: ApiGatewayEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const direct = headers[name];
  if (direct) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}
