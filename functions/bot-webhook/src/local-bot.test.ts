import { describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  bot: { api: { deleteWebhook: vi.fn() }, start: vi.fn() }, initialize: vi.fn(),
}));
vi.mock("./index.js", () => ({ getBot: () => mocked.bot, initializeBotRuntime: mocked.initialize }));
import { startPollingBot } from "./local-bot.js";

describe("local polling bot runtime", () => {
  it("initializes the shared runtime before polling with onboarding and membership updates enabled", async () => {
    mocked.initialize.mockResolvedValue(undefined);
    mocked.bot.api.deleteWebhook.mockResolvedValue(true);
    mocked.bot.start.mockResolvedValue(undefined);
    await startPollingBot();
    expect(mocked.initialize).toHaveBeenCalledExactlyOnceWith(mocked.bot);
    expect(mocked.initialize.mock.invocationCallOrder[0]).toBeLessThan(mocked.bot.api.deleteWebhook.mock.invocationCallOrder[0]);
    expect(mocked.bot.api.deleteWebhook.mock.invocationCallOrder[0]).toBeLessThan(mocked.bot.start.mock.invocationCallOrder[0]);
    expect(mocked.bot.start).toHaveBeenCalledWith(expect.objectContaining({ allowed_updates: ["message", "callback_query", "chat_member"] }));
  });
});
