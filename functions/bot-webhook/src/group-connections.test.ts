import { describe, expect, it, vi } from "vitest";
import { GroupConnectionError, type AppConfig, type GroupConnection } from "@zvenfit-reminder/shared";
import type { Api } from "grammy";
import { createGroupConnectionService, groupSelectionButton, type GroupConnectionDependencies } from "./group-connections.js";

const connection: GroupConnection = {
  connectionId: "11111111-1111-5111-a111-111111111111", clientRequestId: "22222222-2222-4222-8222-222222222222",
  actorUserId: 10, launchMode: "native", requestId: 7, state: "pending", version: 0,
  expiresAt: "2099-10-30T10:00:00.000Z",
};
function setup() {
  const claim: GroupConnection = { ...connection, state: "validating", selectedChatId: -1001,
    validationToken: "33333333-3333-4333-8333-333333333333", version: 1 };
  const connected: GroupConnection = { ...claim, state: "connected", workspaceId: "44444444-4444-4444-8444-444444444444" };
  const connections = {
    create: vi.fn().mockResolvedValue(connection), get: vi.fn().mockResolvedValue(connection),
    getByRequest: vi.fn().mockResolvedValue(connection),
    savePreparedButton: vi.fn().mockImplementation(async (_actor, _id, id) => ({ ...connection, preparedButtonId: id })),
    beginValidation: vi.fn().mockResolvedValue(claim), complete: vi.fn().mockResolvedValue(connected),
    reject: vi.fn().mockImplementation(async (record, code) => ({ ...record, state: "rejected", errorCode: code })),
  };
  const dependencies = { connections, users: { observe: vi.fn().mockResolvedValue({}) },
    workspaces: { getById: vi.fn().mockResolvedValue({ status: "active" }) },
    members: { getByUserId: vi.fn().mockResolvedValue({ status: "active" }) } };
  const api = {
    getMe: vi.fn().mockResolvedValue({ id: 99, username: "reminder_bot", is_bot: true }),
    getChat: vi.fn().mockResolvedValue({ id: -1001, type: "supergroup", is_forum: true, title: "Команда" }),
    getChatMember: vi.fn().mockImplementation(async (_chat, id) => ({ status: "administrator", can_manage_chat: true,
      user: { id, is_bot: id === 99 } })),
    savePreparedKeyboardButton: vi.fn().mockResolvedValue({ id: "prepared" }),
  };
  const config = { botToken: "99:unit-test-only", defaultTimezone: "Europe/Moscow" } as AppConfig;
  const service = createGroupConnectionService(config, api as unknown as Api, dependencies as unknown as GroupConnectionDependencies);
  return { service, dependencies, connections, api, claim, connected };
}

