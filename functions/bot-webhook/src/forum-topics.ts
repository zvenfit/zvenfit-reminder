import { telegramThreadIdSchema, type TopicObservation } from "@zvenfit-reminder/shared";

interface TopicMessage {
  date: number;
  chat: { type: string; is_forum?: boolean };
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  forum_topic_closed?: object;
  forum_topic_reopened?: object;
  reply_to_message?: { forum_topic_created?: { name: string } };
}

export function topicObservation(message: TopicMessage | undefined, updateId: number): TopicObservation | null {
  if (!message || message.chat.type !== "supergroup" || !message.chat.is_forum) return null;
  const thread = telegramThreadIdSchema.safeParse(message.message_thread_id);
  if (!thread.success || !message.is_topic_message) return null;
  const name = (message.forum_topic_created?.name || message.forum_topic_edited?.name)?.trim();
  // A reply to the creation message contains the original name, even after a rename.
  const fallbackName = message.reply_to_message?.forum_topic_created?.name.trim();
  return {
    messageThreadId: thread.data,
    ...(name ? { name } : {}),
    ...(fallbackName ? { fallbackName } : {}),
    ...(message.forum_topic_closed ? { isClosed: true } : {}),
    ...(message.forum_topic_reopened ? { isClosed: false } : {}),
    updateId,
    messageDate: message.date,
  };
}
