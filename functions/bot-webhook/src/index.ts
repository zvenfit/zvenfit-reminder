import {
  InstancesRepository,
  MembersRepository,
  RulesRepository,
  formatAmount,
  formatDueDate,
  loadConfig,
  parseInstanceCallbackData,
  validateInitData,
  type ParsedInitData,
  type Rule,
} from "@zvenfit-reminder/shared";
import { Bot, InlineKeyboard } from "grammy";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import {
  createRuleSchema,
  getHeader,
  getPath,
  jsonResponse,
  updateRuleSchema,
} from "./api.js";
import { syncGroupMembers } from "./members-sync.js";

let botInstance: Bot | null = null;

function resolveInitData(initData: string | undefined, botToken: string): ParsedInitData {
  if (process.env.SKIP_INIT_DATA_VALIDATION === "1" && process.env.NODE_ENV !== "production") {
    const devUserId = Number(process.env.DEV_USER_ID ?? "0");
    if (!devUserId) {
      throw new Error("DEV_USER_ID required when SKIP_INIT_DATA_VALIDATION=1");
    }
    return {
      user: { id: devUserId, first_name: "Dev" },
      authDate: Math.floor(Date.now() / 1000),
      hash: "",
      raw: {},
    };
  }

  if (!initData) {
    throw new Error("Missing X-Telegram-Init-Data");
  }

  return validateInitData(initData, botToken);
}