describe("group connection service", () => {
  it("prepares an actor-bound non-channel selector with matching minimal admin rights and a UI fallback", async () => {
    const { service, api, dependencies } = setup();
    const response = await service.create({ id: 10, first_name: "Иван" }, connection);
    expect(api.savePreparedKeyboardButton).toHaveBeenCalledWith(10, groupSelectionButton(7));
    const button = groupSelectionButton(7);
    expect(button.request_chat).toMatchObject({ chat_is_channel: false, request_id: 7,
      user_administrator_rights: { can_manage_chat: true }, bot_administrator_rights: { can_manage_chat: true } });
    expect(button.request_chat.chat_is_forum).toBeUndefined();
    expect(button.request_chat.bot_is_member).toBeUndefined();
    expect(response.preparedButtonId).toBe("prepared");
    const token = new URL(response.fallbackUrl!).searchParams.get("start")!;
    expect(token.length).toBeLessThanOrEqual(64);
    expect(await service.forStart(10, token)).toEqual(connection);
    expect(dependencies.users.observe).toHaveBeenCalledWith(expect.objectContaining({ privateChatId: null }));
  });
  it("preserves fallback when prepared buttons are unsupported without marking it connected", async () => {
    const { service, api } = setup(); api.savePreparedKeyboardButton.mockRejectedValue(new Error("unsupported"));
    const result = await service.create({ id: 10 }, connection);
    expect(result).toMatchObject({ state: "pending", errorCode: "native_unavailable" });
    expect(result.fallbackUrl).toContain("https://t.me/reminder_bot?start=connect_");
  });
  it("does not prepare a native button for the private-chat launch path", async () => {
    const { service, api, connections } = setup();
    connections.create.mockResolvedValue({ ...connection, launchMode: "private_chat" });
    await service.create({ id: 10 }, { ...connection, launchMode: "private_chat" });
    expect(api.savePreparedKeyboardButton).not.toHaveBeenCalled();
  });
  it("rejects altered fallback tokens and delegates actor binding to the repository", async () => {
    const { service, connections } = setup();
    const token = new URL((await service.create({ id: 10 }, connection)).fallbackUrl!).searchParams.get("start")!;
    await expect(service.forStart(10, `${token.slice(0, -1)}!`)).rejects.toMatchObject({ code: "not_found" });
    connections.get.mockRejectedValue(new GroupConnectionError("not_found"));
    await expect(service.forStart(11, token)).rejects.toMatchObject({ code: "not_found" });
    expect(connections.get).toHaveBeenLastCalledWith(11, connection.connectionId);
  });
  it("persists selection before fresh group/actor/bot verification and then completes atomically", async () => {
    const { service, api, connections, claim } = setup();
    const result = await service.acceptShared(10, 7, -1001);
    expect(result).toMatchObject({ state: "connected" });
    expect(connections.getByRequest).toHaveBeenCalledWith(10, 7);
    expect(connections.beginValidation).toHaveBeenCalledWith(10, connection.connectionId, -1001);
    expect(connections.beginValidation.mock.invocationCallOrder[0]).toBeLessThan(api.getChat.mock.invocationCallOrder[0]);
    expect(api.getChatMember).toHaveBeenCalledWith(-1001, 10);
    expect(api.getChatMember).toHaveBeenCalledWith(-1001, 99);
    expect(connections.complete).toHaveBeenCalledWith(claim, { title: "Команда", isForum: true, timezone: "Europe/Moscow" });
  });
  it.each(["actor", "bot", "chat"])("rejects a failed %s check before membership creation", async kind => {
    const { service, api, connections } = setup();
    if (kind === "chat") api.getChat.mockResolvedValue({ id: -1002, type: "channel" } as never);
    else api.getChatMember.mockImplementation(async (_chat, id) => ({
      status: (kind === "actor" ? id === 10 : id === 99) ? "member" : "administrator",
      can_manage_chat: true, user: { id, is_bot: id === 99 },
    }) as never);
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "rejected",
      errorCode: kind === "actor" ? "actor_not_admin" : kind === "bot" ? "bot_not_admin" : "invalid_group" });
    expect(connections.complete).not.toHaveBeenCalled();
  });
  it("a transient failure can be retried only using the persisted selected group", async () => {
    const { service, api, connections } = setup(); api.getChat.mockRejectedValueOnce(new Error("timeout"));
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "rejected", errorCode: "telegram_unavailable" });
    expect(await service.retry(10, connection.connectionId)).toMatchObject({ state: "connected" });
    expect(connections.beginValidation).toHaveBeenLastCalledWith(10, connection.connectionId, undefined);
    expect(api.getChat).toHaveBeenLastCalledWith(-1001);
  });
  it("GET and a concurrent duplicate do not perform validation or send anything", async () => {
    const { service, api, connections, claim } = setup();
    connections.get.mockResolvedValue(claim);
    await service.get(10, connection.connectionId);
    connections.beginValidation.mockRejectedValue(new GroupConnectionError("validation_in_progress"));
    expect(await service.retry(10, connection.connectionId)).toMatchObject({ state: "validating" });
    expect(api.getChat).not.toHaveBeenCalled(); expect(api.savePreparedKeyboardButton).not.toHaveBeenCalled();
    expect(connections.complete).not.toHaveBeenCalled();
  });
  it("does not advertise a completed connection as accessible after member removal", async () => {
    const { service, connections, dependencies, connected } = setup();
    connections.get.mockResolvedValue(connected); dependencies.members.getByUserId.mockResolvedValue({ status: "removed" });
    expect(await service.get(10, connection.connectionId)).toMatchObject({ state: "rejected", errorCode: "membership_changed" });
    expect((await service.get(10, connection.connectionId)).workspaceId).toBeUndefined();
  });
});

