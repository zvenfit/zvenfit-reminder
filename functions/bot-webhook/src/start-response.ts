import { InlineKeyboard } from "grammy";

interface StartResponse {
  message: string;
  keyboard?: InlineKeyboard;
  removeReplyKeyboard?: boolean;
}

export function buildStartResponse(
  chatType: string,
  miniAppUrl: string,
  botUsername: string,
): StartResponse {
  if (chatType === "private") {
    const keyboard = miniAppUrl
      ? new InlineKeyboard().webApp("Открыть панель", miniAppUrl)
      : undefined;
    return {
      message: "Готово: личные уведомления подключены. Открой панель напоминаний.",
      keyboard,
      removeReplyKeyboard: true,
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
