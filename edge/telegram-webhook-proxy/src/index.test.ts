import { describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  MAX_TELEGRAM_API_BYTES,
  MAX_TELEGRAM_FILE_BYTES,
  MAX_UPDATE_BYTES,
  type OriginFetch,
} from "./index.js";

const ORIGIN_URL = "https://functions.yandexcloud.net/d4e3h1o2eoa1vp5g7ec5";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const PROXY_SECRET_HEADER = "X-Zvenfit-Telegram-Proxy-Secret";
const BOT_TOKEN_HEADER = "X-Zvenfit-Telegram-Bot-Token";
const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123";
const env: WorkerEnv = { ORIGIN_URL, TELEGRAM_PROXY_SECRET: "proxy-secret" };
const compareSecrets = async (provided: string, expected: string) => provided === expected;

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

  it("proxies allowlisted Telegram API methods without exposing the token in its public URL", async () => {
    const telegramFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { id: 123456 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.stringify({ chat_id: -42, text: "Готово" });
    const request = new Request("https://proxy.example/telegram/sendMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [PROXY_SECRET_HEADER]: "proxy-secret",
        [BOT_TOKEN_HEADER]: BOT_TOKEN,
        "X-Untrusted-Header": "must-not-be-forwarded",
      },
      body,
    });

    const response = await handleRequest(request, env, telegramFetch, compareSecrets);

    expect(telegramFetch).toHaveBeenCalledOnce();
    const [upstream, init] = telegramFetch.mock.calls[0]!;
    expect(String(upstream)).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers)).toEqual(new Headers({
      "Content-Type": "application/json",
    }));
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("allows the prepared user picker method used by Mini Apps", async () => {
    const telegramFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { id: "prepared-users" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const response = await handleRequest(
      new Request("https://proxy.example/telegram/savePreparedKeyboardButton", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PROXY_SECRET_HEADER]: "proxy-secret",
          [BOT_TOKEN_HEADER]: BOT_TOKEN,
        },
        body: JSON.stringify({
          user_id: 42,
          button: { text: "Добавить участников", request_users: { request_id: 7 } },
        }),
      }),
      env,
      telegramFetch,
      compareSecrets,
    );

    expect(response.status).toBe(200);
    expect(String(telegramFetch.mock.calls[0]?.[0])).toBe(
      `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedKeyboardButton`,
    );
  });

  it("allows only the Telegram metadata methods required for profile photos", async () => {
    const telegramFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    for (const method of ["getUserProfilePhotos", "getFile"]) {
      const response = await handleRequest(
        new Request(`https://proxy.example/telegram/${method}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [PROXY_SECRET_HEADER]: "proxy-secret",
            [BOT_TOKEN_HEADER]: BOT_TOKEN,
          },
          body: "{}",
        }),
        env,
        telegramFetch,
        compareSecrets,
      );
      expect(response.status).toBe(200);
    }
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });

  it("allows only authenticated bounded Telegram profile photo downloads", async () => {
    const telegramFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
      }),
    );
    const response = await handleRequest(
      new Request("https://proxy.example/telegram-file/photos/avatar.jpg", {
        headers: {
          [PROXY_SECRET_HEADER]: "proxy-secret",
          [BOT_TOKEN_HEADER]: BOT_TOKEN,
          "X-Untrusted-Header": "must-not-be-forwarded",
        },
      }),
      env,
      telegramFetch,
      compareSecrets,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(String(telegramFetch.mock.calls[0]?.[0])).toBe(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/avatar.jpg`,
    );
    expect(new Headers(telegramFetch.mock.calls[0]?.[1]?.headers).has("X-Untrusted-Header"))
      .toBe(false);
  });

  it("rejects unsafe, unauthorized, and oversized Telegram file downloads", async () => {
    const telegramFetch = vi.fn<OriginFetch>().mockResolvedValue(
      new Response(new Uint8Array(), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(MAX_TELEGRAM_FILE_BYTES + 1),
        },
      }),
    );
    const unauthorized = await handleRequest(
      new Request("https://proxy.example/telegram-file/photos/avatar.jpg"),
      env,
      telegramFetch,
      compareSecrets,
    );
    const unsafe = await handleRequest(
      new Request("https://proxy.example/telegram-file/photos/%2E%2E/secrets"),
      env,
      telegramFetch,
      compareSecrets,
    );
    const oversized = await handleRequest(
      new Request("https://proxy.example/telegram-file/photos/avatar.jpg", {
        headers: {
          [PROXY_SECRET_HEADER]: "proxy-secret",
          [BOT_TOKEN_HEADER]: BOT_TOKEN,
        },
      }),
      env,
      telegramFetch,
      compareSecrets,
    );

    expect(unauthorized.status).toBe(403);
    expect(unsafe.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(telegramFetch).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid outbound authorization, methods, and payloads", async () => {
    const telegramFetch = vi.fn<OriginFetch>();
    const baseHeaders = {
      "Content-Type": "application/json",
      [PROXY_SECRET_HEADER]: "wrong-secret",
      [BOT_TOKEN_HEADER]: BOT_TOKEN,
    };

    const forbidden = await handleRequest(
      new Request("https://proxy.example/telegram/getMe", {
        method: "POST",
        headers: baseHeaders,
        body: "{}",
      }),
      env,
      telegramFetch,
      compareSecrets,
    );
    const unsupported = await handleRequest(
      new Request("https://proxy.example/telegram/setWebhook", {
        method: "POST",
        headers: { ...baseHeaders, [PROXY_SECRET_HEADER]: "proxy-secret" },
        body: "{}",
      }),
      env,
      telegramFetch,
      compareSecrets,
    );
    const oversized = await handleRequest(
      new Request("https://proxy.example/telegram/sendMessage", {
        method: "POST",
        headers: { ...baseHeaders, [PROXY_SECRET_HEADER]: "proxy-secret" },
        body: new Uint8Array(MAX_TELEGRAM_API_BYTES + 1),
      }),
      env,
      telegramFetch,
      compareSecrets,
    );

    expect(forbidden.status).toBe(403);
    expect(unsupported.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(telegramFetch).not.toHaveBeenCalled();
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
      { ORIGIN_URL: "https://example.com/open-proxy", TELEGRAM_PROXY_SECRET: "proxy-secret" },
      originFetch,
    );
    const unavailable = await handleRequest(telegramRequest(), env, originFetch);

    expect(invalid.status).toBe(500);
    expect(unavailable.status).toBe(502);
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
