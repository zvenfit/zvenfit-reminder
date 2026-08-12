import {
  InstancesRepository,
  MembersRepository,
  RulesRepository,
  buildReminderMessage,
  getCurrentRecurringDueAt,
  instanceCallbackData,
  loadConfig,
  shouldSendReminder,
} from "@zvenfit-reminder/shared";
import { InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";

interface CronEvent {
  messages?: unknown[];
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup: InlineKeyboard,
): Promise<number> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram sendMessage failed: ${errorText}`);
  }

  const data = (await response.json()) as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

export async function handler(_event: CronEvent = {}): Promise<{ statusCode: number; body: string }> {
  const config = loadConfig();
  const rulesRepo = new RulesRepository(config.ydbEndpoint, config.ydbDatabase);
  const instancesRepo = new InstancesRepository(config.ydbEndpoint, config.ydbDatabase);
  const membersRepo = new MembersRepository(config.ydbEndpoint, config.ydbDatabase);

  const now = new Date();
  const rules = await rulesRepo.listActive();
  const members = await membersRepo.list(config.allowedChatId);
  let sent = 0;
  let retried = 0;
  const errors: string[] = [];

  for (const rule of rules) {
    if (rule.chatId !== config.allowedChatId) {
      continue;
    }

    let dueAt: Date | null = null;

    if (rule.ruleType === "recurring" && rule.dayOfMonth != null) {
      dueAt = getCurrentRecurringDueAt(rule.dayOfMonth, rule.timeLocal, rule.timezone, now)?.dueAt ?? null;
    }

    if (rule.ruleType === "oneoff" && rule.dueAt) {
      dueAt = rule.dueAt;
    }

    if (!dueAt || !shouldSendReminder(dueAt, now)) {
      continue;
    }

    const existing = await instancesRepo.findByRuleAndDueAt(rule.id, dueAt);
    if (existing?.messageId) {
      continue;
    }
    if (existing && existing.status !== "pending") {
      continue;
    }

    const instanceId: string = existing?.id ?? randomUUID();
    const messageText = buildReminderMessage(rule, members);
    const keyboard = new InlineKeyboard()
      .text("✅ Done", instanceCallbackData("done", instanceId))
      .text("⏭ Skip", instanceCallbackData("skip", instanceId));

    try {
      const messageId = await sendTelegramMessage(config.botToken, rule.chatId, messageText, keyboard);

      if (existing) {
        await instancesRepo.setMessageId(existing.id, messageId);
        retried += 1;
      } else {
        await instancesRepo.create(rule.id, dueAt, messageId, instanceId);
      }

      sent += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, sent, retried, errors, checkedRules: rules.length }),
  };
}