describe("group onboarding replay and authorization boundaries", () => {
  it("rejects a forged fallback signature even when its length and alphabet are valid", async () => {
    const { service, connections } = setup();
    const token = new URL((await service.create({ id: 10 }, connection)).fallbackUrl!).searchParams.get("start")!;
    const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    await expect(service.forStart(10, forged)).rejects.toMatchObject({ code: "not_found" });
    expect(connections.get).toHaveBeenCalledWith(10, connection.connectionId);
    expect(connections.beginValidation).not.toHaveBeenCalled();
  });
  it.each([
    { requestId: 0, chatId: -1001 }, { requestId: 2147483648, chatId: -1001 },
    { requestId: 1.5, chatId: -1001 }, { requestId: 7, chatId: 10 },
    { requestId: 7, chatId: 0 }, { requestId: 7, chatId: -1.5 },
    { requestId: 7, chatId: -Number.MAX_SAFE_INTEGER - 1 },
  ])("rejects malformed shared identifiers before lookup: %j", async ({ requestId, chatId }) => {
    const { service, connections, api } = setup();
    expect(await service.acceptShared(10, requestId, chatId)).toBeNull();
    expect(connections.getByRequest).not.toHaveBeenCalled();
    expect(connections.beginValidation).not.toHaveBeenCalled();
    expect(api.getChat).not.toHaveBeenCalled();
  });
  it("does not validate an unknown or another actor's shared request", async () => {
    const { service, connections, api } = setup();
    connections.getByRequest.mockResolvedValue(null);
    expect(await service.acceptShared(20, 7, -1001)).toBeNull();
    expect(connections.getByRequest).toHaveBeenCalledExactlyOnceWith(20, 7);
    expect(connections.beginValidation).not.toHaveBeenCalled();
    expect(api.getMe).not.toHaveBeenCalled();
  });
  it("cannot change a previously selected group by replaying the chooser", async () => {
    const { service, connections, api } = setup();
    connections.beginValidation.mockRejectedValue(new GroupConnectionError("selection_conflict"));
    await expect(service.acceptShared(10, 7, -1002)).rejects.toMatchObject({ code: "selection_conflict" });
    expect(api.getChat).not.toHaveBeenCalled();
    expect(connections.complete).not.toHaveBeenCalled();
  });
  it("does not issue new buttons or Telegram verification for an expired operation", async () => {
    const { service, connections, api } = setup();
    const expired = { ...connection, state: "expired", expiresAt: "2000-01-01T00:00:00.000Z" };
    connections.create.mockResolvedValue(expired); connections.beginValidation.mockResolvedValue(expired);
    expect(await service.create({ id: 10 }, connection)).toMatchObject({ state: "expired", errorCode: "expired" });
    const replay = await service.acceptShared(10, 7, -1001);
    expect(replay).toMatchObject({ state: "expired", errorCode: "expired" });
    expect(replay?.fallbackUrl).toBeUndefined(); expect(replay?.preparedButtonId).toBeUndefined();
    expect(api.savePreparedKeyboardButton).not.toHaveBeenCalled();
    expect(api.getMe).not.toHaveBeenCalled(); expect(api.getChat).not.toHaveBeenCalled();
  });
  it("does not repeat Telegram validation or membership creation after completion", async () => {
    const { service, connections, api, connected } = setup();
    connections.beginValidation.mockResolvedValue(connected);
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "connected", workspaceId: connected.workspaceId });
    expect(api.getChat).not.toHaveBeenCalled(); expect(api.getChatMember).not.toHaveBeenCalled();
    expect(connections.complete).not.toHaveBeenCalled();
  });
  it.each([
    { actor: { status: "creator", user: { id: 11, is_bot: false } }, bot: null, code: "actor_not_admin" },
    { actor: { status: "administrator", can_manage_chat: false, user: { id: 10, is_bot: false } }, bot: null, code: "actor_not_admin" },
    { actor: { status: "creator", user: { id: 10, is_bot: true } }, bot: null, code: "actor_not_admin" },
    { actor: null, bot: { status: "administrator", can_manage_chat: true, user: { id: 98, is_bot: true } }, code: "bot_not_admin" },
    { actor: null, bot: { status: "administrator", can_manage_chat: false, user: { id: 99, is_bot: true } }, code: "bot_not_admin" },
  ])("does not trust a mismatched identity or insufficient actual rights: $code", async ({ actor, bot, code }) => {
    const { service, connections, api } = setup();
    api.getChatMember.mockImplementation(async (_chat, id) => (id === 10 ? actor : bot) ??
      { status: "administrator", can_manage_chat: true, user: { id, is_bot: id === 99 } } as never);
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "rejected", errorCode: code });
    expect(connections.complete).not.toHaveBeenCalled();
  });
  it("accepts a Telegram creator whose rights object omits administrator flags", async () => {
    const { service, api } = setup();
    api.getChatMember.mockImplementation(async (_chat, id) => id === 10
      ? { status: "creator", user: { id, is_bot: false } } as never
      : { status: "administrator", can_manage_chat: true, user: { id, is_bot: true } });
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "connected" });
  });
  it("retries bot identity lookup after a transport failure instead of caching rejection", async () => {
    const { service, api } = setup();
    api.getMe.mockRejectedValueOnce(new Error("transport unavailable"));
    expect(await service.acceptShared(10, 7, -1001)).toMatchObject({ state: "rejected", errorCode: "telegram_unavailable" });
    expect(await service.retry(10, connection.connectionId)).toMatchObject({ state: "connected" });
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });
  it("hides the successful workspace result after local workspace closure", async () => {
    const { service, connections, dependencies, connected } = setup();
    connections.get.mockResolvedValue(connected); dependencies.workspaces.getById.mockResolvedValue({ status: "archived" });
    const result = await service.get(10, connection.connectionId);
    expect(result).toMatchObject({ state: "rejected", errorCode: "membership_changed" });
    expect(result.workspaceId).toBeUndefined();
  });
});
