import { describe, expect, it } from "vitest";
import { buildStartResponse } from "./start-response.js";

describe("buildStartResponse", () => {
  it("uses a Web App button only in a private chat", () => {
    const response = buildStartResponse(
      "private",
      "https://mini-app.example/index.html",
      "reminder_bot",
    );

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

    expect(response.keyboard?.inline_keyboard).toEqual([
      [{ text: "Открыть бота", url: "https://t.me/reminder_bot?start=panel" }],
    ]);
  });
});
