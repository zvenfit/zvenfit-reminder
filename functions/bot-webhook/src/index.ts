import {
  InstancesRepository,
  MembersRepository,
  OccurrenceNotActionableError,
  RemindersRepository,
  RulesRepository,
  UndoWindowExpiredError,
  WorkspaceMembersRepository,
  WorkspaceChatAlreadyRegisteredError,
  WorkspacesRepository,
  buildOccurrenceMessage,
  escapeHtml,
  formatAmount,
  formatDueDate,
  loadConfig,
  parseInstanceCallbackData,
  parseOccurrenceCallbackData,
  occurrenceCallbackData,
  validateInitData,
  type ParsedInitData,
  type Rule,
} from "@zvenfit-reminder/shared";
import { Bot, InlineKeyboard, type BotConfig, type Context } from "grammy";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import {
  createRuleSchema,
  getHeader,
  getPath,
  jsonResponse,
  updateRuleSchema,
} from "./api.js";
import { ensureBotInitialized } from "./bot-initialization.js";
import { importSharedGroupMembers } from "./member-import.js";
import { syncGroupMembers, type SyncedTelegramUser } from "./members-sync.js";
import { buildStartResponse } from "./start-response.js";
import { managedWorkspaces, workspaceForMemberImport } from "./bot-workspaces.js";
import {
  UniversalOccurrenceActionForbiddenError,
  UniversalOccurrenceActionNotFoundError,
  executeUniversalOccurrenceAction,
  type UniversalOccurrenceActionResult,
} from "./universal-occurrence-actions.js";
import { handleUniversalApi } from "./universal-api.js";
import { observeTelegramIdentity } from "./telegram-observation.js";

let botInstance: Bot | null = null;

function occurrenceKeyboard(occurrenceId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Выполнил", occurrenceCallbackData("done", occurrenceId))
    .text("⏰ +1 час", occurrenceCallbackData("snooze", occurrenceId));
}

function formatOccurrenceInstant(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(instant);
}

