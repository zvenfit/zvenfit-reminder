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
  workspaceId?: string,
  hasMainWebApp = false,
  privateMenuReady = false,
): StartResponse {
  const appUrl = miniAppUrl ? new URL(miniAppUrl) : null;
  if (workspaceId) appUrl?.searchParams.set("workspace", workspaceId);
  if (chatType === "private") {
    const keyboard = appUrl
      ? new InlineKeyboard().webApp("Открыть панель", appUrl.toString())
      : undefined;
    return {
      message: !appUrl
        ? "Панель пока не настроена. Попробуйте позже."
        : privateMenuReady
          ? "Напоминания, участники и настройки — в панели. В следующий раз её можно открыть кнопкой «Напоминания» рядом с полем ввода."
          : "Напоминания, участники и настройки — в панели. Откройте её кнопкой ниже. Постоянное меню временно недоступно.",
      keyboard,
      removeReplyKeyboard: true,
    };
  }

  return {
    message: hasMainWebApp
      ? "Откройте панель, чтобы настроить напоминания, темы и ответственных."
      : "Откройте бота и нажмите «Открыть панель», чтобы настроить напоминания, темы и ответственных.",
    keyboard: new InlineKeyboard().url(
      hasMainWebApp ? "Открыть панель" : "Открыть бота",
      `https://t.me/${botUsername}?${hasMainWebApp ? "startapp" : "start"}=${workspaceId ? `ws_${workspaceId}` : "panel"}`,
    ),
  };
}
