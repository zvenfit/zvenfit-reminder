import {
  createRequestId,
  operationalErrorFields,
  writeFunctionLog,
} from "@zvenfit-reminder/shared";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import { getHeader } from "./api.js";

const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9_.:-]{1,100}$/i;
const STATIC_API_ROUTES = new Set([
  "/api/workspaces",
  "/api/dashboard",
  "/api/history",
  "/api/reminders",
  "/api/members",
  "/api/members/sync",
  "/api/members/publish-enrollment",
  "/api/workspace/settings",
  "/api/workspace/transfer-ownership",
]);

export function requestIdForEvent(
  event: ApiGatewayEvent,
  functionRequestId?: string,
): string {
  return createRequestId(
    getHeader(event, "X-Zvenfit-Request-Id"),
    event.requestContext?.requestId,
    event.requestContext?.request_id,
    functionRequestId,
  );
}

export function normalizedApiRoute(path: string): string {
  if (/^\/api\/occurrences\/[^/]+\/(complete|snooze|undo-completion)$/.test(path)) {
    return "/api/occurrences/:occurrenceId/:action";
  }
  if (/^\/api\/occurrences\/[^/]+$/.test(path)) {
    return "/api/occurrences/:occurrenceId";
  }
  if (/^\/api\/reminders\/[^/]+\/(pause|resume|archive)$/.test(path)) {
    return "/api/reminders/:reminderId/:lifecycle";
  }
  if (/^\/api\/reminders\/[^/]+\/reassign$/.test(path)) {
    return "/api/reminders/:reminderId/reassign";
  }
  if (/^\/api\/reminders\/[^/]+$/.test(path)) {
    return "/api/reminders/:reminderId";
  }
  if (/^\/api\/members\/\d+\/avatar$/.test(path)) {
    return "/api/members/:userId/avatar";
  }
  if (/^\/api\/members\/\d+\/(role|display-name)$/.test(path)) {
    return "/api/members/:userId/:setting";
  }
  if (STATIC_API_ROUTES.has(path)) return path;
  return path.startsWith("/api") ? "/api/:unknown" : "other";
}

export function responseWithRequestId(
  response: ApiGatewayResponse,
  requestId: string,
): ApiGatewayResponse {
  return {
    ...response,
    headers: {
      ...response.headers,
      "Access-Control-Expose-Headers": "X-Request-Id",
      "X-Request-Id": requestId,
    },
  };
}

function responseErrorCode(response: ApiGatewayResponse): string | undefined {
  if (!response.body || response.statusCode < 400) return undefined;
  try {
    const code = (JSON.parse(response.body) as { code?: unknown }).code;
    return typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function logApiResponse(input: {
  requestId: string;
  method: string;
  route: string;
  response: ApiGatewayResponse;
  durationMs: number;
}): void {
  const { requestId, method, route, response, durationMs } = input;
  const level = response.statusCode >= 500
    ? "ERROR"
    : response.statusCode >= 400
      ? "WARN"
      : "INFO";
  writeFunctionLog(level, "API request completed", {
    event: "api_request",
    request_id: requestId,
    http_method: method,
    route,
    status_code: response.statusCode,
    duration_ms: durationMs,
    error_code: responseErrorCode(response),
  });
}

export function logApiFailure(input: {
  requestId: string;
  method: string;
  route: string;
  error: unknown;
  durationMs: number;
}): void {
  writeFunctionLog("ERROR", "API request failed", {
    event: "api_request",
    request_id: input.requestId,
    http_method: input.method,
    route: input.route,
    status_code: 502,
    duration_ms: input.durationMs,
    ...operationalErrorFields(input.error),
  });
}
