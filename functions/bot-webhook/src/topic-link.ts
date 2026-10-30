import { telegramThreadIdSchema } from "@zvenfit-reminder/shared";
import type { Api } from "grammy";

export class InvalidTopicLinkError extends Error {}

export function parseTopicLink(value: string): { chatId?: number; username?: string; messageThreadId: number } {
  const invalid = () => new InvalidTopicLinkError("Вставьте ссылку на тему из Telegram.");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "https:" || !["t.me", "telegram.me"].includes(url.hostname) ||
    url.username || url.password || url.port || url.hash || url.searchParams.has("comment")) throw invalid();
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  const isPrivate = parts[0] === "c";
  const target = parts[isPrivate ? 1 : 0];
  const messageParts = parts.slice(isPrivate ? 2 : 1);
  if (!target || ![1, 2].includes(messageParts.length) || messageParts.some((part) => !/^[1-9]\d*$/.test(part))) throw invalid();
  const queryThreads = url.searchParams.getAll("thread");
  if (queryThreads.length > 1 || queryThreads.some((part) => !/^[1-9]\d*$/.test(part))) throw invalid();
  const thread = messageParts.length === 2 ? messageParts[0] : queryThreads[0] ?? messageParts[0];
  if (messageParts.length === 2 && queryThreads.length && queryThreads[0] !== thread) throw invalid();
  const parsedThread = telegramThreadIdSchema.safeParse(Number(thread));
  if (!parsedThread.success) throw new InvalidTopicLinkError("Выберите отдельную тему. «Общее» уже есть в списке.");
  if (isPrivate) {
    if (!/^[1-9]\d*$/.test(target)) throw invalid();
    const chatId = -1_000_000_000_000 - Number(target);
    if (!Number.isSafeInteger(chatId)) throw invalid();
    return { chatId, messageThreadId: parsedThread.data };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(target)) throw invalid();
  return { username: target.toLowerCase(), messageThreadId: parsedThread.data };
}

export interface TopicLinkResolver {
  resolve(telegramChatId: number, link: string): Promise<number>;
}

export function createTopicLinkResolver(api: Pick<Api, "getChat">): TopicLinkResolver {
  return {
    async resolve(telegramChatId, link) {
      const parsed = parseTopicLink(link);
      if (parsed.chatId != null && parsed.chatId !== telegramChatId) {
        throw new InvalidTopicLinkError("Эта тема из другой группы. Выберите тему текущей группы.");
      }
      // Resolve only the authenticated workspace's chat, never an arbitrary URL.
      const chat = await api.getChat(telegramChatId);
      if (chat.id !== telegramChatId || chat.type !== "supergroup" || !chat.is_forum) {
        throw new InvalidTopicLinkError("В этой группе не включены темы.");
      }
      if (parsed.username && ![chat.username, ...(chat.active_usernames ?? [])]
        .some((name) => name?.toLowerCase() === parsed.username)) {
        throw new InvalidTopicLinkError("Эта тема из другой группы. Выберите тему текущей группы.");
      }
      return parsed.messageThreadId;
    },
  };
}
