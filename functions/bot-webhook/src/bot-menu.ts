import type { Bot } from "grammy";

const configured = new WeakMap<Bot, Promise<void>>();

export function ensureBotMenu(bot: Bot, miniAppUrl: string): Promise<void> {
  const previous = configured.get(bot);
  if (previous) return previous;
  const operation = (async () => {
    if (miniAppUrl) {
      await bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "Напоминания", web_app: { url: miniAppUrl } },
      });
    }
    await bot.api.setMyCommands([
      { command: "menu", description: "Открыть напоминания и настройки" },
      { command: "app", description: "Открыть приложение" },
      { command: "setup", description: "Подключить группу" },
      { command: "topic", description: "Подключить текущую тему" },
      { command: "members", description: "Пригласить участников" },
    ]);
  })().catch((error: unknown) => {
    configured.delete(bot);
    throw error;
  });
  configured.set(bot, operation);
  return operation;
}

/** Explicit private-chat overrides take precedence over Telegram's default menu. */
export async function restorePrivateBotMenu(bot: Bot, miniAppUrl: string, chatId: number): Promise<boolean> {
  if (!miniAppUrl) return false;
  await bot.api.setChatMenuButton({
    chat_id: chatId,
    menu_button: { type: "web_app", text: "Напоминания", web_app: { url: miniAppUrl } },
  });
  return true;
}