export function getBot(): Bot {
  if (botInstance) {
    return botInstance;
  }

  const config = loadConfig();
  const rulesRepo = new RulesRepository(config.ydbEndpoint, config.ydbDatabase);
  const instancesRepo = new InstancesRepository(config.ydbEndpoint, config.ydbDatabase);
  const membersRepo = new MembersRepository(config.ydbEndpoint, config.ydbDatabase);

  const bot = new Bot(config.botToken);

  // Whitelist: только разрешённая группа и админы в личке
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const isAllowedChat = chatId === config.allowedChatId;
    const isPrivateAdmin = ctx.chat?.type === "private" && userId != null && config.adminUserIds.includes(userId);
    const isAllowedPrivate = ctx.chat?.type === "private" && config.adminUserIds.length === 0;

    if (!isAllowedChat && !isPrivateAdmin && !isAllowedPrivate) {
      return;
    }

    if (chatId === config.allowedChatId && userId) {
      const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "User";
      // Кэшируем участников группы для Mini App
      await membersRepo.upsert(chatId, userId, ctx.from?.username ?? null, displayName);
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const keyboard = config.miniAppUrl
      ? new InlineKeyboard().webApp("Открыть панель", config.miniAppUrl)
      : undefined;

    await ctx.reply("Бот напоминаний о платежах. Управляй правилами через Mini App или команды.", {
      reply_markup: keyboard,
    });
  });

  bot.command("list", async (ctx) => {
    const rules = await rulesRepo.list(config.allowedChatId, "active");
    if (rules.length === 0) {
      await ctx.reply("Активных правил нет.");
      return;
    }

    const lines = rules.map((rule: Rule) => {
      const amount = formatAmount(rule.amount);
      const schedule =
        rule.ruleType === "recurring"
          ? `каждое ${rule.dayOfMonth}-е в ${rule.timeLocal}`
          : rule.dueAt
            ? formatDueDate(rule.dueAt, rule.timezone)
            : "разово";
      return `• ${rule.title}${amount ? ` (${amount})` : ""} — ${schedule}`;
    });

    await ctx.reply(`Активные правила:\n${lines.join("\n")}`);
  });

  bot.command("sync", async (ctx) => {
    if (ctx.chat?.id !== config.allowedChatId) {
      await ctx.reply("Команда доступна только в семейной группе.");
      return;
    }

    try {
      const synced = await syncGroupMembers(bot.api, config.allowedChatId, membersRepo, ctx.from?.id);
      const members = await membersRepo.list(config.allowedChatId);
      await ctx.reply(`Участники обновлены: ${members.length} в списке (${synced} из Telegram).`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось синхронизировать участников.");
    }
  });

  bot.on("chat_member", async (ctx) => {
    if (ctx.chatMember.chat.id !== config.allowedChatId) {
      return;
    }

    const status = ctx.chatMember.new_chat_member.status;
    if (status === "left" || status === "kicked") {
      return;
    }

    const user = ctx.chatMember.new_chat_member.user;
    if (user.is_bot) {
      return;
    }

    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "User";
    await membersRepo.upsert(config.allowedChatId, user.id, user.username ?? null, displayName);
  });

  bot.command("done", async (ctx) => {
    const instanceId = ctx.match?.trim();
    if (!instanceId || !ctx.from) {
      await ctx.reply("Использование: /done <instance_id>");
      return;
    }

    const instance = await instancesRepo.complete(instanceId, ctx.from.id);
    if (!instance) {
      await ctx.reply("Задача не найдена.");
      return;
    }

    const rule = await rulesRepo.getById(instance.ruleId);
    if (rule?.ruleType === "oneoff") {
      await rulesRepo.archive(rule.id);
    }

    await ctx.reply("✅ Отмечено как выполнено.");
  });

  bot.command("skip", async (ctx) => {
    const instanceId = ctx.match?.trim();
    if (!instanceId) {
      await ctx.reply("Использование: /skip <instance_id>");
      return;
    }

    const instance = await instancesRepo.skip(instanceId);
    if (!instance) {
      await ctx.reply("Задача не найдена.");
      return;
    }

    const rule = await rulesRepo.getById(instance.ruleId);
    if (rule?.ruleType === "oneoff") {
      await rulesRepo.archive(rule.id);
    }

    await ctx.reply("⏭ Пропущено.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = parseInstanceCallbackData(ctx.callbackQuery.data);
    if (!parsed || !ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (parsed.action === "done") {
      await instancesRepo.complete(parsed.instanceId, ctx.from.id);
      const instance = await instancesRepo.getById(parsed.instanceId);
      if (instance) {
        const rule = await rulesRepo.getById(instance.ruleId);
        if (rule?.ruleType === "oneoff") {
          await rulesRepo.archive(rule.id);
        }
      }
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n✅ Выполнено`);
    } else {
      await instancesRepo.skip(parsed.instanceId);
      const instance = await instancesRepo.getById(parsed.instanceId);
      if (instance) {
        const rule = await rulesRepo.getById(instance.ruleId);
        if (rule?.ruleType === "oneoff") {
          await rulesRepo.archive(rule.id);
        }
      }
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n⏭ Пропущено`);
    }

    await ctx.answerCallbackQuery();
  });

  botInstance = bot;
  return bot;
}

async function handleApi(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  // REST API для Mini App, авторизация через X-Telegram-Init-Data
  const config = loadConfig();
  const method = event.httpMethod ?? "GET";
  const path = getPath(event);

  if (method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  const initData = getHeader(event, "X-Telegram-Init-Data");
  let parsedInit: ParsedInitData;
  try {
    parsedInit = resolveInitData(initData, config.botToken);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : "Unauthorized" });
  }

  const rulesRepo = new RulesRepository(config.ydbEndpoint, config.ydbDatabase);
  const instancesRepo = new InstancesRepository(config.ydbEndpoint, config.ydbDatabase);
  const membersRepo = new MembersRepository(config.ydbEndpoint, config.ydbDatabase);

  if (method === "GET" && path === "/api/rules") {
    const rules = await rulesRepo.list(config.allowedChatId);
    return jsonResponse(200, { rules });
  }

  if (method === "GET" && path === "/api/members") {
    const members = await membersRepo.list(config.allowedChatId);
    return jsonResponse(200, { members });
  }

  if (method === "POST" && path === "/api/members/sync") {
    try {
      const bot = getBot();
      const synced = await syncGroupMembers(
        bot.api,
        config.allowedChatId,
        membersRepo,
        parsedInit.user.id,
      );
      const members = await membersRepo.list(config.allowedChatId);
      return jsonResponse(200, { members, synced });
    } catch (error) {
      return jsonResponse(502, {
        error: error instanceof Error ? error.message : "Failed to sync members",
      });
    }
  }

  if (method === "POST" && path === "/api/rules") {
    const body = JSON.parse(event.body ?? "{}");
    const parsed = createRuleSchema.parse(body);
    const rule = await rulesRepo.create(
      {
        ...parsed,
        chatId: config.allowedChatId,
      },
      config.defaultTimezone,
    );
    return jsonResponse(201, { rule });
  }

  const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
  if (ruleMatch) {
    const ruleId = decodeURIComponent(ruleMatch[1]);

    if (method === "PUT") {
      const body = JSON.parse(event.body ?? "{}");
      const parsed = updateRuleSchema.parse(body);
      const rule = await rulesRepo.update(ruleId, parsed);
      if (!rule) {
        return jsonResponse(404, { error: "Rule not found" });
      }
      return jsonResponse(200, { rule });
    }

    if (method === "DELETE") {
      await rulesRepo.archive(ruleId);
      return jsonResponse(200, { ok: true });
    }
  }

  const completeMatch = path.match(/^\/api\/instances\/([^/]+)\/complete$/);
  if (method === "POST" && completeMatch) {
    const instanceId = decodeURIComponent(completeMatch[1]);
    const instance = await instancesRepo.complete(instanceId, parsedInit.user.id);
    if (!instance) {
      return jsonResponse(404, { error: "Instance not found" });
    }
    const rule = await rulesRepo.getById(instance.ruleId);
    if (rule?.ruleType === "oneoff") {
      await rulesRepo.archive(rule.id);
    }
    return jsonResponse(200, { instance });
  }

  return jsonResponse(404, { error: "Not found" });
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const path = getPath(event);
  const method = event.httpMethod ?? "GET";

  if (path.startsWith("/api")) {
    return handleApi(event);
  }

  if (path === "/webhook" && method === "POST") {
    const config = loadConfig();
    const secret = getHeader(event, "X-Telegram-Bot-Api-Secret-Token");
    if (secret !== config.webhookSecret) {
      return { statusCode: 403, body: "Forbidden" };
    }

    const bot = getBot();
    const update = JSON.parse(event.body ?? "{}");
    await bot.handleUpdate(update);
    return { statusCode: 200, body: "" };
  }

  return jsonResponse(404, { error: "Not found" });
}
