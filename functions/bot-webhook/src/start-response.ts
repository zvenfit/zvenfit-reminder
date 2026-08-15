import { InlineKeyboard, Keyboard } from "grammy";
import { memberImportRequestId } from "./member-import.js";

export interface ManagedWorkspaceOption {
  workspaceId: string;
  displayName: string;
}

interface StartResponse {
  message: string;
  keyboard?: InlineKeyboard;
  removeReplyKeyboard?: boolean;
  memberPicker?: {
    message: string;
    keyboard: Keyboard;
  };
}

export function buildStartResponse(
  chatType: string,
  miniAppUrl: string,
  botUsername: string,
  managedWorkspaces: ManagedWorkspaceOption[] = [],
): StartResponse {
  if (chatType === "private") {
    const keyboard = miniAppUrl
      ? new InlineKeyboard().webApp("Открыть панель", miniAppUrl)
      : undefined;
    const memberPickerKeyboard = new Keyboard();
    for (const [index, workspace] of managedWorkspaces.entries()) {
      if (index > 0) {
        memberPickerKeyboard.row();
      }
      const suffix = managedWorkspaces.length > 1 ? ` · ${workspace.displayName}` : "";
      memberPickerKeyboard.requestUsers(
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
        : "Готово: личные уведомления подключены. Открой панель напоминаний.",
      keyboard,
      removeReplyKeyboard: true,
      memberPicker: memberPickerKeyboard.keyboard.some((row) => row.length > 0)
        ? {
            message: "Добавление участников",
            keyboard: memberPickerKeyboard.resized().persistent(),
          }
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
