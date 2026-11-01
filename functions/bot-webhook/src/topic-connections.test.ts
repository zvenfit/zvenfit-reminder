import { describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import type { TopicConnection, TopicConnectionsRepository } from "@zvenfit-reminder/shared";
import { TopicConnectionService } from "./topic-connections.js";

const input = { workspaceId: "workspace-a", actorUserId: 20, telegramChatId: -1001234567890,
  clientRequestId: "bdcdd9fa-63e6-415e-ab60-3c6b4cb01254", link: "https://t.me/c/1234567890/42", name: "Оплаты" };
function setup() {
  let saved: TopicConnection = { ...input, connectionId: "a".repeat(32), messageThreadId: 42,
    state: "pending", expiresAt: new Date(Date.now() + 900_000), sendDeadline: new Date(Date.now() + 60_000) };
  const repository = {
    create: vi.fn(async () => ({ ...saved })),
    get: vi.fn(async () => ({ ...saved })),
    claim: vi.fn(async () => {
      if (saved.state !== "pending") return null;
      saved = { ...saved, state: "sending" };
      return { ...saved };
    }),
    finish: vi.fn(async (_id: string, state: "succeeded" | "failed" | "unknown", errorCode?: string) => {
      if (saved.state !== "succeeded") saved = { ...saved, state, errorCode };
      return { ...saved };
    }),
  } satisfies Pick<TopicConnectionsRepository, "create" | "get" | "claim" | "finish">;
  const api = {
    getChat: vi.fn().mockResolvedValue({ id: input.telegramChatId, type: "supergroup", is_forum: true }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 99, chat: { id: input.telegramChatId }, message_thread_id: 42, is_topic_message: true }),
  };
  const service = new TopicConnectionService(repository, api as unknown as Pick<Api, "getChat" | "sendMessage">);
  return { service, repository, api, setSaved: (changes: Partial<TopicConnection>) => { saved = { ...saved, ...changes }; } };
}
describe("topic connection verification", () => {
  it("publishes one quiet probe and completes only after matching Telegram evidence", async () => {
    const { service, repository, api } = setup();
    expect(await service.start(input)).toMatchObject({ state: "succeeded", messageThreadId: 42 });
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(input.telegramChatId, expect.any(String), {
      message_thread_id: 42, disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: "Подтвердить подключение", callback_data: `topic_connect:${"a".repeat(32)}` }]] },
    });
    expect(repository.finish).toHaveBeenCalledWith("a".repeat(32), "succeeded");
    expect(JSON.stringify(api.sendMessage.mock.calls)).not.toContain("tg://user");
  });
  it("does not publish a second probe for concurrent or replayed requests", async () => {
    const { service, api } = setup();
    await Promise.all([service.start(input), service.start(input)]);
    await service.start(input);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it.each([
    { chat: { id: -1009999999999 }, message_thread_id: 42, is_topic_message: true },
    { chat: { id: input.telegramChatId }, message_thread_id: 43, is_topic_message: true },
    { chat: { id: input.telegramChatId }, message_thread_id: 42 },
  ])("does not register when Telegram's actual destination does not match", async (response) => {
    const { service, api, repository } = setup();
    api.sendMessage.mockResolvedValue(response);
    expect(await service.start(input)).toMatchObject({ state: "unknown", errorCode: "destination_mismatch" });
    expect(repository.finish).not.toHaveBeenCalledWith(expect.anything(), "succeeded");
  });
  it("rejects a foreign group before sending a probe", async () => {
    const { service, api } = setup();
    expect(await service.start({ ...input, link: "https://t.me/c/9999999999/42" })).toMatchObject({ state: "failed", errorCode: "invalid_topic_link" });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("leaves a lost send response unknown and polls without resending", async () => {
    const { service, api } = setup();
    api.sendMessage.mockRejectedValue(new Error("timeout"));
    expect(await service.start(input)).toMatchObject({ state: "unknown", errorCode: "delivery_unknown" });
    expect(await service.get("a".repeat(32), input.workspaceId, 20)).toMatchObject({ state: "unknown" });
    expect(await service.start(input)).toMatchObject({ state: "unknown" });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it.each([
    [{ error_code: 400, description: "Bad Request: TOPIC_CLOSED" }, "topic_closed"],
    [{ error_code: 400, description: "Bad Request: message thread not found" }, "topic_deleted"],
    [{ error_code: 403, description: "Forbidden" }, "telegram_forbidden"],
  ])("reports a safe actionable Telegram rejection", async (error, errorCode) => {
    const { service, api } = setup();
    api.sendMessage.mockRejectedValue(error);
    expect(await service.start(input)).toMatchObject({ state: "failed", errorCode });
  });
  it("recovers an unknown send only from the initiating actor in the matching topic", async () => {
    const { service, setSaved } = setup();
    setSaved({ state: "unknown" });
    const evidence = { connectionId: "a".repeat(32), actorUserId: 20, chatId: input.telegramChatId, messageThreadId: 42, isTopicMessage: true };
    expect(await service.confirm({ ...evidence, actorUserId: 30 })).toBe(false);
    expect(await service.confirm({ ...evidence, chatId: -1009999999999 })).toBe(false);
    expect(await service.confirm({ ...evidence, messageThreadId: 43 })).toBe(false);
    expect(await service.confirm({ ...evidence, isTopicMessage: false })).toBe(false);
    expect(await service.confirm(evidence)).toBe(true);
  });
  it("does not disclose another actor's or workspace's operation", async () => {
    const { service } = setup();
    expect(await service.get("a".repeat(32), "workspace-b", 20)).toBeNull();
    expect(await service.get("a".repeat(32), input.workspaceId, 30)).toBeNull();
  });
  it("keeps database completion errors distinct from definite send failures", async () => {
    const { service, repository, api } = setup();
    repository.finish.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.start(input)).rejects.toThrow("database unavailable");
    await service.start(input);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(repository.finish).toHaveBeenCalledOnce();
  });
});

describe("topic confirmation races and uncertain sends", () => {
  const evidence = { connectionId: "a".repeat(32), actorUserId: 20,
    chatId: input.telegramChatId, messageThreadId: 42, isTopicMessage: true };
  it("rejects malformed links before creating an operation or contacting Telegram", async () => {
    const { service, repository, api } = setup();
    await expect(service.start({ ...input, link: "https://example.com/not-a-topic" })).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled(); expect(api.getChat).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects expired callback evidence even when Telegram delivered the probe", async () => {
    const { service, repository, api, setSaved } = setup();
    setSaved({ state: "unknown", expiresAt: new Date(0) });
    expect(await service.confirm(evidence)).toBe(false);
    expect(repository.finish).not.toHaveBeenCalled(); expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("propagates revoked organizer access during callback completion without another send", async () => {
    const { TopicRegistrationForbiddenError } = await import("@zvenfit-reminder/shared");
    const { service, repository, api, setSaved } = setup();
    setSaved({ state: "unknown" }); repository.finish.mockRejectedValueOnce(new TopicRegistrationForbiddenError());
    await expect(service.confirm(evidence)).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(api.getChat).not.toHaveBeenCalled(); expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("does not send when authorization is revoked between request creation and claim", async () => {
    const { TopicRegistrationForbiddenError } = await import("@zvenfit-reminder/shared");
    const { service, repository, api } = setup();
    repository.claim.mockRejectedValueOnce(new TopicRegistrationForbiddenError());
    await expect(service.start(input)).rejects.toBeInstanceOf(TopicRegistrationForbiddenError);
    expect(api.getChat).not.toHaveBeenCalled(); expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps callback success when a delayed send response is lost afterwards", async () => {
    const { service, api } = setup();
    let start!: () => void;
    let rejectSend!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const send = new Promise<never>((_resolve, reject) => { rejectSend = reject; });
    api.sendMessage.mockImplementationOnce(() => { start(); return send; });
    const request = service.start(input);
    await started;
    expect(await service.confirm(evidence)).toBe(true);
    rejectSend(new Error("late transport timeout"));
    expect(await request).toMatchObject({ state: "succeeded", messageThreadId: 42 });
    expect(await service.start(input)).toMatchObject({ state: "succeeded" });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it("reports an abandoned sending lease as unknown without repeating publication", async () => {
    const { service, api, setSaved } = setup();
    setSaved({ state: "sending", sendDeadline: new Date(0) });
    expect(await service.get(evidence.connectionId, input.workspaceId, 20)).toMatchObject({ state: "unknown", errorCode: "delivery_unknown" });
    expect(await service.start(input)).toMatchObject({ state: "unknown" });
    expect(api.sendMessage).not.toHaveBeenCalled(); expect(api.getChat).not.toHaveBeenCalled();
  });
  it("does not leak results or touch persistence for an invalid callback id", async () => {
    const { service, repository } = setup();
    expect(await service.confirm({ ...evidence, connectionId: "not-an-id" })).toBe(false);
    expect(repository.get).not.toHaveBeenCalled(); expect(repository.finish).not.toHaveBeenCalled();
  });
});
