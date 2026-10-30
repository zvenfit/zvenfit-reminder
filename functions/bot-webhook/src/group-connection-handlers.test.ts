import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { GroupConnectionError, TopicRegistrationForbiddenError, WorkspacesRepository, WorkspaceMembersRepository } from "@zvenfit-reminder/shared";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
const mocks = vi.hoisted(() => ({
  group: { create: vi.fn(), get: vi.fn(), retry: vi.fn(), forStart: vi.fn(), acceptShared: vi.fn() },
  topic: { confirm: vi.fn(), start: vi.fn(), get: vi.fn() }, observe: vi.fn(), ensureMenu: vi.fn(), restoreMenu: vi.fn(),
}));
vi.mock("./group-connections.js", async original => ({ ...await original<typeof import("./group-connections.js")>(),
  createGroupConnectionService: () => mocks.group }));
vi.mock("./topic-connections.js", () => ({ createTopicConnectionService: () => mocks.topic }));
vi.mock("./telegram-observation.js", () => ({ observeTelegramIdentity: mocks.observe }));
vi.mock("./bot-menu.js", () => ({ ensureBotMenu: mocks.ensureMenu, restorePrivateBotMenu: mocks.restoreMenu }));
import { getBot, handler, initializeBotRuntime } from "./index.js";
const id = "11111111-1111-4111-8111-111111111111";
const telegram = vi.fn();
let bot: Bot;
function config() {
  vi.stubEnv("YDB_ENDPOINT", "grpc://unused"); vi.stubEnv("YDB_DATABASE", "/unused");
  vi.stubEnv("BOT_TOKEN", "123456:unit-test-only"); vi.stubEnv("WEBHOOK_SECRET", "unit-test-only");
  vi.stubEnv("MINI_APP_URL", "https://example.com/app");
  vi.stubEnv("BOT_INFO_JSON", JSON.stringify({ id: 123456, is_bot: true, first_name: "Reminder", username: "reminder_bot" }));
}
function privateMessage(extra: Record<string, unknown>): Update {
  return { update_id: 1, message: { message_id: 2, date: 100, from: { id: 10, is_bot: false, first_name: "Иван" },
    chat: { id: 10, type: "private", first_name: "Иван" }, ...extra } } as Update;
}
beforeAll(() => {
  config(); bot = getBot();
  bot.api.config.use(async (_prev, method, payload) => {
    telegram(method, payload);
    return { ok: true, result: { message_id: 50, date: 100, chat: { id: 10, type: "private", first_name: "Иван" } } } as never;
  });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks(); config();
  mocks.observe.mockResolvedValue(undefined); mocks.ensureMenu.mockResolvedValue(undefined); mocks.restoreMenu.mockResolvedValue(true);
  mocks.topic.confirm.mockResolvedValue(false);
  vi.spyOn(WorkspacesRepository.prototype, "getByTelegramChatId").mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("group and topic onboarding entrypoints", () => {
  it("serves the fallback selector from a private deep-link without requiring a workspace", async () => {
    mocks.group.forStart.mockResolvedValue({ state: "pending", requestId: 7 });
    await bot.handleUpdate(privateMessage({ text: "/start connect_token", entities: [{ type: "bot_command", offset: 0, length: 6 }] }));
    expect(mocks.group.forStart).toHaveBeenCalledWith(10, "connect_token");
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ reply_markup: {
      keyboard: [[expect.objectContaining({ request_chat: expect.objectContaining({ request_id: 7, chat_is_channel: false }) })]],
      resize_keyboard: true, one_time_keyboard: true,
    } }));
    expect(telegram.mock.calls.some(([, payload]) => payload.reply_markup?.remove_keyboard)).toBe(false);
    expect(mocks.restoreMenu).toHaveBeenCalledWith(bot, "https://example.com/app", 10);
  });
  it("accepts actor-bound private chat_shared and clears its old keyboard", async () => {
    mocks.group.acceptShared.mockResolvedValue({ connectionId: id, state: "connected", workspaceId: id });
    await bot.handleUpdate(privateMessage({ chat_shared: { request_id: 7, chat_id: -1001, title: "Untrusted title" } }));
    expect(mocks.group.acceptShared).toHaveBeenCalledWith(10, 7, -1001);
    expect(mocks.restoreMenu).toHaveBeenCalledWith(bot, "https://example.com/app", 10);
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ reply_markup: { remove_keyboard: true } }));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ reply_markup: expect.objectContaining({
      inline_keyboard: [[expect.objectContaining({ web_app: { url: `https://example.com/app?workspace=${id}` } })]],
    }) }));
  });
  it("rejects an unknown request without creating a workspace", async () => {
    mocks.group.acceptShared.mockResolvedValue(null);
    await bot.handleUpdate(privateMessage({ chat_shared: { request_id: 999, chat_id: -1001 } }));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringContaining("больше не действует") }));
  });
  it("does not observe or reactivate a member before validating a topic callback", async () => {
    const callback: Update = { update_id: 3, callback_query: { id: "cb", chat_instance: "test",
      from: { id: 10, is_bot: false, first_name: "Иван" }, data: `topic_connect:${"a".repeat(32)}`,
      message: { message_id: 4, date: 100, chat: { id: -1001, type: "supergroup", title: "Дом", is_forum: true },
        message_thread_id: 42, is_topic_message: true, text: "Проверка темы" } } };
    await bot.handleUpdate(callback);
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.topic.confirm).toHaveBeenCalledWith({ connectionId: "a".repeat(32), actorUserId: 10,
      chatId: -1001, messageThreadId: 42, isTopicMessage: true });
    expect(telegram).toHaveBeenCalledWith("answerCallbackQuery", expect.objectContaining({ show_alert: true }));
  });
  it("keeps API authentication mandatory and dispatches group setup before the workspace gate", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = { path: "/api/group-connections", httpMethod: "POST", body: JSON.stringify({ clientRequestId: id, launchMode: "native" }) };
    expect((await handler(event)).statusCode).toBe(401); expect(mocks.group.create).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "1"); vi.stubEnv("DEV_USER_ID", "10");
    mocks.group.create.mockResolvedValue({ connectionId: id, state: "pending" });
    expect((await handler(event)).statusCode).toBe(200);
    expect(mocks.group.create).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), { clientRequestId: id, launchMode: "native" });
  });
  it("configures the default menu on runtime initialization and keeps private restoration independent", async () => {
    await initializeBotRuntime(bot); expect(mocks.ensureMenu).toHaveBeenCalledWith(bot, "https://example.com/app");
    mocks.ensureMenu.mockRejectedValueOnce(new Error("commands unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bot.handleUpdate(privateMessage({ text: "/menu", entities: [{ type: "bot_command", offset: 0, length: 5 }] }));
    expect(mocks.restoreMenu).toHaveBeenCalledWith(bot, "https://example.com/app", 10);
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringContaining("рядом с полем ввода") }));
  });
});


