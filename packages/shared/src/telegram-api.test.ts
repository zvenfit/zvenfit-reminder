import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_TOKEN_HEADER,
  TELEGRAM_PROXY_SECRET_HEADER,
  normalizeTelegramProxyRoot,
  telegramApiRequest,
} from "./telegram-api.js";

describe("Telegram API routing", () => {
  it("keeps direct Telegram access for local development", () => {
    expect(telegramApiRequest({ botToken: "123:test" }, "sendMessage")).toEqual({
      url: "https://api.telegram.org/bot123:test/sendMessage",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("routes production calls through the authenticated Worker without a token in the URL", () => {
    const request = telegramApiRequest({
      botToken: "123:test",
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
      telegramProxySecret: "proxy-secret",
    }, "getChatMember");

    expect(request.url).toBe("https://reminder.example.workers.dev/telegram/getChatMember");
    expect(request.url).not.toContain("123:test");
    expect(request.headers[TELEGRAM_PROXY_SECRET_HEADER]).toBe("proxy-secret");
    expect(request.headers[TELEGRAM_BOT_TOKEN_HEADER]).toBe("123:test");
  });

  it("fails closed for partial or untrusted proxy configuration", () => {
    expect(() => telegramApiRequest({
      botToken: "123:test",
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
    }, "getMe")).toThrow("must be configured together");
    expect(() => normalizeTelegramProxyRoot("https://example.com/telegram"))
      .toThrow("workers.dev");
    expect(() => normalizeTelegramProxyRoot("https://reminder.example.workers.dev/other"))
      .toThrow("/telegram");
  });
});
