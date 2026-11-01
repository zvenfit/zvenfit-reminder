import { getBot, initializeBotRuntime } from "./index.js";

export async function startPollingBot(): Promise<void> {
  const bot = getBot();
  await initializeBotRuntime(bot);
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  bot.start({
    allowed_updates: ["message", "callback_query", "chat_member"],
    onStart: () => console.log("Telegram bot: long polling started"),
  });
}
