import { describe, expect, it } from "vitest";
import { buildStartResponse } from "./start-response.js";

describe("buildStartResponse", () => {
  it("uses a Web App button only in a private chat", () => {
    const response = buildStartResponse(
      "private",
      "https://mini-app.example/index.html",
      "reminder_bot",
    );

    expect("keyboard" in (response.keyboard ?? {})).toBe(true);
    expect(response.keyboard && "keyboard" in response.keyboard
      ? response.keyboard.keyboard
      : null).toEqual([
      [{ text: "Открыть панель", web_app: { url: "https://mini-app.example/index.html" } }],
    ]);
  });

  it("offers native member selection to workspace managers", () => {
    const response = buildStartResponse(
      "private",
      "https://mini-app.example/index.html",
      "reminder_bot",
      true,
    );

    expect(response.keyboard && "keyboard" in response.keyboard
      ? response.keyboard.keyboard
      : null).toEqual([
      [{ text: "Открыть панель", web_app: { url: "https://mini-app.example/index.html" } }],
      [{
        text: "Добавить участников",
        request_users: {
          request_id: 1515603278,
          user_is_bot: false,
          max_quantity: 10,
          request_name: true,
          request_username: true,
        },
      }],
    ]);
  });

  it("uses a private-chat link in a group", () => {
    const response = buildStartResponse(
      "supergroup",
      "https://mini-app.example/index.html",
      "reminder_bot",
    );

    expect(response.keyboard && "inline_keyboard" in response.keyboard
      ? response.keyboard.inline_keyboard
      : null).toEqual([
      [{ text: "Открыть бота", url: "https://t.me/reminder_bot?start=panel" }],
    ]);
  });
});
