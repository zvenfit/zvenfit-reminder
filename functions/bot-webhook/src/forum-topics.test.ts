import { describe, expect, it } from "vitest";
import { topicObservation } from "./forum-topics.js";

const message = {
  date: 100,
  chat: { type: "supergroup", is_forum: true },
  is_topic_message: true,
  message_thread_id: 42,
};

describe("topicObservation", () => {
  it("learns a topic from a message without inventing a name or reopening it", () => {
    expect(topicObservation(message, 10)).toEqual({ messageThreadId: 42, updateId: 10, messageDate: 100 });
  });
  it("observes creation, rename, close, and reopen", () => {
    expect(topicObservation({ ...message, forum_topic_created: { name: "Оплаты" } }, 10))
      .toMatchObject({ name: "Оплаты", messageThreadId: 42 });
    expect(topicObservation({ ...message, forum_topic_edited: { name: "Счета" } }, 11))
      .toMatchObject({ name: "Счета" });
    expect(topicObservation({ ...message, forum_topic_closed: {} }, 12)).toMatchObject({ isClosed: true });
    expect(topicObservation({ ...message, forum_topic_reopened: {} }, 13)).toMatchObject({ isClosed: false });
  });
  it("preserves a name on icon-only edits and reads the topic creation reply", () => {
    expect(topicObservation({ ...message, forum_topic_edited: { name: "" } }, 10)).not.toHaveProperty("name");
    expect(topicObservation({ ...message, reply_to_message: { forum_topic_created: { name: "Оплаты" } } }, 11))
      .toMatchObject({ fallbackName: "Оплаты" });
  });
  it("ignores ordinary groups, private topics, General and invalid thread IDs", () => {
    for (const id of [undefined, 0, 1, -2, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(topicObservation({ ...message, message_thread_id: id }, 10)).toBeNull();
    }
    expect(topicObservation({ ...message, chat: { type: "group" } }, 10)).toBeNull();
    expect(topicObservation({ ...message, chat: { type: "private", is_forum: true } }, 10)).toBeNull();
    expect(topicObservation({ ...message, is_topic_message: false }, 10)).toBeNull();
  });
});
