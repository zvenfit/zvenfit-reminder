import { describe, expect, it } from "vitest";
import { buildMentionHtml, buildReminderMessage, escapeHtml } from "./telegram.js";
import type { GroupMember, Rule } from "./types.js";

const members: GroupMember[] = [
  {
    chatId: -100,
    userId: 42,
    username: "alice",
    displayName: "Alice",
    updatedAt: new Date(),
  },
  {
    chatId: -100,
    userId: 99,
    username: null,
    displayName: "Bob",
    updatedAt: new Date(),
  },
];

describe("buildMentionHtml", () => {
  it("builds tg://user links", () => {
    expect(buildMentionHtml([42, 99], members)).toBe(
      '<a href="tg://user?id=42">Alice</a> <a href="tg://user?id=99">Bob</a>',
    );
  });
});

describe("buildReminderMessage", () => {
  it("uses HTML without entities", () => {
    const rule: Rule = {
      id: "1",
      title: "Ипотека",
      amount: 5_000_000,
      ruleType: "recurring",
      dayOfMonth: 5,
      dueAt: null,
      timeLocal: "09:00",
      timezone: "Europe/Moscow",
      chatId: -100,
      mentionIds: [42],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const message = buildReminderMessage(rule, members);
    expect(message).toContain("<b>Ипотека</b>");
    expect(message).toContain('href="tg://user?id=42"');
    expect(message).not.toContain("entities");
  });
});

describe("escapeHtml", () => {
  it("escapes special chars", () => {
    expect(escapeHtml(`a & b < c`)).toBe("a &amp; b &lt; c");
  });
});
