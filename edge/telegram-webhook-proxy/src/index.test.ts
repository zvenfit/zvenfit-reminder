import { describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  MAX_UPDATE_BYTES,
  type OriginFetch,
} from "./index.js";

const ORIGIN_URL = "https://functions.yandexcloud.net/d4e3h1o2eoa1vp5g7ec5";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const env: WorkerEnv = { ORIGIN_URL };

function telegramRequest(body: BodyInit = JSON.stringify({ update_id: 1 })): Request {
  return new Request("https://proxy.example/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: "test-secret",
      "X-Untrusted-Header": "must-not-be-forwarded",
    },
    body,
  });
}

describe("Telegram webhook proxy", () => {
  it("serves a local health endpoint without calling the origin", async () => {
    const originFetch = vi.fn<OriginFetch>();

    const response = await handleRequest(
      new Request("https://proxy.example/health"),
      env,
      originFetch,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported paths and methods", async () => {
    const originFetch = vi.fn<OriginFetch>();

    const missing = await handleRequest(
      new Request("https://proxy.example/admin", { method: "POST" }),
      env,
      originFetch,
    );
    const method = await handleRequest(
      new Request("https://proxy.example/", { method: "GET" }),
      env,
      originFetch,
    );

    expect(missing.status).toBe(404);
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("POST");
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("requires Telegram's secret header and JSON content type", async () => {
    const originFetch = vi.fn<OriginFetch>();
    const missingSecret = await handleRequest(
      new Request("https://proxy.example/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      originFetch,
    );
    const wrongContentType = await handleRequest(
      new Request("https://proxy.example/", {
        method: "POST",
        headers: { [SECRET_HEADER]: "test-secret", "Content-Type": "text/plain" },
        body: "{}",
      }),
      env,
      originFetch,
    );

    expect(missingSecret.status).toBe(403);
    expect(wrongContentType.status).toBe(415);
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized updates before calling the origin", async () => {
    const originFetch = vi.fn<OriginFetch>();
    const response = await handleRequest(
      telegramRequest(new Uint8Array(MAX_UPDATE_BYTES + 1)),
      env,
      originFetch,
    );

    expect(response.status).toBe(413);
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("forwards only the update and Telegram authentication header", async () => {
    const originFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(JSON.stringify({ method: "sendMessage", chat_id: 42, text: "Retry" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const requestBody = JSON.stringify({ update_id: 7, message: { text: "/setup" } });

    const response = await handleRequest(telegramRequest(requestBody), env, originFetch);

    expect(originFetch).toHaveBeenCalledOnce();
    const [origin, init] = originFetch.mock.calls[0]!;
    expect(origin.toString()).toBe(ORIGIN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get(SECRET_HEADER)).toBe("test-secret");
    expect(headers.has("X-Untrusted-Header")).toBe(false);
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(requestBody);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      method: "sendMessage",
      chat_id: 42,
      text: "Retry",
    });
  });

  it("fails closed when the origin is invalid or unavailable", async () => {
    const originFetch = vi.fn<OriginFetch>().mockRejectedValue(new Error("network failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const invalid = await handleRequest(
      telegramRequest(),
      { ORIGIN_URL: "https://example.com/open-proxy" },
      originFetch,
    );
    const unavailable = await handleRequest(telegramRequest(), env, originFetch);

    expect(invalid.status).toBe(500);
    expect(unavailable.status).toBe(502);
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
