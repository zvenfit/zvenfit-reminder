import { describe, expect, it } from "vitest";
import { telegramAgentFamily, telegramClientOptions } from "./telegram-network.js";

describe("telegramClientOptions", () => {
  it("forces grammY Telegram requests through IPv4", () => {
    const options = telegramClientOptions(5);

    expect(options.timeoutSeconds).toBe(5);
    expect(telegramAgentFamily()).toBe(4);
    expect(options.baseFetchConfig).toHaveProperty("agent");
  });
});
