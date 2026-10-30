import { createHmac, timingSafeEqual } from "node:crypto";
import {
  GroupConnectionError, GroupConnectionsRepository, UsersRepository,
  WorkspacesRepository, WorkspaceMembersRepository,
  type AppConfig, type GroupConnection, type GroupConnectionInput, type InitDataUser,
} from "@zvenfit-reminder/shared";
import type { Api } from "grammy";
import type { ChatAdministratorRights, KeyboardButton } from "grammy/types";

export interface GroupConnectionResponse {
  connectionId: string;
  state: GroupConnection["state"];
  expiresAt: string;
  preparedButtonId?: string;
  fallbackUrl?: string;
  workspaceId?: string;
  errorCode?: string;
  message?: string;
}
type GroupTelegramApi = Pick<Api, "getMe" | "getChat" | "getChatMember" | "savePreparedKeyboardButton">;
export interface GroupConnectionDependencies {
  connections: Pick<GroupConnectionsRepository, "create" | "get" | "getByRequest" | "savePreparedButton" | "beginValidation" | "complete" | "reject">;
  users: Pick<UsersRepository, "observe">;
  workspaces: Pick<WorkspacesRepository, "getById">;
  members: Pick<WorkspaceMembersRepository, "getByUserId">;
}
const rights: ChatAdministratorRights = {
  is_anonymous: false, can_manage_chat: true, can_delete_messages: false,
  can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false,
  can_change_info: false, can_invite_users: false, can_post_stories: false,
  can_edit_stories: false, can_delete_stories: false,
};
export function groupSelectionButton(requestId: number): KeyboardButton.RequestChatButton {
  return { text: "Выбрать группу", request_chat: { request_id: requestId, chat_is_channel: false,
    request_title: true, user_administrator_rights: { ...rights }, bot_administrator_rights: { ...rights } } };
}
const messages: Record<string, string> = {
  expired: "Время подключения истекло. Начните подключение группы заново.",
  native_unavailable: "Выбор группы в приложении сейчас недоступен. Продолжите в личном чате с ботом.",
  telegram_unavailable: "Telegram временно недоступен. Повторите проверку выбранной группы.",
  actor_not_admin: "Для подключения нужно быть администратором выбранной группы.",
  bot_not_admin: "Разрешите боту управлять группой и повторите проверку.",
  invalid_group: "Выберите группу или супергруппу Telegram.",
  workspace_closed: "Эта группа закрыта в приложении. Подключение не изменит её состояние.",
  membership_changed: "Права в группе изменились во время проверки. Повторите проверку.",
  selection_required: "Сначала выберите группу в Telegram.",
};

