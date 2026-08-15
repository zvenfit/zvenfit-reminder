import type { AppConfig } from "@zvenfit-reminder/shared";
import { Bot } from "grammy";
import { memberImportRequestId } from "./member-import.js";
import { telegramClientOptions } from "./telegram-network.js";

const TELEGRAM_API_TIMEOUT_SECONDS = 5;

export interface MemberPickerPreparer {
  prepare(userId: number, workspaceId: string): Promise<string>;
}

export function memberPickerButton(workspaceId: string) {
  return {
    text: "Добавить участников",
    request_users: {
      request_id: memberImportRequestId(workspaceId),
      user_is_bot: false,
      max_quantity: 10,
      request_name: true,
      request_username: true,
    },
  } as const;
}

export function createMemberPickerPreparer(config: AppConfig): MemberPickerPreparer {
  const bot = new Bot(config.botToken, {
    client: telegramClientOptions(TELEGRAM_API_TIMEOUT_SECONDS, config),
  });
  return {
    async prepare(userId, workspaceId) {
      const prepared = await bot.api.savePreparedKeyboardButton(
        userId,
        memberPickerButton(workspaceId),
      );
      return prepared.id;
    },
  };
}
