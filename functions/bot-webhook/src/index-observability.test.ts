import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./bot-initialization.js", () => ({
  ensureBotInitialized: vi.fn().mockResolvedValue(undefined),
}));

import { AUTHENTICATED_WEBHOOK_HEADER, handler } from "./index.js";

function stubValidConfig(): void {
  vi.stubEnv("YDB_ENDPOINT", "grpc://unused");
  vi.stubEnv("YDB_DATABASE", "/unused");
  vi.stubEnv("BOT_TOKEN", "123456:test");
  vi.stubEnv("WEBHOOK_SECRET", "verified-secret");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("handler configuration observability", () => {
  it("keeps runtime health configuration failures inside the structured boundary", async () => {
    vi.stubEnv("YDB_ENDPOINT", "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(
      { httpMethod: "POST", path: "/health/runtime" },
      { requestId: "function-health-1" },
    );

    expect(response.statusCode).toBe(502);
    const entry = String(consoleError.mock.calls[0]?.[0]);
    expect(entry).toContain('"event":"runtime_health"');
    expect(entry).toContain('"error_code":"configuration_error"');
    expect(entry).not.toContain("YDB_ENDPOINT");
  });

  it("does not trust the edge ID when webhook configuration fails before authentication", async () => {
    vi.stubEnv("YDB_ENDPOINT", "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(
      {
        httpMethod: "POST",
        path: "/",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": "unverified-secret",
          "X-Zvenfit-Request-Id": "untrusted-edge-id",
        },
        body: "{}",
      },
      { requestId: "function-webhook-1" },
    );

    expect(response.statusCode).toBe(200);
    const entry = String(consoleError.mock.calls[0]?.[0]);
    expect(entry).toContain('"event":"telegram_webhook"');
    expect(entry).toContain('"request_id":"function-webhook-1"');
    expect(entry).not.toContain("untrusted-edge-id");
    expect(entry).not.toContain("edge_request_id");
    expect(response.headers?.[AUTHENTICATED_WEBHOOK_HEADER]).toBeUndefined();
  });

  it("does not mark a webhook response authenticated when the secret is rejected", async () => {
    stubValidConfig();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handler({
      httpMethod: "POST",
      path: "/",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
      body: "{}",
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers?.[AUTHENTICATED_WEBHOOK_HEADER]).toBeUndefined();
  });

  it("marks failures after webhook-secret verification for the trusted Worker", async () => {
    stubValidConfig();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler({
      httpMethod: "POST",
      path: "/",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "verified-secret" },
      body: "{",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers?.[AUTHENTICATED_WEBHOOK_HEADER]).toBe("1");
  });
});
