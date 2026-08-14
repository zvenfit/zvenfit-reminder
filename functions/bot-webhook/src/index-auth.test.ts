import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInitData } from "./index.js";

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
