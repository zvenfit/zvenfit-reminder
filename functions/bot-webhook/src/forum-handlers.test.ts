import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TopicsRepository, TopicRegistrationForbiddenError, WorkspacesRepository, WorkspaceMembersRepository } from "@zvenfit-reminder/shared";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";

vi.mock("./telegram-observation.js", () => ({ observeTelegramIdentity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./bot-menu.js", () => ({ ensureBotMenu: vi.fn().mockResolvedValue(undefined), restorePrivateBotMenu: vi.fn().mockResolvedValue(true) }));
import { getBot } from "./index.js";

let bot: Bot;
const telegram = vi.fn();
const workspace = { workspaceId: "11111111-1111-4111-8111-111111111111", telegramChatId: -100123, status: "active" };

function update(text: string, chatType = "supergroup"): Update {
  return {
    update_id: 100,
    message: {
      message_id: 101, date: 100,
      from: { id: 20, first_name: "Иван", is_bot: false },
      chat: chatType === "private" ? { id: 20, type: "private", first_name: "Иван" }
        : { id: -100123, type: "supergroup", title: "Команда", is_forum: true },
      ...(chatType === "private" ? {} : { message_thread_id: 42, is_topic_message: true }),
      text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
  } as Update;
}

beforeAll(() => {
  vi.stubEnv("YDB_ENDPOINT", "grpc://unused");
  vi.stubEnv("YDB_DATABASE", "/unused");
  vi.stubEnv("BOT_TOKEN", "123456:test");
  vi.stubEnv("WEBHOOK_SECRET", "test");
  vi.stubEnv("MINI_APP_URL", "https://example.com/app");
  vi.stubEnv("BOT_INFO_JSON", JSON.stringify({ id: 123456, is_bot: true, first_name: "Reminder", username: "reminder_bot", has_main_web_app: true }));
  bot = getBot();
  bot.api.config.use(async (_previous, method, payload) => {
    telegram(method, payload);
    return { ok: true, result: { message_id: 500, date: 100, chat: { id: -100123, type: "supergroup", title: "Команда" } } } as never;
  });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  telegram.mockClear();
  vi.spyOn(WorkspacesRepository.prototype, "getByTelegramChatId").mockResolvedValue(workspace as never);
  vi.spyOn(WorkspaceMembersRepository.prototype, "getByUserId").mockResolvedValue({ userId: 20, status: "active", role: "organizer" } as never);
  vi.spyOn(WorkspacesRepository.prototype, "updateTelegramMetadata").mockResolvedValue(undefined);
  vi.spyOn(TopicsRepository.prototype, "observe").mockResolvedValue(undefined);
  vi.spyOn(TopicsRepository.prototype, "observeForManager").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("forum and panel commands", () => {
  it("registers a topic from the actual chat and answers inside that topic", async () => {
    await bot.handleUpdate(update("/topic@reminder_bot Оплаты"));
    expect(TopicsRepository.prototype.observeForManager).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, 20, -100123,
      expect.objectContaining({ messageThreadId: 42, name: "Оплаты", messageDate: 100 }));
    expect(TopicsRepository.prototype.observe).not.toHaveBeenCalled();
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ chat_id: -100123, message_thread_id: 42 }));
  });
  it("prevents ordinary members and removed organizers from registering names", async () => {
    for (const actor of [{ role: "member", status: "active" }, { role: "organizer", status: "removed" }]) {
      vi.mocked(WorkspaceMembersRepository.prototype.getByUserId).mockResolvedValue(actor as never);
      await bot.handleUpdate(update("/topic Подмена"));
    }
    expect(TopicsRepository.prototype.observe).not.toHaveBeenCalled();
    expect(TopicsRepository.prototype.observeForManager).not.toHaveBeenCalled();
  });
  it("denies registration when manager access is revoked after the command precheck", async () => {
    vi.mocked(TopicsRepository.prototype.observeForManager).mockRejectedValueOnce(new TopicRegistrationForbiddenError());
    await bot.handleUpdate(update("/topic Подмена"));
    expect(TopicsRepository.prototype.observeForManager).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, 20, -100123,
      expect.objectContaining({ messageThreadId: 42, name: "Подмена" }));
    expect(TopicsRepository.prototype.observe).not.toHaveBeenCalled();
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: -100123, message_thread_id: 42,
      text: "Подключать темы может только владелец или организатор активной группы.",
    }));
    expect(telegram.mock.calls.some(([method, payload]) => method === "sendMessage" && payload.text.startsWith("Тема подключена"))).toBe(false);
  });
  it("does not accept a topic registration from an unregistered group", async () => {
    vi.mocked(WorkspacesRepository.prototype.getByTelegramChatId).mockResolvedValue(null);
    await bot.handleUpdate(update("/topic Оплаты"));
    expect(TopicsRepository.prototype.observe).not.toHaveBeenCalled();
    expect(TopicsRepository.prototype.observeForManager).not.toHaveBeenCalled();
  });
  it.each(["/menu", "/app"])("accepts %s in a private chat and returns a Web App button", async (command) => {
    await bot.handleUpdate(update(command, "private"));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: 20,
      reply_markup: expect.objectContaining({ inline_keyboard: [[{ text: "Открыть панель", web_app: { url: "https://example.com/app" } }]] }),
    }));
    expect(TopicsRepository.prototype.observe).not.toHaveBeenCalled();
  });
  it("opens the source workspace directly from a forum menu", async () => {
    await bot.handleUpdate(update("/menu"));
    expect(telegram).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      message_thread_id: 42,
      reply_markup: expect.objectContaining({ inline_keyboard: [[{ text: "Открыть панель", url: `https://t.me/reminder_bot?startapp=ws_${workspace.workspaceId}` }]] }),
    }));
  });
});
