import { describe, expect, it } from "vitest";
import { buildStartResponse } from "./start-response.js";

describe("buildStartResponse", () => {
  it("uses a Web App button only in a private chat", () => {
    const response = buildStartResponse(
      "private",
      "https://mini-app.example/index.html",
      "reminder_bot",
    );

    expect(response.removeReplyKeyboard).toBe(true);
    expect(response.keyboard?.inline_keyboard).toEqual([
      [{ text: "Открыть панель", web_app: { url: "https://mini-app.example/index.html" } }],
    ]);
  });

  it("uses a private-chat link in a group", () => {
    const response = buildStartResponse(
      "supergroup",
      "https://mini-app.example/index.html",
      "reminder_bot",
    );

    expect(response.removeReplyKeyboard).toBeUndefined();
    expect(response.keyboard?.inline_keyboard).toEqual([
      [{ text: "Открыть бота", url: "https://t.me/reminder_bot?start=panel" }],
    ]);
  });
});

it("opens a configured Main Mini App directly in the source workspace", () => {
  const response = buildStartResponse("supergroup", "https://example.com/app", "reminder_bot", "group-a", true);
  expect(response.keyboard?.inline_keyboard[0][0]).toEqual({ text: "Открыть панель", url: "https://t.me/reminder_bot?startapp=ws_group-a" });
});

it("carries workspace context through the private-chat fallback", () => {
  const group = buildStartResponse("supergroup", "https://example.com/app", "reminder_bot", "group-a");
  expect(group.keyboard?.inline_keyboard[0][0]).toMatchObject({ url: "https://t.me/reminder_bot?start=ws_group-a" });
  const privateChat = buildStartResponse("private", "https://example.com/app?source=menu", "reminder_bot", "group-a");
  expect(privateChat.keyboard?.inline_keyboard[0][0]).toMatchObject({ web_app: { url: "https://example.com/app?source=menu&workspace=group-a" } });
});

it("only promises a permanent private menu after successful configuration", () => {
  expect(buildStartResponse("private", "https://example.com/app", "bot").message).toContain("временно недоступно");
  expect(buildStartResponse("private", "https://example.com/app", "bot", undefined, false, true).message).toContain("рядом с полем ввода");
  expect(buildStartResponse("private", "", "bot").message).toContain("пока не настроена");
});
