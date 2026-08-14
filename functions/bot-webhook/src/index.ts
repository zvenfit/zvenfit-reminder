import {
  DeliveryInProgressError,
  OccurrenceNotActionableError,
  RemindersRepository,
  UndoWindowExpiredError,
  WorkspaceMembersRepository,
  WorkspaceChatAlreadyRegisteredError,
  WorkspacesRepository,
  escapeHtml,
  loadConfig,
  parseOccurrenceCallbackData,
  validateInitData,
  type ParsedInitData,
} from "@zvenfit-reminder/shared";
import { Bot, type BotConfig, type Context } from "grammy";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import { getHeader, getPath, jsonResponse } from "./api.js";
import { ensureBotInitialized } from "./bot-initialization.js";
import { importSharedGroupMembers } from "./member-import.js";
import { syncGroupMembers, type SyncedTelegramUser } from "./members-sync.js";
import { buildStartResponse } from "./start-response.js";
import { managedWorkspaces, workspaceForMemberImport } from "./bot-workspaces.js";
import {
  OccurrenceActionForbiddenError,
  OccurrenceActionNotFoundError,
  executeOccurrenceAction,
  type OccurrenceActionResult,
} from "./occurrence-actions.js";
import { renderOccurrenceAction } from "./occurrence-message.js";
import { handleWorkspaceApi } from "./workspace-api.js";
import { observeTelegramIdentity } from "./telegram-observation.js";

let botInstance: Bot | null = null;
const TELEGRAM_API_TIMEOUT_SECONDS = 5;
const WEBHOOK_FAILURE_TEXT =
  "⚠️ Бот временно не может связаться с Telegram API. Попробуйте ещё раз через минуту.";

