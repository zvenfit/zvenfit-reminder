import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestId,
  normalizeRequestId,
  operationalErrorFields,
  writeFunctionLog,
} from "./observability.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("function observability", () => {
  it("accepts bounded request IDs and replaces unsafe values", () => {
    expect(normalizeRequestId("request-1:edge")).toBe("request-1:edge");
    expect(normalizeRequestId("secret\nsecond-line")).toBeNull();
    expect(createRequestId("request-1")).toBe("request-1");
    expect(createRequestId("bad value")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("extracts stable YDB codes without returning the raw error message", () => {
    const fields = operationalErrorFields(
      new Error("Query failed: code = 400080; SELECT secret FROM table"),
    );

    expect(fields).toEqual({ error_code: "ydb_400080", error_name: "error" });
    expect(JSON.stringify(fields)).not.toContain("SELECT");
  });

  it("normalizes custom error names before logging them", () => {
    const error = new Error("private detail");
    error.name = "Private Value\nSecond Line";

    expect(operationalErrorFields(error)).toEqual({
      error_code: "private_value_second_line",
      error_name: "private_value_second_line",
    });
  });

  it("classifies Telegram response and transport failures without their text", () => {
    const responseError = Object.assign(new Error("Forbidden: private details"), {
      name: "GrammyError",
      error_code: 403,
      method: "getChatMember",
    });
    const transportError = Object.assign(new Error("request contained a bot token"), {
      name: "HttpError",
      method: "getChatMember",
    });

    expect(operationalErrorFields(responseError)).toEqual({
      error_code: "telegram_http_403",
      error_name: "grammy_error",
    });
    expect(operationalErrorFields(transportError)).toEqual({
      error_code: "telegram_transport_error",
      error_name: "http_error",
    });
  });

  it("writes single-line structured entries at the requested severity", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    writeFunctionLog("ERROR", "request failed", {
      event: "api_request",
      request_id: "request-1",
      status_code: 502,
    });

    expect(consoleError).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(consoleError.mock.calls[0]?.[0]));
    expect(entry).toEqual({
      message: "request failed",
      level: "ERROR",
      stream_name: "zvenfit-reminder",
      event: "api_request",
      request_id: "request-1",
      status_code: 502,
    });
  });
});
