import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logApiFailure,
  logApiResponse,
  normalizedApiRoute,
  requestIdForEvent,
  responseWithRequestId,
} from "./request-observability.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API request observability", () => {
  it("normalizes entity IDs out of route labels", () => {
    expect(normalizedApiRoute("/api/occurrences/occurrence-secret/complete"))
      .toBe("/api/occurrences/:occurrenceId/:action");
    expect(normalizedApiRoute("/api/reminders/reminder-secret/reassign"))
      .toBe("/api/reminders/:reminderId/reassign");
    expect(normalizedApiRoute("/api/members/123/avatar"))
      .toBe("/api/members/:userId/avatar");
    expect(normalizedApiRoute("/api/history")).toBe("/api/history");
  });

  it("uses the Worker correlation ID when it is present", () => {
    const requestId = requestIdForEvent({
      requestContext: { requestId: "gateway-request-1" },
      headers: { "X-Zvenfit-Request-Id": "worker-request-1" },
    });
    const response = responseWithRequestId({ statusCode: 200, body: "{}" }, requestId);

    expect(requestId).toBe("worker-request-1");
    expect(response.headers?.["X-Request-Id"]).toBe("worker-request-1");
  });

  it("prefers the API Gateway request ID to the function runtime ID", () => {
    expect(requestIdForEvent(
      { requestContext: { requestId: "gateway-request-1" } },
      "function-request-1",
    )).toBe("gateway-request-1");
  });

  it("does not copy unknown path segments into logs", () => {
    expect(normalizedApiRoute("/api/private-value/another-value")).toBe("/api/:unknown");
  });

  it("logs safe response codes without copying the response body", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logApiResponse({
      requestId: "request-1",
      method: "GET",
      route: "/api/history",
      response: {
        statusCode: 403,
        body: JSON.stringify({ code: "forbidden", error: "private detail" }),
      },
      durationMs: 12,
    });

    const entry = String(consoleWarn.mock.calls[0]?.[0]);
    expect(entry).toContain('"error_code":"forbidden"');
    expect(entry).not.toContain("private detail");
  });

  it("logs an YDB code without SQL text on an unhandled failure", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logApiFailure({
      requestId: "request-2",
      method: "GET",
      route: "/api/history",
      error: new Error("code = 400080; SELECT occurrence.*"),
      durationMs: 15,
    });

    const entry = String(consoleError.mock.calls[0]?.[0]);
    expect(entry).toContain('"error_code":"ydb_400080"');
    expect(entry).not.toContain("SELECT");
  });
});
