import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebhookRequest, resolveInitData } from "./index.js";

describe("resolveInitData", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows the local bypass only in the development environment", () => {
    vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_USER_ID", "42");

    expect(resolveInitData(undefined, "unused-token").user.id).toBe(42);
  });

  it("fails closed when NODE_ENV is missing even if the bypass flag is set", () => {
    vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "1");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("DEV_USER_ID", "42");

    expect(() => resolveInitData(undefined, "unused-token"))
      .toThrow("Missing X-Telegram-Init-Data");
  });
});

describe("isWebhookRequest", () => {
  it("accepts Telegram POSTs on the API Gateway and direct function paths", () => {
    expect(isWebhookRequest("/webhook", "POST")).toBe(true);
    expect(isWebhookRequest("/", "POST")).toBe(true);
  });

  it("does not turn other direct-function requests into webhook updates", () => {
    expect(isWebhookRequest("/", "GET")).toBe(false);
    expect(isWebhookRequest("/api/workspaces", "POST")).toBe(false);
    expect(isWebhookRequest("/other", "POST")).toBe(false);
  });
});