export function createGroupConnectionService(config: AppConfig, api: GroupTelegramApi, provided?: GroupConnectionDependencies) {
  const dependencies: GroupConnectionDependencies = provided ?? {
    connections: new GroupConnectionsRepository(config.ydbEndpoint, config.ydbDatabase),
    users: new UsersRepository(config.ydbEndpoint, config.ydbDatabase),
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
  };
  let identity: ReturnType<GroupTelegramApi["getMe"]> | undefined;
  function botIdentity() {
    identity ??= api.getMe().catch((error: unknown) => { identity = undefined; throw error; });
    return identity;
  }
  function startToken(connection: GroupConnection): string {
    const id = connection.connectionId.replaceAll("-", "");
    const signature = createHmac("sha256", config.botToken)
      .update(`group-connect:${connection.actorUserId}:${connection.connectionId}`).digest("base64url").slice(0, 16);
    return `connect_${id}_${signature}`;
  }
  async function response(connection: GroupConnection, extraCode?: string): Promise<GroupConnectionResponse> {
    let errorCode = extraCode ?? connection.errorCode;
    let state = connection.state;
    let workspaceId = connection.workspaceId;
    if (state === "connected" && workspaceId) {
      const [workspace, member] = await Promise.all([
        dependencies.workspaces.getById(workspaceId), dependencies.members.getByUserId(workspaceId, connection.actorUserId),
      ]);
      if (workspace?.status !== "active" || member?.status !== "active") {
        state = "rejected"; errorCode = "membership_changed"; workspaceId = undefined;
      }
    }
    if (state === "expired") errorCode = "expired";
    const canSelect = state === "pending" && connection.selectedChatId == null;
    return {
      connectionId: connection.connectionId, state, expiresAt: connection.expiresAt,
      ...(canSelect && connection.preparedButtonId ? { preparedButtonId: connection.preparedButtonId } : {}),
      ...(canSelect ? { fallbackUrl: `https://t.me/${(await botIdentity()).username}?start=${startToken(connection)}` } : {}),
      ...(workspaceId ? { workspaceId } : {}), ...(errorCode ? { errorCode, message: messages[errorCode] ?? "Не удалось подключить группу. Повторите проверку." } : {}),
    };
  }
  async function validate(actorUserId: number, connectionId: string, selectedChatId?: number) {
    let claim: GroupConnection;
    try { claim = await dependencies.connections.beginValidation(actorUserId, connectionId, selectedChatId); }
    catch (error) {
      if (error instanceof GroupConnectionError && error.code === "validation_in_progress")
        return dependencies.connections.get(actorUserId, connectionId);
      throw error;
    }
    if (claim.state !== "validating") return claim;
    try {
      const chatId = claim.selectedChatId!;
      const [chat, bot] = await Promise.all([api.getChat(chatId), botIdentity()]);
      if (chat.id !== chatId || (chat.type !== "group" && chat.type !== "supergroup"))
        return dependencies.connections.reject(claim, "invalid_group");
      const [actor, memberBot] = await Promise.all([
        api.getChatMember(chatId, actorUserId), api.getChatMember(chatId, bot.id),
      ]);
      if (actor.user.id !== actorUserId || actor.user.is_bot ||
        (actor.status !== "creator" && (actor.status !== "administrator" || !actor.can_manage_chat)))
        return dependencies.connections.reject(claim, "actor_not_admin");
      if (memberBot.user.id !== bot.id || !memberBot.user.is_bot ||
        memberBot.status !== "administrator" || !memberBot.can_manage_chat)
        return dependencies.connections.reject(claim, "bot_not_admin");
      return await dependencies.connections.complete(claim, { title: chat.title,
        isForum: chat.type === "supergroup" && chat.is_forum === true, timezone: config.defaultTimezone });
    } catch {
      // Selection is durable even if the webhook response is acknowledged after an error.
      return dependencies.connections.reject(claim, "telegram_unavailable");
    }
  }
  return {
    async create(actor: InitDataUser, input: GroupConnectionInput): Promise<GroupConnectionResponse> {
      let connection = await dependencies.connections.create(actor.id, input);
      await dependencies.users.observe({ userId: actor.id, username: actor.username ?? null,
        displayName: [actor.first_name, actor.last_name].filter(Boolean).join(" ") || "User", privateChatId: null });
      if (connection.state === "pending" && connection.launchMode === "native" && !connection.preparedButtonId) {
        try {
          const prepared = await api.savePreparedKeyboardButton(actor.id, groupSelectionButton(connection.requestId));
          connection = await dependencies.connections.savePreparedButton(actor.id, connection.connectionId, prepared.id);
        } catch { return response(connection, "native_unavailable"); }
      }
      return response(connection);
    },
    async get(actorUserId: number, connectionId: string) {
      return response(await dependencies.connections.get(actorUserId, connectionId));
    },
    async retry(actorUserId: number, connectionId: string) {
      return response(await validate(actorUserId, connectionId));
    },
    async forStart(actorUserId: number, token: string): Promise<GroupConnection> {
      const match = /^connect_([0-9a-f]{32})_([A-Za-z0-9_-]{16})$/.exec(token);
      if (!match) throw new GroupConnectionError("not_found");
      const hex = match[1];
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const connection = await dependencies.connections.get(actorUserId, id);
      const expected = Buffer.from(startToken(connection));
      const supplied = Buffer.from(token);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new GroupConnectionError("not_found");
      return connection;
    },
    async acceptShared(actorUserId: number, requestId: number, chatId: number): Promise<GroupConnectionResponse | null> {
      if (!Number.isSafeInteger(requestId) || requestId < 1 || requestId > 2147483647 || !Number.isSafeInteger(chatId) || chatId >= 0) return null;
      const connection = await dependencies.connections.getByRequest(actorUserId, requestId);
      if (!connection) return null;
      return response(await validate(actorUserId, connection.connectionId, chatId));
    },
  };
}
export type GroupConnectionService = ReturnType<typeof createGroupConnectionService>;
