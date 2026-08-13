import { InlineKeyboard, Keyboard } from "grammy";
import { MEMBER_IMPORT_REQUEST_ID } from "./member-import.js";

interface StartResponse {
  message: string;
  keyboard?: InlineKeyboard | Keyboard;
}

export function buildStartResponse(
  chatType: string,
  miniAppUrl: string,
  botUsername: string,
  canImportMembers = false,
): StartResponse {
  if (chatType === "private") {
    const keyboard = new Keyboard();
    if (miniAppUrl) {
      keyboard.webApp("Открыть панель", miniAppUrl);
    }
    if (canImportMembers) {
      if (miniAppUrl) {
        keyboard.row();
      }
      keyboard.requestUsers("Добавить участников", MEMBER_IMPORT_REQUEST_ID, {
        user_is_bot: false,
        max_quantity: 10,
        request_name: true,
        request_username: true,
      });
    }
    return {
      message: canImportMembers
        ? "Готово: личные уведомления подключены. Открой панель или добавь участников основной группы."
        : "Готово: личные уведомления подключены. Напоминания можно создавать в Mini App.",
      keyboard: keyboard.keyboard.length > 0
        ? keyboard.resized().persistent()
        : undefined,
    };
  }

  return {
    message: "Бот произвольных напоминаний. Панель открывается в личном чате с ботом.",
    keyboard: new InlineKeyboard().url(
      "Открыть бота",
      `https://t.me/${botUsername}?start=panel`,
    ),
  };
}
