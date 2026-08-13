import { InlineKeyboard, Keyboard } from "grammy";
import { memberImportRequestId } from "./member-import.js";

export interface ManagedWorkspaceOption {
  workspaceId: string;
  displayName: string;
}

interface StartResponse {
  message: string;
  keyboard?: InlineKeyboard | Keyboard;
}

export function buildStartResponse(
  chatType: string,
  miniAppUrl: string,
  botUsername: string,
  managedWorkspaces: ManagedWorkspaceOption[] = [],
): StartResponse {
  if (chatType === "private") {
    const keyboard = new Keyboard();
    if (miniAppUrl) {
      keyboard.webApp("Открыть панель", miniAppUrl);
    }
    for (const [index, workspace] of managedWorkspaces.entries()) {
      if (miniAppUrl || index > 0) {
        keyboard.row();
      }
      const suffix = managedWorkspaces.length > 1 ? ` · ${workspace.displayName}` : "";
      keyboard.requestUsers(
        `Добавить участников${suffix}`.slice(0, 64),
        memberImportRequestId(workspace.workspaceId),
        {
          user_is_bot: false,
          max_quantity: 10,
          request_name: true,
          request_username: true,
        },
      );
    }
    return {
      message: managedWorkspaces.length > 0
        ? "Готово: личные уведомления подключены. Открой панель или добавь участников нужной группы."
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