function signedSyntheticInitData(actorUserId: number, authDate = Math.floor(Date.now() / 1000)): string {
  const data = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: actorUserId, first_name: "Test" }) });
  const content = [...data].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update("123456:unit-test-only").digest();
  data.set("hash", createHmac("sha256", key).update(content).digest("hex"));
  return data.toString();
}
function topicCallback(message: Record<string, unknown> = {}): Update {
  return { update_id: 10, callback_query: { id: "confirmation", chat_instance: "test",
    from: { id: 10, is_bot: false, first_name: "Test" }, data: `topic_connect:${"a".repeat(32)}`,
    message: { message_id: 11, date: 100, chat: { id: -1001, type: "supergroup", title: "Test", is_forum: true },
      message_thread_id: 42, is_topic_message: true, text: "Probe", ...message } } } as Update;
}

describe("authenticated HTTP and Telegram onboarding boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "");
  });
  it("binds group create, read and retry to the signed actor even with a foreign workspace header", async () => {
    const headers = { "X-Telegram-Init-Data": signedSyntheticInitData(20), "X-Workspace-Id": "foreign" };
    mocks.group.create.mockResolvedValue({ connectionId: id, state: "pending" });
    mocks.group.get.mockResolvedValue({ connectionId: id, state: "pending" });
    mocks.group.retry.mockResolvedValue({ connectionId: id, state: "validating" });
    expect((await handler({ path: "/api/group-connections", httpMethod: "POST", headers,
      body: JSON.stringify({ clientRequestId: id, launchMode: "native" }) })).statusCode).toBe(200);
    expect((await handler({ path: `/api/group-connections/${id}`, httpMethod: "GET", headers })).statusCode).toBe(200);
    expect((await handler({ path: `/api/group-connections/${id}/retry`, httpMethod: "POST", headers, body: "{}" })).statusCode).toBe(200);
    expect(mocks.group.create).toHaveBeenCalledWith(expect.objectContaining({ id: 20 }), { clientRequestId: id, launchMode: "native" });
    expect(mocks.group.get).toHaveBeenCalledExactlyOnceWith(20, id);
    expect(mocks.group.retry).toHaveBeenCalledExactlyOnceWith(20, id);
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
  });
  it("rejects a changed signed user and an expired session before dispatch", async () => {
    const tampered = new URLSearchParams(signedSyntheticInitData(10));
    tampered.set("user", JSON.stringify({ id: 20, first_name: "Test" }));
    for (const synthetic of [tampered.toString(), signedSyntheticInitData(10, 1)]) {
      const result = await handler({ path: "/api/group-connections", httpMethod: "POST",
        headers: { "X-Telegram-Init-Data": synthetic }, body: JSON.stringify({ clientRequestId: id, launchMode: "native" }) });
      expect(result.statusCode).toBe(401);
    }
    expect(mocks.group.create).not.toHaveBeenCalled(); expect(telegram).not.toHaveBeenCalled();
  });
  it("keeps the topic HTTP route behind active workspace membership and organizer rights", async () => {
    const getById = vi.spyOn(WorkspacesRepository.prototype, "getById").mockResolvedValue({ workspaceId: id, telegramChatId: -1001, status: "active" } as never);
    const getMember = vi.spyOn(WorkspaceMembersRepository.prototype, "getByUserId").mockResolvedValue({ userId: 20, role: "owner", status: "removed" } as never);
    const event = { path: "/api/topic-connections", httpMethod: "POST", headers: { "X-Telegram-Init-Data": signedSyntheticInitData(20), "X-Workspace-Id": id },
      body: JSON.stringify({ clientRequestId: id, link: "https://t.me/c/1/42", name: "Test" }) };
    expect((await handler(event)).statusCode).toBe(403);
    getMember.mockResolvedValue({ userId: 20, role: "member", status: "active" } as never);
    expect((await handler(event)).statusCode).toBe(403);
    getById.mockResolvedValue({ workspaceId: id, telegramChatId: -1001, status: "archived" } as never);
    expect((await handler(event)).statusCode).toBe(404);
    expect(mocks.topic.start).not.toHaveBeenCalled(); expect(telegram).not.toHaveBeenCalled();
  });
  it("does not display a live chooser for an expired fallback operation", async () => {
    mocks.group.forStart.mockResolvedValue({ state: "expired", requestId: 7 });
    await bot.handleUpdate(privateMessage({ text: "/start connect_expired", entities: [{ type: "bot_command", offset: 0, length: 6 }] }));
    expect(telegram.mock.calls.some(([, payload]) => payload.reply_markup?.keyboard)).toBe(false);
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringContaining("срок истёк") }));
  });
  it("a foreign fallback token cannot issue a selection keyboard", async () => {
    mocks.group.forStart.mockRejectedValueOnce(new GroupConnectionError("not_found"));
    await bot.handleUpdate(privateMessage({ text: "/start connect_foreign", entities: [{ type: "bot_command", offset: 0, length: 6 }] }));
    expect(telegram.mock.calls.some(([, payload]) => payload.reply_markup?.keyboard)).toBe(false);
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringContaining("недействительна для вашего аккаунта") }));
  });
  it("refuses a chat_shared selection outside a private chat", async () => {
    await bot.handleUpdate(privateMessage({ chat: { id: -1001, type: "supergroup", title: "Test" },
      chat_shared: { request_id: 7, chat_id: -1002 } }));
    expect(mocks.group.acceptShared).not.toHaveBeenCalled(); expect(telegram).not.toHaveBeenCalled();
  });
  it("does not reactivate an actor when confirmation loses authorization in an active group", async () => {
    vi.mocked(WorkspacesRepository.prototype.getByTelegramChatId).mockResolvedValue({ workspaceId: id, status: "active" } as never);
    mocks.topic.confirm.mockRejectedValueOnce(new TopicRegistrationForbiddenError());
    const response = await handler({ path: "/webhook", httpMethod: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "unit-test-only" }, body: JSON.stringify(topicCallback()) });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({ method: "answerCallbackQuery", callback_query_id: "confirmation", show_alert: true });
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(telegram.mock.calls.some(([, payload]) => String(payload.text).includes("Тема подключена"))).toBe(false);
  });
  it("does not accept callbacks from non-topic messages", async () => {
    await bot.handleUpdate(topicCallback({ is_topic_message: false, message_thread_id: undefined }));
    expect(mocks.topic.confirm).toHaveBeenCalledWith(expect.objectContaining({ isTopicMessage: false }));
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(telegram).toHaveBeenCalledWith("answerCallbackQuery", expect.objectContaining({ show_alert: true }));
  });
  it("does not pass inaccessible-message placeholders to confirmation", async () => {
    const inaccessible = JSON.parse(JSON.stringify(topicCallback({ date: 0, is_topic_message: undefined, message_thread_id: undefined, text: undefined }))) as Update;
    await bot.handleUpdate(inaccessible);
    expect(mocks.topic.confirm).not.toHaveBeenCalled(); expect(mocks.observe).not.toHaveBeenCalled();
    expect(telegram).toHaveBeenCalledWith("answerCallbackQuery", expect.objectContaining({ show_alert: true }));
  });
  it("a menu configuration failure does not suppress chat_shared processing", async () => {
    mocks.restoreMenu.mockRejectedValueOnce(new Error("menu unavailable"));
    mocks.group.acceptShared.mockResolvedValue({ state: "connected", workspaceId: id });
    await bot.handleUpdate(privateMessage({ chat_shared: { request_id: 7, chat_id: -1001 } }));
    expect(mocks.group.acceptShared).toHaveBeenCalledWith(10, 7, -1001);
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: "Группа подключена. Вернитесь в панель." }));
  });
  it("does not promise a working private menu when Telegram rejects its override", async () => {
    mocks.restoreMenu.mockRejectedValueOnce(new Error("menu unavailable"));
    await bot.handleUpdate(privateMessage({ text: "/menu", entities: [{ type: "bot_command", offset: 0, length: 5 }] }));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringContaining("Постоянное меню временно недоступно") }));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }) }));
  });
});
