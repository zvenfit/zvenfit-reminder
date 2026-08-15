import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramAgentFamily, telegramClientOptions } from "./telegram-network.js";

describe("telegramClientOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forces direct grammY Telegram requests through IPv4", () => {
    const options = telegramClientOptions(5);

    expect(options.timeoutSeconds).toBe(5);
    expect(telegramAgentFamily()).toBe(4);
    expect(options.baseFetchConfig).toHaveProperty("agent");
  });

  it("routes grammY through the authenticated Worker without putting the token in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const options = telegramClientOptions(5, {
      botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123",
      webhookSecret: "webhook-secret",
      ydbEndpoint: "grpc://unused",
      ydbDatabase: "/unused",
      defaultTimezone: "Europe/Moscow",
      miniAppUrl: "",
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
      telegramProxySecret: "proxy-secret",
    });

    const url = options.buildUrl!(
      options.apiRoot!,
      "must-not-appear",
      "sendMessage",
      "prod",
    );
    await options.fetch!(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(String(url)).toBe("https://reminder.example.workers.dev/telegram/sendMessage");
    expect(String(url)).not.toContain("must-not-appear");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Zvenfit-Telegram-Proxy-Secret")).toBe("proxy-secret");
    expect(headers.get("X-Zvenfit-Telegram-Bot-Token"))
      .toBe("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123");
  });
});
