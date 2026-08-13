import type { Bot } from "grammy";

const initializationByBot = new WeakMap<Bot, Promise<void>>();

export async function ensureBotInitialized(bot: Bot): Promise<void> {
  const existing = initializationByBot.get(bot);
  if (existing) {
    await existing;
    return;
  }

  const initialization = bot.init().catch((error: unknown) => {
    initializationByBot.delete(bot);
    throw error;
  });
  initializationByBot.set(bot, initialization);
  await initialization;
}