export function resolveInitData(initData: string | undefined, botToken: string): ParsedInitData {
  if (process.env.SKIP_INIT_DATA_VALIDATION === "1" && process.env.NODE_ENV === "development") {
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

export function isWebhookRequest(path: string, method: string): boolean {
  return method === "POST" && (path === "/webhook" || path === "/");
}

export function buildWebhookFailureResponse(update: unknown): ApiGatewayResponse {
  if (!update || typeof update !== "object") {
    return { statusCode: 200, body: "" };
  }

  const value = update as {
    message?: { chat?: { id?: unknown } };
    callback_query?: { id?: unknown };
  };
  const callbackQueryId = value.callback_query?.id;
  if (typeof callbackQueryId === "string") {
    return jsonResponse(200, {
      method: "answerCallbackQuery",
      callback_query_id: callbackQueryId,
      text: WEBHOOK_FAILURE_TEXT,
      show_alert: true,
    });
  }

  const chatId = value.message?.chat?.id;
  if (typeof chatId === "number" || typeof chatId === "string") {
    return jsonResponse(200, {
      method: "sendMessage",
      chat_id: chatId,
      text: WEBHOOK_FAILURE_TEXT,
    });
  }

  return { statusCode: 200, body: "" };
}

export function getBot(): Bot {
  if (botInstance) {
    return botInstance;
  }

  const config = loadConfig();
  const workspacesRepo = new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase);
  const workspaceMembersRepo = new WorkspaceMembersRepository(
    config.ydbEndpoint,
    config.ydbDatabase,
  );

  const cachedBotInfo = process.env.BOT_INFO_JSON
    ? JSON.parse(process.env.BOT_INFO_JSON) as NonNullable<BotConfig<Context>["botInfo"]>
    : undefined;
  const bot = new Bot(config.botToken, {
    ...(cachedBotInfo ? { botInfo: cachedBotInfo } : {}),
    client: { timeoutSeconds: TELEGRAM_API_TIMEOUT_SECONDS },
  });
  const observeSyncedGroupUser = (chatId: number) => async (user: SyncedTelegramUser) =>
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
    );

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const isConfiguredGroup = isGroupChat && chatId != null &&
      (await workspacesRepo.getByTelegramChatId(chatId))?.status === "active";
    const callbackData = ctx.callbackQuery && "data" in ctx.callbackQuery
      ? ctx.callbackQuery.data
      : null;
    const isPrivateCallback =
      ctx.chat?.type === "private" &&
      userId != null &&
      callbackData != null &&
      parseOccurrenceCallbackData(callbackData) != null;
    const isPrivateStart =
      ctx.chat?.type === "private" &&
      userId != null &&
      ctx.message?.text?.startsWith("/start") === true;
    const isPrivateUsersShared =
      ctx.chat?.type === "private" &&
      userId != null &&
      ctx.message?.users_shared != null;
    const isGroupSetup =
      isGroupChat &&
      userId != null &&
      ctx.message?.text?.startsWith("/setup") === true;

    if (
      !isConfiguredGroup &&
      !isPrivateCallback &&
      !isPrivateStart &&
      !isPrivateUsersShared &&
      !isGroupSetup
    ) {
      return;
    }

    if (ctx.from && ctx.chat && (ctx.chat.type === "private" || isConfiguredGroup || isGroupSetup)) {
      await observeTelegramIdentity(
        config,
        {
          id: ctx.from.id,
          isBot: ctx.from.is_bot,
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
    const actorWorkspaces = ctx.chat.type === "private" && ctx.from
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
    const workspace = ctx.chat.type !== "private"
      ? await workspacesRepo.getByTelegramChatId(ctx.chat.id)
      : null;
    if (!workspace || !ctx.from) {
      await ctx.reply("Откройте панель в личном чате или выполните команду в настроенной группе.");
      return;
    }
    const remindersRepo = new RemindersRepository(config.ydbEndpoint, config.ydbDatabase);
    const reminders = (await remindersRepo.listForActor(workspace.workspaceId, ctx.from.id))
      .filter((reminder) => reminder.visibility === "group");
    await ctx.reply(
      reminders.length === 0
        ? "Активных напоминаний нет."
        : `Активные напоминания:\n${reminders.map((reminder) => `• ${reminder.title}`).join("\n")}`,
    );
  });

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
      const currentOwner = await workspaceMembersRepo.getByUserId(
        existing.workspaceId,
        existing.ownerUserId,
      );
      if (currentOwner?.status !== "active") {
        try {
          await workspacesRepo.claimVacantOwnership(existing.workspaceId, ctx.from.id);
          await ctx.reply("✅ Управление группой восстановлено. Теперь вы владелец настроек напоминаний.");
          return;
        } catch {
          await ctx.reply("Workspace уже настроен, но владельца не удалось восстановить.");
          return;
        }
      }
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
      await observeTelegramIdentity(
        config,
        {
          id: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          languageCode: ctx.from.language_code,
        },
        { id: ctx.chat.id, type: "group" },
      );
      let synced = 1;
      try {
        const createdWorkspace = (await workspacesRepo.getByTelegramChatId(ctx.chat.id))!;
        const knownMembers = await workspaceMembersRepo.listProfiles(createdWorkspace.workspaceId);
        synced = await syncGroupMembers(
          bot.api,
          ctx.chat.id,
          knownMembers.map((member) => member.userId),
          observeSyncedGroupUser(ctx.chat.id),
          ctx.from.id,
          (userId) => workspaceMembersRepo.remove(createdWorkspace.workspaceId, userId)
            .then(() => undefined),
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

  bot.command("sync", async (ctx) => {
    const workspace = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? await workspacesRepo.getByTelegramChatId(ctx.chat.id)
      : null;
    if (!workspace || workspace.status !== "active") {
      await ctx.reply("Сначала настройте эту группу командой /setup.");
      return;
    }
    const actor = ctx.from
      ? await workspaceMembersRepo.getByUserId(workspace.workspaceId, ctx.from.id)
      : null;
    if (!actor || (actor.role !== "owner" && actor.role !== "organizer")) {
      await ctx.reply("Обновлять участников может только владелец или организатор группы.");
      return;
    }

    try {
      const knownMembers = await workspaceMembersRepo.listProfiles(workspace.workspaceId);
      const synced = await syncGroupMembers(
        bot.api,
        workspace.telegramChatId,
        knownMembers.map((member) => member.userId),
        observeSyncedGroupUser(workspace.telegramChatId),
        ctx.from?.id,
        (userId) => workspaceMembersRepo.remove(workspace.workspaceId, userId)
          .then(() => undefined),
      );
      const members = await workspaceMembersRepo.listProfiles(workspace.workspaceId);
      await ctx.reply(`Участники обновлены: ${members.length} в списке (${synced} из Telegram).`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось синхронизировать участников.");
    }
  });

  bot.on("chat_member", async (ctx) => {
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

    await observeSyncedGroupUser(workspace.telegramChatId)(user);
  });

  bot.command("done", async (ctx) => {
    await ctx.reply("Используйте кнопку «Выполнил» под напоминанием.");
  });

  bot.command("skip", async (ctx) => {
    await ctx.reply("Используйте «Напомнить позже» под напоминанием.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const occurrenceCallback = parseOccurrenceCallbackData(ctx.callbackQuery.data);
    if (occurrenceCallback) {
      if (!ctx.from || !ctx.chat) {
        await ctx.answerCallbackQuery();
        return;
      }

      let result: OccurrenceActionResult;
      try {
        result = await executeOccurrenceAction(config, {
          source: "telegram",
          action: occurrenceCallback.action,
          occurrenceId: occurrenceCallback.occurrenceId,
          actorUserId: ctx.from.id,
          actorDisplayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
          chatId: ctx.chat.id,
          chatType: ctx.chat.type === "private" ? "private" : "group",
          messageId: ctx.callbackQuery.message?.message_id,
        });
      } catch (error) {
        if (error instanceof DeliveryInProgressError) {
          await ctx.answerCallbackQuery({
            text: "Уведомление отправляется — повторите через секунду",
            show_alert: true,
          });
          return;
        }
        if (error instanceof OccurrenceActionForbiddenError) {
          await ctx.answerCallbackQuery({
            text: "У вас нет доступа к этому действию",
            show_alert: true,
          });
          return;
        }
        if (error instanceof OccurrenceActionNotFoundError) {
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

      const rendered = renderOccurrenceAction(result, {
        id: ctx.from.id,
        displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
      });
      await ctx.answerCallbackQuery({ text: rendered.callbackNotice });
      return;
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
    if (
      !workspace ||
      workspace.status !== "active" ||
      !actor ||
      actor.status !== "active" ||
      (actor.role !== "owner" && actor.role !== "organizer")
    ) {
      return jsonResponse(403, { error: "Workspace membership required", code: "forbidden" });
    }
    try {
      const knownMembers = await workspaceMembersRepo.listProfiles(workspace.workspaceId);
      const synced = await syncGroupMembers(
        getBot().api,
        workspace.telegramChatId,
        knownMembers.map((member) => member.userId),
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
        parsedInit.user.id,
        (userId) => workspaceMembersRepo.remove(workspace.workspaceId, userId)
          .then(() => undefined),
      );
      const refreshedActor = await workspaceMembersRepo.getByUserId(
        workspace.workspaceId,
        parsedInit.user.id,
      );
      if (!refreshedActor || refreshedActor.status !== "active") {
        return jsonResponse(403, { error: "Workspace membership required", code: "forbidden" });
      }
      const members = await workspaceMembersRepo.listProfiles(workspace.workspaceId);
      return jsonResponse(200, { members, synced });
    } catch (error) {
      return jsonResponse(502, {
        error: error instanceof Error ? error.message : "Failed to sync members",
      });
    }
  }
  const workspaceResponse = await handleWorkspaceApi(event, config, parsedInit);
  if (workspaceResponse) {
    return workspaceResponse;
  }
  return jsonResponse(404, { error: "Not found" });
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const path = getPath(event);
  const method = event.httpMethod ?? "GET";

  if (path.startsWith("/api")) {
    return handleApi(event);
  }

  if (isWebhookRequest(path, method)) {
    const config = loadConfig();
    const secret = getHeader(event, "X-Telegram-Bot-Api-Secret-Token");
    if (secret !== config.webhookSecret) {
      return { statusCode: 403, body: "Forbidden" };
    }

    const bot = getBot();
    await ensureBotInitialized(bot);
    const update = JSON.parse(event.body ?? "{}");
    try {
      await bot.handleUpdate(update);
      return { statusCode: 200, body: "" };
    } catch (error) {
      console.error("Telegram update processing failed", {
        updateId: typeof update?.update_id === "number" ? update.update_id : null,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return buildWebhookFailureResponse(update);
    }
  }

  return jsonResponse(404, { error: "Not found" });
}
