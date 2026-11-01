import { describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { ensureBotMenu } from "./bot-menu.js";

function fakeBot() {
  const api = { setChatMenuButton: vi.fn().mockResolvedValue(true), setMyCommands: vi.fn().mockResolvedValue(true) };
  return { api, bot: { api } as unknown as Bot };
}

describe("ensureBotMenu", () => {
  it("configures the persistent launch button and discoverable commands once", async () => {
    const { bot, api } = fakeBot();
    await Promise.all([ensureBotMenu(bot, "https://example.com/app"), ensureBotMenu(bot, "https://example.com/app")]);
    expect(api.setChatMenuButton).toHaveBeenCalledExactlyOnceWith({
      menu_button: { type: "web_app", text: "Напоминания", web_app: { url: "https://example.com/app" } },
    });
    expect(api.setMyCommands).toHaveBeenCalledOnce();
    expect(api.setMyCommands.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "menu" }), expect.objectContaining({ command: "topic" }),
    ]));
  });
  it("retries after a transport failure instead of permanently caching it", async () => {
    const { bot, api } = fakeBot();
    api.setChatMenuButton.mockRejectedValueOnce(new Error("temporary"));
    await expect(ensureBotMenu(bot, "https://example.com/app")).rejects.toThrow("temporary");
    await expect(ensureBotMenu(bot, "https://example.com/app")).resolves.toBeUndefined();
    expect(api.setChatMenuButton).toHaveBeenCalledTimes(2);
  });
  it("keeps commands available when the Mini App URL is absent", async () => {
    const { bot, api } = fakeBot();
    await ensureBotMenu(bot, "");
    expect(api.setChatMenuButton).not.toHaveBeenCalled();
    expect(api.setMyCommands).toHaveBeenCalledOnce();
  });
});

it("restores an old private-chat override explicitly", async () => {
  const { restorePrivateBotMenu } = await import("./bot-menu.js");
  const { bot, api } = fakeBot();
  expect(await restorePrivateBotMenu(bot, "https://example.com/app", 10)).toBe(true);
  expect(api.setChatMenuButton).toHaveBeenCalledWith({ chat_id: 10,
    menu_button: { type: "web_app", text: "Напоминания", web_app: { url: "https://example.com/app" } } });
});

it("retries the default configuration after commands fail following a successful menu update", async () => {
  const { bot, api } = fakeBot();
  api.setMyCommands.mockRejectedValueOnce(new Error("commands failed"));
  await expect(ensureBotMenu(bot, "https://example.com/app")).rejects.toThrow("commands failed");
  await expect(ensureBotMenu(bot, "https://example.com/app")).resolves.toBeUndefined();
  expect(api.setChatMenuButton).toHaveBeenCalledTimes(2); expect(api.setMyCommands).toHaveBeenCalledTimes(2);
});

it("a configured default never substitutes for restoring each private-chat override", async () => {
  const { restorePrivateBotMenu } = await import("./bot-menu.js");
  const { bot, api } = fakeBot();
  await ensureBotMenu(bot, "https://example.com/app");
  await restorePrivateBotMenu(bot, "https://example.com/app", 10);
  await restorePrivateBotMenu(bot, "https://example.com/app", 20);
  expect(api.setChatMenuButton.mock.calls.map(([payload]) => payload.chat_id)).toEqual([undefined, 10, 20]);
  expect(api.setMyCommands).toHaveBeenCalledOnce();
});

it("does not report a private menu as configured when no app URL exists", async () => {
  const { restorePrivateBotMenu } = await import("./bot-menu.js");
  const { bot, api } = fakeBot();
  expect(await restorePrivateBotMenu(bot, "", 10)).toBe(false);
  expect(api.setChatMenuButton).not.toHaveBeenCalled();
});