function renderOccurrenceAction(
  result: UniversalOccurrenceActionResult,
  actor: { id: number; first_name: string; last_name?: string },
): { text: string; keyboard: InlineKeyboard; callbackNotice: string } {
  const { occurrence, action } = result;
  const actorName = escapeHtml(
    [actor.first_name, actor.last_name].filter(Boolean).join(" ") || "Участник",
  );
  const actorMention = `<a href="tg://user?id=${actor.id}">${actorName}</a>`;
  const base = buildOccurrenceMessage(occurrence);
  if (action === "done") {
    const undoUntil = occurrence.undoUntil
      ? formatOccurrenceInstant(occurrence.undoUntil, occurrence.timezone)
      : null;
    return {
      text: `${base}\n\n✅ Выполнено: ${actorMention}${undoUntil ? `\nОтменить можно до ${escapeHtml(undoUntil)}` : ""}`,
      keyboard: new InlineKeyboard().text(
        "↩️ Отменить выполнение",
        occurrenceCallbackData("undo", occurrence.occurrenceId),
      ),
      callbackNotice: "Готово",
    };
  }
  if (action === "snooze") {
    const nextAt = occurrence.nextNotificationAt
      ? formatOccurrenceInstant(occurrence.nextNotificationAt, occurrence.timezone)
      : "позже";
    return {
      text: `${base}\n\n⏰ Отложено: ${escapeHtml(nextAt)}\nИзменил: ${actorMention}`,
      keyboard: occurrenceKeyboard(occurrence.occurrenceId),
      callbackNotice: "Напомню позже",
    };
  }
  return {
    text: `${base}\n\n↩️ Выполнение отменено: ${actorMention}`,
    keyboard: occurrenceKeyboard(occurrence.occurrenceId),
    callbackNotice: "Снова активно",
  };
}

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
  const workspacesRepo = new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase);
  const workspaceMembersRepo = new WorkspaceMembersRepository(
    config.ydbEndpoint,
    config.ydbDatabase,
  );

  const cachedBotInfo = process.env.BOT_INFO_JSON
    ? JSON.parse(process.env.BOT_INFO_JSON) as NonNullable<BotConfig<Context>["botInfo"]>
    : undefined;
  const bot = new Bot(
    config.botToken,
    cachedBotInfo ? { botInfo: cachedBotInfo } : undefined,
  );
  const observeSyncedGroupUser = (chatId: number) => config.universalRemindersEnabled
    ? async (user: SyncedTelegramUser) =>
        observeTelegramIdentity(
          config,
          {
            id: user.id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            languageCode: user.language_code,
          },
          { id: chatId, type: "group" },
        )
    : undefined;

  // Universal mode authorizes each group through its workspace. Legacy mode
  // keeps the historical single-chat boundary.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const isAllowedChat = config.universalRemindersEnabled
      ? isGroupChat && chatId != null &&
        (await workspacesRepo.getByTelegramChatId(chatId))?.status === "active"
      : chatId === config.allowedChatId;
    const isPrivateAdmin = ctx.chat?.type === "private" && userId != null && config.adminUserIds.includes(userId);
    const isAllowedPrivate = !config.universalRemindersEnabled &&
      ctx.chat?.type === "private" && config.adminUserIds.length === 0;
    const callbackData = ctx.callbackQuery && "data" in ctx.callbackQuery
      ? ctx.callbackQuery.data
      : null;
    const isUniversalPrivateCallback =
      config.universalRemindersEnabled &&
      ctx.chat?.type === "private" &&
      userId != null &&
      callbackData != null &&
      parseOccurrenceCallbackData(callbackData) != null;
    const isUniversalPrivateStart =
      config.universalRemindersEnabled &&
      ctx.chat?.type === "private" &&
      userId != null &&
      ctx.message?.text?.startsWith("/start") === true;
    const isUniversalPrivateUsersShared =
      config.universalRemindersEnabled &&
      ctx.chat?.type === "private" &&
      userId != null &&
      ctx.message?.users_shared != null;
    const isUniversalGroupSetup =
      config.universalRemindersEnabled &&
      isGroupChat &&
      userId != null &&
      ctx.message?.text?.startsWith("/setup") === true;

    if (
      !isAllowedChat &&
      !isPrivateAdmin &&
      !isAllowedPrivate &&
      !isUniversalPrivateCallback &&
      !isUniversalPrivateStart &&
      !isUniversalPrivateUsersShared &&
      !isUniversalGroupSetup
    ) {
      return;
    }

    if (isAllowedChat && chatId != null && userId) {
      const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "User";
      // Кэшируем участников группы для Mini App
      await membersRepo.upsert(chatId, userId, ctx.from?.username ?? null, displayName);
    }

    if (config.universalRemindersEnabled && ctx.from && ctx.chat &&
      (ctx.chat.type === "private" || isAllowedChat)) {
      await observeTelegramIdentity(
        config,
        {
          id: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          languageCode: ctx.from.language_code,
        },
        {
          id: ctx.chat.id,
          type: ctx.chat.type === "private" ? "private" : "group",
        },
      );
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const actorWorkspaces = config.universalRemindersEnabled &&
      ctx.chat.type === "private" && ctx.from
      ? await workspacesRepo.listForUser(ctx.from.id)
      : [];
    const manageable = managedWorkspaces(actorWorkspaces);
    const response = buildStartResponse(
      ctx.chat.type,
      config.miniAppUrl,
      bot.botInfo.username,
      manageable.map(({ workspaceId, displayName }) => ({ workspaceId, displayName })),
    );
    await ctx.reply(response.message, {
      reply_markup: response.keyboard,
    });
  });

  bot.on("message:users_shared", async (ctx) => {
    if (
      !config.universalRemindersEnabled ||
      ctx.chat.type !== "private" ||
      !ctx.from
    ) {
      return;
    }

    const actorWorkspaces = await workspacesRepo.listForUser(ctx.from.id);
    const workspace = workspaceForMemberImport(
      actorWorkspaces,
      ctx.message.users_shared.request_id,
    );
    if (!workspace) {
      await ctx.reply("Добавлять участников может только владелец или организатор группы.");
      return;
    }

    const result = await importSharedGroupMembers(
      workspace.telegramChatId,
      ctx.message.users_shared.users,
      {
        getChatMember: (chatId, userId) => bot.api.getChatMember(chatId, userId),
        saveMember: async (membership) => {
          const user = membership.user;
          const displayName = [user.first_name, user.last_name]
            .filter(Boolean)
            .join(" ") || user.username || "User";
          await membersRepo.upsert(
            workspace.telegramChatId,
            user.id,
            user.username ?? null,
            displayName,
          );
          await observeTelegramIdentity(
            config,
            {
              id: user.id,
              username: user.username,
              firstName: user.first_name,
              lastName: user.last_name,
              languageCode: user.language_code,
            },
            { id: workspace.telegramChatId, type: "group" },
          );
        },
      },
    );

    const response = buildStartResponse(
      "private",
      config.miniAppUrl,
      bot.botInfo.username,
      managedWorkspaces(actorWorkspaces).map(({ workspaceId, displayName }) => ({
        workspaceId,
        displayName,
      })),
    );
    const skippedText = result.skipped > 0
      ? ` Не добавлено: ${result.skipped} — они не состоят в группе «${workspace.displayName}» или недоступны.`
      : "";
    await ctx.reply(
      `✅ ${workspace.displayName}: добавлено участников — ${result.imported}.${skippedText}`,
      { reply_markup: response.keyboard },
    );
  });

  bot.command("list", async (ctx) => {
    if (config.universalRemindersEnabled) {
      const workspace = ctx.chat.type !== "private"
        ? await workspacesRepo.getByTelegramChatId(ctx.chat.id)
        : null;
      if (!workspace || !ctx.from) {
        await ctx.reply("Откройте панель в личном чате или выполните команду в настроенной группе.");
        return;
      }
      const remindersRepo = new RemindersRepository(
        config.ydbEndpoint,
        config.ydbDatabase,
      );
      const reminders = await remindersRepo.listForActor(workspace.workspaceId, ctx.from.id);
      await ctx.reply(
        reminders.length === 0
          ? "Активных напоминаний нет."
          : `Активные напоминания:\n${reminders.map((reminder) => `• ${reminder.title}`).join("\n")}`,
      );
      return;
    }
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

  if (config.universalRemindersEnabled) {
    bot.command("setup", async (ctx) => {
      if (ctx.chat.type === "private" || !ctx.from) {
        await ctx.reply("Настройка доступна только в группе.");
        return;
      }
      let telegramAdmin = false;
      try {
        const membership = await ctx.getChatMember(ctx.from.id);
        telegramAdmin =
          membership.status === "creator" || membership.status === "administrator";
      } catch {
        telegramAdmin = false;
      }
      if (!telegramAdmin) {
        await ctx.reply("Создать workspace может только администратор группы.");
        return;
      }

      const existing = await workspacesRepo.getByTelegramChatId(ctx.chat.id);
      if (existing) {
        await ctx.reply("Workspace уже настроен.");
        return;
      }
      try {
        await workspacesRepo.create({
          telegramChatId: ctx.chat.id,
          displayName: ctx.chat.title || "Группа",
          ownerUserId: ctx.from.id,
          timezone: config.defaultTimezone,
        });
        let synced = 1;
        try {
          synced = await syncGroupMembers(
            bot.api,
            ctx.chat.id,
            membersRepo,
            ctx.from.id,
            observeSyncedGroupUser(ctx.chat.id),
          );
        } catch {
          // Workspace is already valid; /sync can retry member discovery later.
        }
        await ctx.reply(
          `✅ Workspace создан. Участников синхронизировано: ${synced}. Можно переходить к новым напоминаниям.`,
        );
      } catch (error) {
        if (error instanceof WorkspaceChatAlreadyRegisteredError) {
          await ctx.reply("Workspace уже настроен.");
          return;
        }
        throw error;
      }
    });
  }

  bot.command("sync", async (ctx) => {
    if (!config.universalRemindersEnabled) {
      if (ctx.chat.id !== config.allowedChatId) {
        await ctx.reply("Команда доступна только в настроенной группе.");
        return;
      }
      try {
        const synced = await syncGroupMembers(
          bot.api,
          config.allowedChatId,
          membersRepo,
          ctx.from?.id,
        );
        const members = await membersRepo.list(config.allowedChatId);
        await ctx.reply(`Участники обновлены: ${members.length} в списке (${synced} из Telegram).`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Не удалось синхронизировать участников.");
      }
      return;
    }

    const workspace = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? await workspacesRepo.getByTelegramChatId(ctx.chat.id)
      : null;
    if (!workspace || workspace.status !== "active") {
      await ctx.reply("Сначала настройте эту группу командой /setup.");
      return;
    }

    try {
      const synced = await syncGroupMembers(
        bot.api,
        workspace.telegramChatId,
        membersRepo,
        ctx.from?.id,
        observeSyncedGroupUser(workspace.telegramChatId),
      );
      const members = await membersRepo.list(workspace.telegramChatId);
      await ctx.reply(`Участники обновлены: ${members.length} в списке (${synced} из Telegram).`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось синхронизировать участников.");
    }
  });

  bot.on("chat_member", async (ctx) => {
    if (!config.universalRemindersEnabled) {
      if (ctx.chatMember.chat.id !== config.allowedChatId) {
        return;
      }
      const status = ctx.chatMember.new_chat_member.status;
      const user = ctx.chatMember.new_chat_member.user;
      if (user.is_bot || status === "left" || status === "kicked") {
        return;
      }
      const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "User";
      await membersRepo.upsert(
        config.allowedChatId,
        user.id,
        user.username ?? null,
        displayName,
      );
      return;
    }

    const workspace = await workspacesRepo.getByTelegramChatId(ctx.chatMember.chat.id);
    if (!workspace || workspace.status !== "active") {
      return;
    }

    const status = ctx.chatMember.new_chat_member.status;
    const user = ctx.chatMember.new_chat_member.user;
    if (user.is_bot) {
      return;
    }
    const restrictedOutsideGroup = status === "restricted" &&
      "is_member" in ctx.chatMember.new_chat_member &&
      ctx.chatMember.new_chat_member.is_member === false;
    if (status === "left" || status === "kicked" || restrictedOutsideGroup) {
      const removed = await workspaceMembersRepo.remove(workspace.workspaceId, user.id);
      if (removed.pausedReminderIds.length > 0) {
        const managers = (await workspaceMembersRepo.listProfiles(workspace.workspaceId))
          .filter((member) => member.role === "owner" || member.role === "organizer")
          .map((member) =>
            `<a href="tg://user?id=${member.userId}">${escapeHtml(member.displayName)}</a>`)
          .join(" ");
        await bot.api.sendMessage(
          workspace.telegramChatId,
          `⚠️ ${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ") || "Участник")} вышел из группы. Приостановлено напоминаний: ${removed.pausedReminderIds.length}. Нужно переназначить ответственного.${managers ? `\n${managers}` : ""}`,
          { parse_mode: "HTML" },
        );
      }
      return;
    }

    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "User";
    await membersRepo.upsert(workspace.telegramChatId, user.id, user.username ?? null, displayName);
    await observeSyncedGroupUser(workspace.telegramChatId)?.(user);
  });

  bot.command("done", async (ctx) => {
    if (config.universalRemindersEnabled) {
      await ctx.reply("Используйте кнопку «Выполнил» под напоминанием.");
      return;
    }
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
    if (config.universalRemindersEnabled) {
      await ctx.reply("В новых напоминаниях используйте «Напомнить позже».");
      return;
    }
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
    const universalCallback = config.universalRemindersEnabled
      ? parseOccurrenceCallbackData(ctx.callbackQuery.data)
      : null;
    if (universalCallback) {
      if (!ctx.from || !ctx.chat) {
        await ctx.answerCallbackQuery();
        return;
      }

      let result: UniversalOccurrenceActionResult;
      try {
        result = await executeUniversalOccurrenceAction(config, {
          source: "telegram",
          action: universalCallback.action,
          occurrenceId: universalCallback.occurrenceId,
          actorUserId: ctx.from.id,
          chatId: ctx.chat.id,
          chatType: ctx.chat.type === "private" ? "private" : "group",
        });
      } catch (error) {
        if (error instanceof UniversalOccurrenceActionForbiddenError) {
          await ctx.answerCallbackQuery({
            text: "У вас нет доступа к этому действию",
            show_alert: true,
          });
          return;
        }
        if (error instanceof UniversalOccurrenceActionNotFoundError) {
          await ctx.answerCallbackQuery({
            text: "Напоминание больше недоступно",
            show_alert: true,
          });
          return;
        }
        if (error instanceof UndoWindowExpiredError) {
          await ctx.answerCallbackQuery({
            text: "10 минут на отмену уже прошли",
            show_alert: true,
          });
          return;
        }
        if (error instanceof OccurrenceNotActionableError) {
          await ctx.answerCallbackQuery({ text: "Состояние уже изменилось" });
          return;
        }
        await ctx.answerCallbackQuery({
          text: "Не удалось выполнить действие. Попробуйте ещё раз",
          show_alert: true,
        });
        return;
      }

      const rendered = renderOccurrenceAction(result, ctx.from);
      try {
        await ctx.editMessageText(rendered.text, {
          parse_mode: "HTML",
          reply_markup: rendered.keyboard,
        });
        await ctx.answerCallbackQuery({ text: rendered.callbackNotice });
      } catch {
        await ctx.answerCallbackQuery({
          text: "Действие сохранено, но сообщение не обновилось",
          show_alert: true,
        });
      }
      return;
    }

    const parsed = parseInstanceCallbackData(ctx.callbackQuery.data);
    if (config.universalRemindersEnabled) {
      await ctx.answerCallbackQuery();
      return;
    }
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

  if (config.universalRemindersEnabled) {
    if (method === "POST" && path === "/api/members/sync") {
      const workspaceId = getHeader(event, "X-Workspace-Id")?.trim();
      const workspacesRepo = new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase);
      const workspaceMembersRepo = new WorkspaceMembersRepository(
        config.ydbEndpoint,
        config.ydbDatabase,
      );
      const workspace = workspaceId ? await workspacesRepo.getById(workspaceId) : null;
      const actor = workspace
        ? await workspaceMembersRepo.getByUserId(workspace.workspaceId, parsedInit.user.id)
        : null;
      if (!workspaceId) {
        return jsonResponse(400, { error: "Choose a workspace", code: "workspace_required" });
      }
      if (!workspace || workspace.status !== "active" || !actor || actor.status !== "active") {
        return jsonResponse(403, { error: "Workspace membership required", code: "forbidden" });
      }
      try {
        const synced = await syncGroupMembers(
          getBot().api,
          workspace.telegramChatId,
          membersRepo,
          parsedInit.user.id,
          async (user) => observeTelegramIdentity(
            config,
            {
              id: user.id,
              username: user.username,
              firstName: user.first_name,
              lastName: user.last_name,
              languageCode: user.language_code,
            },
            { id: workspace.telegramChatId, type: "group" },
          ),
        );
        const members = await workspaceMembersRepo.listProfiles(workspace.workspaceId);
        return jsonResponse(200, { members, synced });
      } catch (error) {
        return jsonResponse(502, {
          error: error instanceof Error ? error.message : "Failed to sync members",
        });
      }
    }
    const universalResponse = await handleUniversalApi(event, config, parsedInit);
    if (universalResponse) {
      return universalResponse;
    }
    return jsonResponse(404, { error: "Not found" });
  }

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
        config.universalRemindersEnabled
          ? async (user) =>
              observeTelegramIdentity(
                config,
                {
                  id: user.id,
                  username: user.username,
                  firstName: user.first_name,
                  lastName: user.last_name,
                  languageCode: user.language_code,
                },
                { id: config.allowedChatId, type: "group" },
              )
          : undefined,
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
    await ensureBotInitialized(bot);
    const update = JSON.parse(event.body ?? "{}");
    await bot.handleUpdate(update);
    return { statusCode: 200, body: "" };
  }

  return jsonResponse(404, { error: "Not found" });
}
