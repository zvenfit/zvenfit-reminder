import { getBot } from "./index.js";

export async function startPollingBot(): Promise<void> {
  const bot = getBot();
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  bot.start({
    onStart: () => console.log("Telegram bot: long polling started"),
  });
}
