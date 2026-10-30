import {
  effectiveTopicConnection, TopicConnectionsRepository,
  type AppConfig, type TopicConnection,
} from "@zvenfit-reminder/shared";
import type { Api } from "grammy";
import { createTopicLinkResolver, InvalidTopicLinkError, parseTopicLink } from "./topic-link.js";

export interface TopicConnectionResponse {
  connectionId: string;
  state: TopicConnection["state"];
  expiresAt: string;
  messageThreadId?: number;
  name?: string;
  errorCode?: string;
  message?: string;
}
const messages: Record<string, string> = {
  invalid_topic_link: "Не удалось найти тему в выбранной группе. Проверьте ссылку.",
  telegram_unavailable: "Telegram временно недоступен. Запустите новую проверку позже.",
  topic_closed: "Тема закрыта. Откройте её в Telegram или выберите другую.",
  topic_deleted: "Тема не найдена. Проверьте ссылку или выберите другую тему.",
  telegram_forbidden: "Бот не может писать в эту группу. Проверьте его права в Telegram.",
  telegram_rejected: "Telegram отклонил проверочное сообщение. Проверьте тему и права бота.",
  delivery_unknown: "Ответ Telegram не получен. Если проверочное сообщение появилось в теме, нажмите на нём «Подтвердить подключение». Новая проверка может отправить ещё одно сообщение.",
  destination_mismatch: "Telegram не подтвердил отправку в выбранную тему. Проверьте ссылку перед новой попыткой.",
  expired: "Время проверки истекло. Начните новую проверку.",
};
export function topicConnectionResponse(connection: TopicConnection, now = new Date()): TopicConnectionResponse {
  const current = effectiveTopicConnection(connection, now);
  return {
    connectionId: current.connectionId, state: current.state, expiresAt: current.expiresAt.toISOString(),
    ...(current.state === "succeeded" ? { messageThreadId: current.messageThreadId, name: current.name } : {}),
    ...(current.errorCode ? { errorCode: current.errorCode, message: messages[current.errorCode] ?? messages.telegram_rejected } : {}),
  };
}
function sendFailure(error: unknown): { state: "failed" | "unknown"; code: string } {
  const value = error as { error_code?: unknown; description?: unknown } | null;
  if (typeof value?.error_code !== "number") return { state: "unknown", code: "delivery_unknown" };
  const description = typeof value.description === "string" ? value.description.toLowerCase() : "";
  const code = description.includes("topic_closed") || description.includes("topic closed") ? "topic_closed"
    : description.includes("message thread not found") || description.includes("topic_deleted") ? "topic_deleted"
      : value.error_code === 403 ? "telegram_forbidden" : "telegram_rejected";
  return { state: "failed", code };
}
type Repository = Pick<TopicConnectionsRepository, "create" | "claim" | "get" | "finish">;
export class TopicConnectionService {
  constructor(private readonly repository: Repository, private readonly api: Pick<Api, "getChat" | "sendMessage">) {}

  async start(input: { workspaceId: string; actorUserId: number; telegramChatId: number;
    clientRequestId: string; link: string; name: string }): Promise<TopicConnectionResponse> {
    const { workspaceId, actorUserId, telegramChatId, ...payload } = input;
    const candidate = parseTopicLink(payload.link);
    const connection = await this.repository.create(workspaceId, actorUserId, telegramChatId,
      { ...payload, messageThreadId: candidate.messageThreadId });
    if (connection.state !== "pending") return topicConnectionResponse(connection);
    // Claim before any network call. A duplicate HTTP request can read/poll but
    // cannot publish another probe, even if the first response was lost.
    const claimed = await this.repository.claim(connection.connectionId);
    if (!claimed) return topicConnectionResponse((await this.repository.get(connection.connectionId)) ?? connection);
    try {
      await createTopicLinkResolver(this.api).resolve(telegramChatId, payload.link);
    } catch (error) {
      const failed = await this.repository.finish(claimed.connectionId, "failed",
        error instanceof InvalidTopicLinkError ? "invalid_topic_link" : "telegram_unavailable");
      return topicConnectionResponse(failed ?? claimed);
    }
    let response: Awaited<ReturnType<Api["sendMessage"]>>;
    try {
      response = await this.api.sendMessage(telegramChatId,
        "Проверка темы для напоминаний. Если приложение не подтвердило подключение, нажмите кнопку ниже.", {
          message_thread_id: claimed.messageThreadId,
          disable_notification: true,
          reply_markup: { inline_keyboard: [[{
            text: "Подтвердить подключение", callback_data: `topic_connect:${claimed.connectionId}`,
          }]] },
        });
    } catch (error) {
      const failure = sendFailure(error);
      const failed = await this.repository.finish(claimed.connectionId, failure.state, failure.code);
      return topicConnectionResponse(failed ?? claimed);
    }
    if (response.chat.id !== telegramChatId || response.message_thread_id !== claimed.messageThreadId ||
      response.is_topic_message !== true) {
      return topicConnectionResponse((await this.repository.finish(claimed.connectionId, "unknown", "destination_mismatch")) ?? claimed);
    }
    // If this transaction fails, the saved sending operation and its callback
    // remain recoverable; never report it as a definite Telegram send failure.
    return topicConnectionResponse((await this.repository.finish(claimed.connectionId, "succeeded")) ?? claimed);
  }
  async get(connectionId: string, workspaceId: string, actorUserId: number): Promise<TopicConnectionResponse | null> {
    const connection = await this.repository.get(connectionId);
    return connection && connection.workspaceId === workspaceId && connection.actorUserId === actorUserId
      ? topicConnectionResponse(connection) : null;
  }
  async confirm(input: { connectionId: string; actorUserId: number; chatId: number;
    messageThreadId?: number; isTopicMessage?: boolean }): Promise<boolean> {
    if (!/^[a-f0-9]{32}$/.test(input.connectionId)) return false;
    const connection = await this.repository.get(input.connectionId);
    if (!connection || connection.actorUserId !== input.actorUserId || connection.telegramChatId !== input.chatId ||
      connection.messageThreadId !== input.messageThreadId || !input.isTopicMessage || connection.expiresAt <= new Date()) return false;
    const result = await this.repository.finish(connection.connectionId, "succeeded");
    return result?.state === "succeeded";
  }
}
export function createTopicConnectionService(config: AppConfig, api: Pick<Api, "getChat" | "sendMessage">): TopicConnectionService {
  return new TopicConnectionService(new TopicConnectionsRepository(config.ydbEndpoint, config.ydbDatabase), api);
}
