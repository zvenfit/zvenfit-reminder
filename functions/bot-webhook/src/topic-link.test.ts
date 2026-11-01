import { describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { createTopicLinkResolver, InvalidTopicLinkError, parseTopicLink } from "./topic-link.js";

const { getChat } = vi.hoisted(() => ({ getChat: vi.fn() }));
vi.mock("grammy", () => ({ Bot: class { api = { getChat }; } }));

describe("topic links", () => {
  it.each([
    "https://t.me/c/1234567890/42",
    "https://t.me/c/1234567890/42/90",
    "https://t.me/c/1234567890/90?thread=42",
  ])("parses a private topic link without confusing message and thread: %s", (link) => {
    expect(parseTopicLink(link)).toEqual({ chatId: -1001234567890, messageThreadId: 42 });
  });
  it.each(["https://t.me/My_Group/42", "https://t.me/My_Group/42/90", "https://telegram.me/My_Group/90?thread=42"])("accepts public links: %s", (link) => {
    expect(parseTopicLink(link)).toEqual({ username: "my_group", messageThreadId: 42 });
  });
  it.each([
    "https://evil.example/c/1234567890/42", "https://t.me.evil.example/c/1234567890/42",
    "https://user@t.me/c/1234567890/42", "http://t.me/c/1234567890/42",
    "https://t.me/+invite", "https://t.me/c/1234567890/1", "https://t.me/c/1234567890/-42",
    "https://t.me/c/1234567890/42/90?thread=52", "https://t.me/c/1234567890/90?thread=42&thread=52",
    "https://t.me/group/42?comment=99", "https://t.me/c/1234567890/9007199254740992",
  ])("rejects invalid, ambiguous and non-topic links: %s", (link) => {
    expect(() => parseTopicLink(link)).toThrow(InvalidTopicLinkError);
  });
  it("verifies public names against the actual workspace and never looks up user-controlled targets", async () => {
    getChat.mockResolvedValue({ id: -1001234567890, type: "supergroup", is_forum: true, username: "my_group" });
    const resolver = createTopicLinkResolver({ getChat } as unknown as Pick<Api, "getChat">);
    await expect(resolver.resolve(-1001234567890, "https://t.me/My_Group/42")).resolves.toBe(42);
    await expect(resolver.resolve(-1001234567890, "https://t.me/foreign_group/42")).rejects.toThrow("другой группы");
    expect(getChat).toHaveBeenLastCalledWith(-1001234567890);
    getChat.mockClear();
    await expect(resolver.resolve(-1001234567890, "https://t.me/c/9876543210/42")).rejects.toThrow("другой группы");
    expect(getChat).not.toHaveBeenCalled();
    getChat.mockResolvedValue({ id: -1001234567890, type: "supergroup", is_forum: false });
    await expect(resolver.resolve(-1001234567890, "https://t.me/c/1234567890/42")).rejects.toThrow("не включены темы");
  });
});
