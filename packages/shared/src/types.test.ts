import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./types.js";

function stubRequiredConfig(): void {
  vi.stubEnv("YDB_ENDPOINT", "grpc://unused");
  vi.stubEnv("YDB_DATABASE", "/unused");
  vi.stubEnv("BOT_TOKEN", "123456:test");
  vi.stubEnv("WEBHOOK_SECRET", "webhook-secret");
}

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the outbound Telegram proxy only when both values are present", () => {
    stubRequiredConfig();
    vi.stubEnv("TELEGRAM_API_ROOT", "https://reminder.example.workers.dev/telegram");
    vi.stubEnv("TELEGRAM_PROXY_SECRET", "proxy-secret");

    expect(loadConfig()).toMatchObject({
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
      telegramProxySecret: "proxy-secret",
    });
  });

  it("fails closed for partial proxy configuration", () => {
    stubRequiredConfig();
    vi.stubEnv("TELEGRAM_API_ROOT", "https://reminder.example.workers.dev/telegram");
    vi.stubEnv("TELEGRAM_PROXY_SECRET", "");

    expect(() => loadConfig()).toThrow("must be configured together");
  });
});
