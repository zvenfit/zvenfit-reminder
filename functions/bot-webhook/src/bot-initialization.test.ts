import { describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { ensureBotInitialized } from "./bot-initialization.js";

describe("ensureBotInitialized", () => {
  it("initializes a bot only once for concurrent webhook updates", async () => {
    const init = vi.fn(async () => undefined);
    const bot = { init } as unknown as Bot;

    await Promise.all([
      ensureBotInitialized(bot),
      ensureBotInitialized(bot),
      ensureBotInitialized(bot),
    ]);

    expect(init).toHaveBeenCalledTimes(1);
  });

  it("allows initialization to be retried after a failure", async () => {
    const init = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary Telegram error"))
      .mockResolvedValueOnce(undefined);
    const bot = { init } as unknown as Bot;

    await expect(ensureBotInitialized(bot)).rejects.toThrow("temporary Telegram error");
    await expect(ensureBotInitialized(bot)).resolves.toBeUndefined();

    expect(init).toHaveBeenCalledTimes(2);
  });
});
