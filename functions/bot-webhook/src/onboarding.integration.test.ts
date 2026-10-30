import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getDriver, groupConnectionId, topicConnectionId, TypedValues, Types, withSession,
  WorkspacesRepository, WorkspaceMembersRepository,
} from "@zvenfit-reminder/shared";
import type { Update } from "grammy/types";
import type { ApiGatewayResponse } from "./api.js";

const deniedNetwork = vi.hoisted(() => ({ fetch: vi.fn(async () => { throw new Error("Unexpected external HTTP request in local integration test"); }) }));
// The only mocked production boundary is Telegram transport. A forgotten
// transformer method or any secondary Bot cannot fall through to the network.
vi.mock("./telegram-network.js", () => ({
  telegramClientOptions: () => ({ fetch: deniedNetwork.fetch }),
}));
import { AUTHENTICATED_WEBHOOK_HEADER, getBot, handler } from "./index.js";

const enabled = process.env.RUN_BOT_YDB_INTEGRATION === "1";
const endpoint = process.env.YDB_ENDPOINT ?? "grpc://localhost:2136";
const database = process.env.YDB_DATABASE ?? "/local";
if (enabled) {
  const target = new URL(endpoint);
  if (!["grpc:", "grpcs:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username || target.password || target.search || target.hash ||
    (target.pathname !== "" && target.pathname !== "/") || database !== "/local") {
    throw new Error("Bot integration requires a loopback YDB endpoint and the isolated /local database");
  }
}
const botInfo = { id: 123456, is_bot: true as const, first_name: "Integration Bot", username: "integration_bot", has_main_web_app: true };
const syntheticToken = "123456:integration-fixture-only";
const syntheticWebhookSecret = "integration-fixture-only";
const actorId = randomInt(8_200_000_000_000, 8_300_000_000_000);
const chatId = -randomInt(1_700_000_000_000, 1_800_000_000_000);
const user = { id: actorId, is_bot: false as const, first_name: "Integration User" };
const chat = { id: chatId, type: "supergroup" as const, title: `Integration ${randomUUID()}`, is_forum: true as const };
const clientRequestId = randomUUID();
const topicRequestId = randomUUID();
const connectionId = groupConnectionId(actorId, clientRequestId);
const workspaceIds = new Set<string>();
const topicIds = new Set<string>();
const telegramCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
const unexpectedTelegramMethods: string[] = [];
let selectionRequestId: number | undefined;
let messageId = 100;

function signedSyntheticInitData(): string {
  const data = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const content = [...data].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(syntheticToken).digest();
  data.set("hash", createHmac("sha256", key).update(content).digest("hex"));
  return data.toString();
}
async function api(path: string, method = "GET", body?: unknown, workspaceId?: string) {
  return handler({ path, httpMethod: method, headers: {
    "X-Telegram-Init-Data": signedSyntheticInitData(), ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
  }, ...(body == null ? {} : { body: JSON.stringify(body) }) });
}
function parsed(response: ApiGatewayResponse): Record<string, any> {
  return JSON.parse(response.body ?? "{}");
}
async function webhook(update: Update) {
  return handler({ path: "/webhook", httpMethod: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": syntheticWebhookSecret }, body: JSON.stringify(update) });
}
function sharedUpdate(): Update {
  return { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), from: user,
    chat: { id: actorId, type: "private", first_name: user.first_name },
    chat_shared: { request_id: selectionRequestId!, chat_id: chatId, title: "Untrusted selected title" } } };
}

describe.runIf(enabled)("real handler and isolated YDB onboarding", () => {
  beforeAll(() => {
    vi.stubEnv("YDB_ENDPOINT", endpoint); vi.stubEnv("YDB_DATABASE", database);
    vi.stubEnv("YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS", "");
    vi.stubEnv("YDB_ANONYMOUS_CREDENTIALS", "1");
    vi.stubEnv("BOT_TOKEN", syntheticToken); vi.stubEnv("WEBHOOK_SECRET", syntheticWebhookSecret);
    vi.stubEnv("BOT_INFO_JSON", JSON.stringify(botInfo));
    vi.stubEnv("MINI_APP_URL", "https://integration.invalid/app"); vi.stubEnv("DEFAULT_TIMEZONE", "UTC");
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "");
    vi.stubEnv("TELEGRAM_API_ROOT", ""); vi.stubEnv("TELEGRAM_PROXY_SECRET", "");
    vi.stubGlobal("fetch", deniedNetwork.fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bot = getBot();
    bot.api.config.use(async (_previous, method, rawPayload) => {
      const payload = rawPayload as Record<string, unknown>;
      telegramCalls.push({ method, payload });
      let result: unknown;
      switch (method) {
        case "getMe": result = botInfo; break;
        case "savePreparedKeyboardButton": {
          expect(payload.user_id).toBe(actorId);
          const button = payload.button as { request_chat: { request_id: number; chat_is_channel: boolean } };
          expect(button.request_chat.chat_is_channel).toBe(false);
          selectionRequestId = button.request_chat.request_id;
          result = { id: "integration-prepared-button" };
          break;
        }
        case "getChat":
          expect(payload.chat_id).toBe(chatId); result = chat; break;
        case "getChatMember": {
          expect(payload.chat_id).toBe(chatId);
          expect([actorId, botInfo.id]).toContain(payload.user_id);
          result = { status: "administrator", can_manage_chat: true,
            user: payload.user_id === actorId ? user : botInfo };
          break;
        }
        case "setChatMenuButton": case "setMyCommands": case "answerCallbackQuery": result = true; break;
        case "sendMessage": {
          expect([actorId, chatId]).toContain(payload.chat_id);
          const inTopic = payload.chat_id === chatId;
          if (inTopic) expect(payload.message_thread_id).toBe(42);
          result = { message_id: ++messageId, date: Math.floor(Date.now() / 1000), from: botInfo,
            chat: inTopic ? chat : { id: actorId, type: "private", first_name: user.first_name },
            ...(inTopic ? { message_thread_id: 42, is_topic_message: true } : {}), text: payload.text };
          break;
        }
        default:
          unexpectedTelegramMethods.push(method);
          throw new Error(`Unexpected Telegram method in integration test: ${method}`);
      }
      return { ok: true, result } as never;
    });
  });

  afterAll(async () => {
    try {
      // Recover the owned workspace even if a response was lost after commit.
      const owned = await new WorkspacesRepository(endpoint, database).getByTelegramChatId(chatId);
      if (owned) {
        workspaceIds.add(owned.workspaceId);
        topicIds.add(topicConnectionId(owned.workspaceId, actorId, topicRequestId));
      }
      await withSession(endpoint, database, (session) => session.executeQuery(`
        DECLARE $workspace_ids AS List<Utf8>; DECLARE $topic_ids AS List<Utf8>;
        DECLARE $actor_id AS Int64; DECLARE $chat_id AS Int64; DECLARE $connection_id AS Utf8;
        DELETE FROM topic_connection_requests WHERE connection_id IN $topic_ids;
        DELETE FROM group_connection_requests WHERE actor_user_id = $actor_id;
        DELETE FROM group_connection_counters WHERE actor_user_id = $actor_id;
        DELETE FROM group_connections WHERE connection_id = $connection_id;
        DELETE FROM audit_events WHERE workspace_id IN $workspace_ids;
        DELETE FROM calendar_feed_tokens WHERE workspace_id IN $workspace_ids;
        DELETE FROM notification_deliveries WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_occurrence_slots WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_occurrences WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_runtime WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminder_watchers WHERE workspace_id IN $workspace_ids;
        DELETE FROM reminders WHERE workspace_id IN $workspace_ids;
        DELETE FROM workspace_topics WHERE workspace_id IN $workspace_ids;
        DELETE FROM workspace_members WHERE workspace_id IN $workspace_ids;
        DELETE FROM telegram_chat_workspaces WHERE telegram_chat_id = $chat_id;
        DELETE FROM workspaces WHERE workspace_id IN $workspace_ids;
        DELETE FROM users WHERE user_id = $actor_id;
      `, { $workspace_ids: TypedValues.list(Types.UTF8, [...workspaceIds]), $topic_ids: TypedValues.list(Types.UTF8, [...topicIds]),
        $actor_id: TypedValues.int64(actorId), $chat_id: TypedValues.int64(chatId), $connection_id: TypedValues.utf8(connectionId) }));
      expect(await new WorkspacesRepository(endpoint, database).listForUser(actorId)).toEqual([]);
      expect(deniedNetwork.fetch).not.toHaveBeenCalled();
      expect(unexpectedTelegramMethods).toEqual([]);
    } finally {
      await (await getDriver(endpoint, database)).destroy();
      vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    }
  }, 30_000);

  it("connects a selected group, verifies its topic, and saves a reminder through real API and webhook entrypoints", async () => {
    const prepared = await api("/api/group-connections", "POST", { clientRequestId, launchMode: "native" });
    expect(prepared.statusCode).toBe(200);
    expect(parsed(prepared)).toMatchObject({ connectionId, state: "pending", preparedButtonId: "integration-prepared-button" });
    expect(selectionRequestId).toBeGreaterThan(0);
    expect(parsed(await api("/api/group-connections", "POST", { clientRequestId, launchMode: "native" }))).toMatchObject({ connectionId, state: "pending" });
    expect(telegramCalls.filter(({ method }) => method === "savePreparedKeyboardButton")).toHaveLength(1);

    const selected = await webhook(sharedUpdate());
    expect(selected.statusCode).toBe(200); expect(selected.body).toBe("");
    expect(selected.headers?.[AUTHENTICATED_WEBHOOK_HEADER]).toBe("1");
    const connection = parsed(await api(`/api/group-connections/${connectionId}`));
    expect(connection.state).toBe("connected");
    const workspaceId = String(connection.workspaceId); workspaceIds.add(workspaceId);
    const memberships = parsed(await api("/api/workspaces")).workspaces;
    expect(memberships).toEqual([expect.objectContaining({ workspaceId, ownerUserId: actorId,
      telegramChatId: chatId, displayName: chat.title, role: "owner", isForum: true })]);
    const membersBeforeReplay = telegramCalls.filter(({ method }) => method === "getChatMember").length;
    expect(telegramCalls.filter(({ method }) => method === "getChatMember").map(({ payload }) => payload.user_id).sort())
      .toEqual([actorId, botInfo.id].sort());
    expect((await webhook(sharedUpdate())).body).toBe("");
    expect(telegramCalls.filter(({ method }) => method === "getChatMember")).toHaveLength(membersBeforeReplay);
    expect(parsed(await api("/api/workspaces")).workspaces).toHaveLength(1);
    expect(await new WorkspaceMembersRepository(endpoint, database).getByUserId(workspaceId, actorId)).toMatchObject({ role: "owner", status: "active" });

    const topicBody = { clientRequestId: topicRequestId, link: `https://t.me/c/${-chatId - 1_000_000_000_000}/42`, name: "Оплаты" };
    topicIds.add(topicConnectionId(workspaceId, actorId, topicRequestId));
    const verified = await api("/api/topic-connections", "POST", topicBody, workspaceId);
    expect(verified.statusCode).toBe(200);
    expect(parsed(verified)).toMatchObject({ state: "succeeded", messageThreadId: 42, name: "Оплаты" });
    expect(parsed(verified)).not.toHaveProperty("errorCode");
    expect(parsed(verified)).not.toHaveProperty("message");
    expect(parsed(await api("/api/topics", "GET", undefined, workspaceId))).toEqual({ topics: [
      { messageThreadId: 42, name: "Оплаты", isClosed: false, unavailableReason: null },
    ] });
    const probes = () => telegramCalls.filter(({ method, payload }) => method === "sendMessage" && payload.chat_id === chatId);
    expect(probes()).toHaveLength(1); expect(probes()[0].payload).toMatchObject({ message_thread_id: 42, disable_notification: true });
    const replayedTopic = await api("/api/topic-connections", "POST", topicBody, workspaceId);
    expect(replayedTopic.statusCode).toBe(200);
    expect(parsed(replayedTopic)).toMatchObject({ state: "succeeded" });
    expect(parsed(replayedTopic)).not.toHaveProperty("errorCode");
    expect(parsed(replayedTopic)).not.toHaveProperty("message");
    expect(probes()).toHaveLength(1);

    const created = await api("/api/reminders", "POST", { title: "Integration reminder", visibility: "group", messageThreadId: 42,
      assignment: { mode: "person", responsibleUserId: actorId },
      schedule: { version: 1, frequency: "once", date: "2099-01-01", timing: { kind: "timed", timeLocal: "12:00" } },
      timezone: "UTC", notificationPolicy: { ignoreQuietHours: true },
    }, workspaceId);
    expect(created.statusCode).toBe(201);
    const reminder = parsed(created).reminder;
    expect(reminder).toMatchObject({ workspaceId, messageThreadId: 42, assignment: { mode: "person", responsibleUserId: actorId } });
    expect(parsed(await api("/api/reminders", "GET", undefined, workspaceId)).reminders).toEqual([expect.objectContaining({
      reminderId: reminder.reminderId, messageThreadId: 42,
    })]);
    expect(probes()).toHaveLength(1); expect(deniedNetwork.fetch).not.toHaveBeenCalled();
  }, 60_000);
});
