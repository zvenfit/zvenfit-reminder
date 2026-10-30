import { getDefaultResultOrder } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import type {
  AppConfig,
  NotificationDelivery,
  ReminderOccurrence,
  ReservedDelivery,
  ScheduleSpec,
} from "@zvenfit-reminder/shared";
import {
  createTelegramClient,
  runDispatcher,
  telegramClient,
  type DispatcherDependencies,
} from "./dispatcher.js";

it("prefers IPv4 for Telegram calls from Yandex Cloud Functions", () => {
  expect(getDefaultResultOrder()).toBe("ipv4first");
});

const config: AppConfig = {
  ydbEndpoint: "grpc://unused",
  ydbDatabase: "/unused",
  botToken: "test-token",
  webhookSecret: "test-secret",
  defaultTimezone: "Europe/Moscow",
  miniAppUrl: "",
};

const dailySchedule: ScheduleSpec = {
  version: 1,
  frequency: "daily",
  interval: 1,
  startDate: "2026-08-13",
  timing: { kind: "timed", timeLocal: "15:00" },
};

function occurrence(): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    reminderVersion: 1,
    stateRevision: 1,
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    dueLocalDate: "2026-08-25",
    allDay: false,
    reminderStartAt: new Date("2026-08-13T12:00:00.000Z"),
    status: "pending",
    notificationState: "waiting",
    assignment: { mode: "person", responsibleUserId: 20 },
    kind: "task",
    title: "Передать показания",
    description: null,
    actionUrl: null,
    amountMinor: null,
    currency: null,
    visibility: "group",
    messageThreadId: null,
    timezone: "Europe/Moscow",
    leadMinutes: 0,
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 },
    watcherUserIds: [],
    nextNotificationAt: new Date("2026-08-13T12:00:00.000Z"),
    notificationSequence: 0,
    snoozedBy: null,
    snoozedAt: null,
    snoozeUntil: null,
    latestMessageChatId: -100123,
    latestMessageId: 55,
    completedBy: null,
    completedByDisplayName: null,
    completedAt: null,
    undoUntil: null,
    cancelledBy: null,
    cancellationReason: null,
    cancelledAt: null,
    createdAt: new Date("2026-08-13T12:00:00.000Z"),
    updatedAt: new Date("2026-08-13T12:00:00.000Z"),
  };
}

function reservedDelivery(item: ReminderOccurrence): ReservedDelivery {
  return {
    occurrence: item,
    targetChatId: -100123,
    nextNotificationAt: new Date("2026-08-13T18:00:00.000Z"),
    escalationWatchers: [],
    delivery: {
      workspaceId: "workspace-a",
      deliveryKey: "delivery-a",
      occurrenceId: "occurrence-a",
      reminderId: "reminder-a",
      deliveryType: "initial",
      sequence: 0,
      scheduledAt: new Date("2026-08-13T12:00:00.000Z"),
      claimedAt: new Date("2026-08-13T12:00:00.000Z"),
      status: "reserved",
      telegramChatId: -100123,
      messageThreadId: item.messageThreadId,
      telegramMessageId: null,
      errorCode: null,
      createdAt: new Date("2026-08-13T12:00:00.000Z"),
      updatedAt: new Date("2026-08-13T12:00:00.000Z"),
    },
  };
}

function noMessageSync() {
  return {
    listMessageSyncCandidates: vi.fn().mockResolvedValue([]),
    beginMessageSync: vi.fn(),
    finishMessageSync: vi.fn().mockResolvedValue(undefined),
  };
}

function singleSendDependencies(reservation: ReservedDelivery) {
  return {
    topics: { markUnavailable: vi.fn().mockResolvedValue(undefined) },
    workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: reservation.delivery.workspaceId }]) },
    actions: { listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]) },
    occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]) },
    deliveries: {
      listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: reservation.occurrence.occurrenceId }]),
      reserve: vi.fn().mockResolvedValue(reservation),
      beginSend: vi.fn().mockResolvedValue({ valid: true, targetChatId: reservation.targetChatId }),
      recordResult: vi.fn().mockResolvedValue({ ...reservation.delivery, status: "sent", telegramMessageId: 777 }),
    },
    telegram: createTelegramClient(),
  };
}

describe("runDispatcher", () => {
  it.each([
    { deliveryType: "initial" as const, visibility: "group" as const, messageThreadId: 42, chatId: -100123 },
    { deliveryType: "repeat" as const, visibility: "group" as const, messageThreadId: 52, chatId: -100123 },
    { deliveryType: "escalation" as const, visibility: "group" as const, messageThreadId: 42, chatId: -100123 },
    { deliveryType: "initial" as const, visibility: "private" as const, messageThreadId: null, chatId: 20 },
  ])("preserves the snapshot destination and mentions through the dispatcher and HTTP client: %j", async (scenario) => {
    const item = { ...occurrence(), visibility: scenario.visibility, messageThreadId: scenario.messageThreadId,
      latestMessageId: null, latestMessageChatId: null };
    const reservation = reservedDelivery(item);
    reservation.targetChatId = scenario.chatId;
    reservation.delivery.telegramChatId = scenario.chatId;
    reservation.delivery.deliveryType = scenario.deliveryType;
    if (scenario.deliveryType === "escalation") reservation.escalationWatchers = [{ userId: 10, displayName: "Анна <&>" }];
    const dependencies = singleSendDependencies(reservation);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 }));
    try {
      const result = await runDispatcher(config, reservation.delivery.claimedAt, dependencies as unknown as DispatcherDependencies);
      expect(result).toMatchObject({ sent: 1, failed: 0, unknown: 0, errors: [] });
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.chat_id).toBe(scenario.chatId);
      expect(body.parse_mode).toBe("HTML");
      if (scenario.visibility === "group") expect(body.text).toContain('tg://user?id=20');
      else expect(body.text).not.toContain("tg://user");
      if (scenario.messageThreadId === null) expect(body).not.toHaveProperty("message_thread_id");
      else expect(body.message_thread_id).toBe(scenario.messageThreadId);
      if (scenario.deliveryType === "escalation") {
        expect(body.text).toContain('tg://user?id=10');
        expect(body.text).toContain("Анна &lt;&amp;&gt;");
      } else expect(body.text).not.toContain('tg://user?id=10');
    } finally { fetchMock.mockRestore(); }
  });

  it("records an uncertain send without replay or unavailable-topic marking when the response is truncated", async () => {
    const reservation = reservedDelivery({ ...occurrence(), messageThreadId: 42 });
    const dependencies = singleSendDependencies(reservation);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"ok":true,"result":', { status: 200 }));
    try {
      const result = await runDispatcher(config, reservation.delivery.claimedAt, dependencies as unknown as DispatcherDependencies);
      expect(result).toMatchObject({ sent: 0, failed: 0, unknown: 1 });
      expect(dependencies.deliveries.recordResult).toHaveBeenCalledExactlyOnceWith("workspace-a", "delivery-a",
        { status: "unknown", errorCode: "telegram_transport_unknown" }, expect.any(Date));
      expect(dependencies.topics.markUnavailable).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });

  it("still finalizes a rejected send when persisting topic availability fails", async () => {
    const reservation = reservedDelivery({ ...occurrence(), messageThreadId: 42 });
    const dependencies = singleSendDependencies(reservation);
    dependencies.topics.markUnavailable.mockRejectedValue(new Error("YDB temporarily unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Bad Request: TOPIC_CLOSED" }), { status: 400 }));
    try {
      const result = await runDispatcher(config, reservation.delivery.claimedAt, dependencies as unknown as DispatcherDependencies);
      expect(result).toMatchObject({ sent: 0, failed: 1, unknown: 0 });
      expect(result.errors).toContain("topic_availability_persist_failed");
      expect(dependencies.deliveries.recordResult).toHaveBeenCalledExactlyOnceWith("workspace-a", "delivery-a",
        { status: "failed", errorCode: "topic_closed" }, expect.any(Date));
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { fetchMock.mockRestore(); }
  });
  it.each([
    ["Bad Request: TOPIC_CLOSED", "topic_closed"],
    ["Bad Request: message thread not found", "topic_deleted"],
  ])("persists actionable topic failures without falling back to General", async (description, code) => {
    const item = { ...occurrence(), messageThreadId: 42 };
    const reservation = reservedDelivery(item);
    reservation.delivery.messageThreadId = 42;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, description }), { status: 400 }));
    const markUnavailable = vi.fn(), recordResult = vi.fn();
    const dependencies = {
      topics: { markUnavailable },
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: { listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]) },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]) },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({ valid: true, targetChatId: reservation.targetChatId }), recordResult,
      },
      telegram: createTelegramClient(),
    } as unknown as DispatcherDependencies;
    try {
      const result = await runDispatcher(config, reservation.delivery.claimedAt, dependencies);
      expect(result.failed).toBe(1);
      expect(markUnavailable).toHaveBeenCalledExactlyOnceWith("workspace-a", 42, code, reservation.delivery.claimedAt);
      expect(recordResult).toHaveBeenCalledWith("workspace-a", "delivery-a", { status: "failed", errorCode: code }, expect.any(Date));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).message_thread_id).toBe(42);
    } finally { fetchMock.mockRestore(); }
  });
  it("routes cron Telegram calls through the authenticated Worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ result: { message_id: 77 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createTelegramClient({
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
      telegramProxySecret: "proxy-secret",
    });

    await expect(client.send(
      "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123",
      -100123,
      "Напоминание",
      { inline_keyboard: [] },
    )).resolves.toBe(77);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://reminder.example.workers.dev/telegram/sendMessage");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Zvenfit-Telegram-Proxy-Secret")).toBe("proxy-secret");
    expect(headers.get("X-Zvenfit-Telegram-Bot-Token"))
      .toBe("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123");
    vi.unstubAllGlobals();
  });

  it.each([
    "Bad Request: message is not modified",
    "Bad Request: message to edit not found",
  ])("treats terminal Telegram edit response as idempotent success: %s", async (description) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ description }),
    }));

    await expect(telegramClient.editFinal(
      "test-token",
      -100123,
      55,
      "✅ Выполнено",
    )).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("compacts a paused live message and acknowledges the rendered revision", async () => {
    const paused = {
      ...occurrence(),
      notificationState: "stopped" as const,
      latestMessageChatId: -100123,
      latestMessageId: 55,
    };
    const finishMessageSync = vi.fn().mockResolvedValue(undefined);
    const editFinal = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
        markCompletionMessageFinalized: vi.fn(),
      },
      occurrences: {
        listMessageSyncCandidates: vi.fn().mockResolvedValue([{
          occurrence: paused,
          stateRevision: 8,
          retireOnly: false,
        }]),
        beginMessageSync: vi.fn().mockResolvedValue({
          occurrence: paused,
          stateRevision: 8,
          retireOnly: false,
          syncKey: "sync-8",
        }),
        finishMessageSync,
        listRuntimeCandidates: vi.fn().mockResolvedValue([]),
        materialize: vi.fn(),
      },
      deliveries: { listCandidates: vi.fn().mockResolvedValue([]), reserve: vi.fn(), beginSend: vi.fn(), recordResult: vi.fn() },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal, editActive: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(config, new Date("2026-08-13T12:00:00.000Z"), dependencies);

    expect(editFinal).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
      expect.stringContaining("Напоминание приостановлено"),
    );
    expect(finishMessageSync).toHaveBeenCalledWith(
      "workspace-a", "occurrence-a", 8, "sync-8", true,
    );
    expect(stats.messagesSynced).toBe(1);
  });

  it("refreshes an actionable message after its schedule or assignee changes", async () => {
    const updated = {
      ...occurrence(),
      dueAt: new Date("2026-09-25T15:00:00.000Z"),
      snoozedBy: 20,
      snoozedAt: new Date("2026-08-13T12:00:00.000Z"),
      snoozeUntil: new Date("2026-08-13T14:00:00.000Z"),
      latestMessageChatId: -100123,
      latestMessageId: 55,
    };
    const editActive = vi.fn().mockResolvedValue(undefined);
    const getById = vi.fn().mockResolvedValue({ schedule: dailySchedule });
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      reminders: { getById },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
        markCompletionMessageFinalized: vi.fn(),
      },
      occurrences: {
        listMessageSyncCandidates: vi.fn().mockResolvedValue([{
          occurrence: updated,
          stateRevision: 9,
          retireOnly: false,
        }]),
        beginMessageSync: vi.fn().mockResolvedValue({
          occurrence: updated,
          stateRevision: 9,
          retireOnly: false,
          syncKey: "sync-9",
        }),
        finishMessageSync: vi.fn().mockResolvedValue(undefined),
        listRuntimeCandidates: vi.fn().mockResolvedValue([]),
        materialize: vi.fn(),
      },
      deliveries: { listCandidates: vi.fn().mockResolvedValue([]), reserve: vi.fn(), beginSend: vi.fn(), recordResult: vi.fn() },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal: vi.fn(), editActive },
    } as unknown as DispatcherDependencies;

    await runDispatcher(config, new Date("2026-08-13T12:00:00.000Z"), dependencies);

    expect(editActive).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
      expect.stringContaining("25 сентября"),
      expect.anything(),
    );
    expect(editActive.mock.calls[0]?.[3]).toContain("Следующий сигнал:");
    expect(editActive.mock.calls[0]?.[3]).toContain("Срок не изменился:");
    expect(editActive.mock.calls[0]?.[3]).not.toContain("Просрочено:");
    expect(editActive.mock.calls[0]?.[3]).toContain("17:00");
    expect(editActive.mock.calls[0]?.[3]).toContain("Каждый день");
    expect(editActive.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      inline_keyboard: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ text: "✅ Выполнил этот срок" }),
        ]),
      ]),
    }));
    expect(getById).toHaveBeenCalledWith("workspace-a", "reminder-a");
  });

  it("retires an old audience without rendering private content into it", async () => {
    const migrated = {
      ...occurrence(),
      visibility: "private" as const,
      assignment: { mode: "person" as const, responsibleUserId: 20 },
      title: "Секретный заголовок",
      description: "Секретное описание",
      latestMessageChatId: -100123,
      latestMessageId: 55,
    };
    const editFinal = vi.fn().mockResolvedValue(undefined);
    const finishMessageSync = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
        markCompletionMessageFinalized: vi.fn(),
      },
      occurrences: {
        listMessageSyncCandidates: vi.fn().mockResolvedValue([{
          occurrence: migrated,
          stateRevision: 10,
          retireOnly: true,
        }]),
        beginMessageSync: vi.fn().mockResolvedValue({
          occurrence: migrated,
          stateRevision: 10,
          retireOnly: true,
          syncKey: "sync-10",
        }),
        finishMessageSync,
        listRuntimeCandidates: vi.fn().mockResolvedValue([]),
        materialize: vi.fn(),
      },
      deliveries: { listCandidates: vi.fn().mockResolvedValue([]), reserve: vi.fn(), beginSend: vi.fn(), recordResult: vi.fn() },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal, editActive: vi.fn() },
    } as unknown as DispatcherDependencies;

    await runDispatcher(config, new Date("2026-08-13T12:00:00.000Z"), dependencies);

    expect(editFinal).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
      "↪️ Напоминание перенесено. Используйте последнее сообщение.",
    );
    expect(editFinal.mock.calls[0]?.[3]).not.toContain("Секрет");
    expect(finishMessageSync).toHaveBeenCalledWith(
      "workspace-a", "occurrence-a", 10, "sync-10", true,
    );
  });

  it("removes the undo button when completion finalization closes the window", async () => {
    const completed = {
      ...occurrence(),
      dueAt: new Date("2026-08-12T12:00:00.000Z"),
      status: "completed" as const,
      notificationState: "stopped" as const,
      completedBy: 20,
      completedByDisplayName: "Иван Петров",
      completedAt: new Date("2026-08-13T12:00:00.000Z"),
      undoUntil: null,
    };
    const editFinal = vi.fn().mockResolvedValue(undefined);
    const getById = vi.fn().mockResolvedValue({ schedule: dailySchedule });
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      reminders: { getById },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([{
          workspaceId: "workspace-a",
          occurrenceId: "occurrence-a",
          undoUntil: new Date("2026-08-13T12:10:00.000Z"),
        }]),
        finalizeCompletion: vi.fn().mockResolvedValue({
          workspaceId: "workspace-a",
          occurrenceId: "occurrence-a",
          reminderId: "reminder-a",
          archivedReminder: false,
          nextDueAt: new Date("2026-08-14T12:00:00.000Z"),
          nextReminderStartAt: new Date("2026-08-14T12:00:00.000Z"),
          occurrence: completed,
        }),
        markCompletionMessageFinalized: vi.fn().mockResolvedValue(undefined),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: { listCandidates: vi.fn().mockResolvedValue([]), reserve: vi.fn(), beginSend: vi.fn(), recordResult: vi.fn() },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:11:00.000Z"),
      dependencies,
    );

    expect(stats.completionFinalized).toBe(1);
    expect(editFinal).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
      expect.stringContaining("✅ <b>"),
    );
    expect(editFinal.mock.calls[0]?.[3]).toContain("Иван Петров");
    expect(editFinal.mock.calls[0]?.[3]).toContain("Когда:");
    expect(editFinal.mock.calls[0]?.[3]).not.toContain("Просрочено:");
    expect(editFinal.mock.calls[0]?.[3]).not.toContain("🔴");
    expect(editFinal.mock.calls[0]?.[3]).toContain("Каждый день");
    expect(editFinal.mock.calls[0]?.[3]).toContain("Следующий срок:");
    expect(editFinal.mock.calls[0]?.[3]).toContain("14 августа");
    expect(dependencies.actions.markCompletionMessageFinalized).toHaveBeenCalledWith(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:11:00.000Z"),
    );
  });

  it("retries Telegram completion cleanup before closing its database queue", async () => {
    const completed = {
      ...occurrence(),
      status: "completed" as const,
      notificationState: "stopped" as const,
      undoUntil: null,
    };
    const editFinal = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Telegram failure"))
      .mockResolvedValueOnce(undefined);
    const markCompletionMessageFinalized = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([{
          workspaceId: "workspace-a",
          occurrenceId: "occurrence-a",
          undoUntil: new Date("2026-08-13T12:10:00.000Z"),
        }]),
        finalizeCompletion: vi.fn().mockResolvedValue({
          workspaceId: "workspace-a",
          occurrenceId: "occurrence-a",
          reminderId: "reminder-a",
          archivedReminder: false,
          nextDueAt: null,
          nextReminderStartAt: null,
          occurrence: completed,
        }),
        markCompletionMessageFinalized,
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: { listCandidates: vi.fn().mockResolvedValue([]), reserve: vi.fn(), beginSend: vi.fn(), recordResult: vi.fn() },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal },
    } as unknown as DispatcherDependencies;

    const first = await runDispatcher(
      config,
      new Date("2026-08-13T12:11:00.000Z"),
      dependencies,
    );
    expect(first.errors).toContain("completion_message_finalize_failed");
    expect(markCompletionMessageFinalized).not.toHaveBeenCalled();

    const second = await runDispatcher(
      config,
      new Date("2026-08-13T12:12:00.000Z"),
      dependencies,
    );
    expect(second.completionFinalized).toBe(1);
    expect(editFinal).toHaveBeenCalledTimes(2);
    expect(markCompletionMessageFinalized).toHaveBeenCalledOnce();
  });

  it("scopes every scan to each active workspace and runs reserve-before-send", async () => {
    const dueAt = new Date("2026-08-13T12:00:00.000Z");
    const item = {
      ...occurrence(),
      messageThreadId: 42,
      dueAt,
      reminderStartAt: dueAt,
      nextNotificationAt: dueAt,
    };
    const baseReservation = reservedDelivery(item);
    const reservation = {
      ...baseReservation,
      delivery: {
        ...baseReservation.delivery,
        claimedAt: new Date("2026-08-13T12:00:01.000Z"),
      },
    };
    const sentDelivery: NotificationDelivery = {
      ...reservation.delivery,
      status: "sent",
      telegramMessageId: 777,
    };
    const sendTelegram = vi.fn().mockResolvedValue(777);
    const getById = vi.fn().mockResolvedValue({ schedule: dailySchedule });
    const dependencies = {
      workspaces: {
        listActive: vi.fn().mockResolvedValue([{
          workspaceId: "workspace-a",
          status: "active",
        }]),
      },
      reminders: { getById },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: {
        ...noMessageSync(),
        listRuntimeCandidates: vi.fn().mockResolvedValue([
          {
            workspaceId: "workspace-a",
            reminderId: "reminder-a",
            reminderStartAt: new Date("2026-08-13T12:00:00.000Z"),
          },
        ]),
        materialize: vi.fn().mockResolvedValue(item),
      },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([
          {
            workspaceId: "workspace-a",
            occurrenceId: "occurrence-a",
            nextNotificationAt: new Date("2026-08-13T12:00:00.000Z"),
          },
        ]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({
          valid: true,
          targetChatId: reservation.targetChatId,
        }),
        recordResult: vi.fn().mockResolvedValue(sentDelivery),
      },
      telegram: {
        send: sendTelegram,
        delete: vi.fn().mockResolvedValue(undefined),
        editFinal: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as DispatcherDependencies;
    const now = dueAt;

    const stats = await runDispatcher(config, now, dependencies);

    expect(stats).toMatchObject({
      mode: "workspace",
      materialized: 1,
      reserved: 1,
      sent: 1,
      failed: 0,
      unknown: 0,
    });
    expect(
      dependencies.occurrences.listRuntimeCandidates,
    ).toHaveBeenCalledWith("workspace-a", now);
    expect(dependencies.deliveries.listCandidates).toHaveBeenCalledWith(
      "workspace-a",
      now,
    );
    expect(dependencies.deliveries.reserve).toHaveBeenCalledBefore(sendTelegram);
    expect(dependencies.deliveries.beginSend).toHaveBeenCalledBefore(sendTelegram);
    expect(sendTelegram.mock.calls[0]?.[4]).toBe(42);
    expect(sendTelegram.mock.calls[0]?.[2]).toContain("tg://user?id=20");
    expect(sendTelegram.mock.calls[0]?.[2]).toContain("Срок наступил:");
    expect(sendTelegram.mock.calls[0]?.[2]).not.toContain("Просрочено:");
    expect(sendTelegram.mock.calls[0]?.[2]).toContain("Каждый день");
    expect(getById).toHaveBeenCalledWith("workspace-a", "reminder-a");
    expect(sendTelegram.mock.calls[0]?.[3]).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Выполнил этот срок", callback_data: "od:occurrence-a" },
          { text: "⏰ +1 час", callback_data: "os:occurrence-a" },
        ],
        [
          { text: "Вечером", callback_data: "oe:occurrence-a" },
          { text: "Завтра утром", callback_data: "ot:occurrence-a" },
        ],
      ],
    });
    expect(dependencies.deliveries.recordResult).toHaveBeenCalledWith(
      "workspace-a",
      "delivery-a",
      { status: "sent", telegramMessageId: 777 },
      expect.any(Date),
    );
    expect(dependencies.telegram.delete).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
    );
  });

  it("continues with another workspace when one workspace scan fails", async () => {
    const dependencies = {
      workspaces: {
        listActive: vi.fn().mockResolvedValue([
          { workspaceId: "workspace-a", status: "active" },
          { workspaceId: "workspace-b", status: "active" },
        ]),
      },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: {
        ...noMessageSync(),
        listRuntimeCandidates: vi.fn()
          .mockRejectedValueOnce(new Error("code = 400080; SELECT private_value"))
          .mockResolvedValueOnce([]),
        materialize: vi.fn(),
      },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([]),
        reserve: vi.fn(),
        beginSend: vi.fn(),
        recordResult: vi.fn(),
      },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-14T00:00:00.000Z"),
      dependencies,
    );

    expect(stats.workspaces).toBe(2);
    expect(stats.errors).toContain("occurrence_scan_failed");
    expect(stats.errorCauses).toContain("occurrence_scan_failed:ydb_400080:error");
    expect(stats.errorCauses.join(" ")).not.toContain("SELECT");
    expect(dependencies.occurrences.listRuntimeCandidates).toHaveBeenCalledWith(
      "workspace-b",
      expect.any(Date),
    );
  });

  it("distinguishes message-sync claim failures from scan failures", async () => {
    const item = occurrence();
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: {
        listMessageSyncCandidates: vi.fn().mockResolvedValue([{
          occurrence: item,
          stateRevision: item.stateRevision,
          retireOnly: false,
        }]),
        beginMessageSync: vi.fn().mockRejectedValue(
          new Error("code = 400080; SELECT private_value"),
        ),
        finishMessageSync: vi.fn(),
        listRuntimeCandidates: vi.fn().mockResolvedValue([]),
        materialize: vi.fn(),
      },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([]),
        reserve: vi.fn(),
        beginSend: vi.fn(),
        recordResult: vi.fn(),
      },
      telegram: { send: vi.fn(), delete: vi.fn(), editFinal: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-14T00:00:00.000Z"),
      dependencies,
    );

    expect(stats.errors).toContain("message_sync_begin_failed");
    expect(stats.errors).not.toContain("message_sync_scan_failed");
    expect(stats.errorCauses).toContain("message_sync_begin_failed:ydb_400080:error");
  });

  it("cancels a stale private reservation before sending", async () => {
    const item = occurrence();
    item.visibility = "private";
    const reservation = reservedDelivery(item);
    const recordResult = vi.fn().mockResolvedValue({
      ...reservation.delivery,
      status: "cancelled",
      errorCode: "reservation_stale",
    });
    const send = vi.fn();
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({ valid: false, targetChatId: 999 }),
        recordResult,
      },
      telegram: { send, delete: vi.fn(), editFinal: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:00:00.000Z"),
      dependencies,
    );

    expect(send).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it("distinguishes begin-send failures from reservation failures", async () => {
    const item = occurrence();
    const reservation = reservedDelivery(item);
    const send = vi.fn();
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: {
        ...noMessageSync(),
        listRuntimeCandidates: vi.fn().mockResolvedValue([]),
        materialize: vi.fn(),
      },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockRejectedValue(
          new Error("code = 400080; SELECT private_value"),
        ),
        recordResult: vi.fn(),
      },
      telegram: { send, delete: vi.fn(), editFinal: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:00:00.000Z"),
      dependencies,
    );

    expect(send).not.toHaveBeenCalled();
    expect(stats.errors).toContain("delivery_begin_send_failed");
    expect(stats.errors).not.toContain("delivery_reserve_failed");
    expect(stats.errorCauses).toContain("delivery_begin_send_failed:ydb_400080:error");
  });

  it("renders watcher mentions even when recurrence lookup fails", async () => {
    const item = occurrence();
    const reservation = {
      ...reservedDelivery(item),
      escalationWatchers: [{ userId: 10, displayName: "Анна" }],
      delivery: { ...reservedDelivery(item).delivery, deliveryType: "escalation" as const },
    };
    const send = vi.fn().mockResolvedValue(777);
    const getById = vi.fn().mockRejectedValue(new Error("temporary reminder read failure"));
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      reminders: { getById },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({
          valid: true,
          targetChatId: reservation.targetChatId,
        }),
        recordResult: vi.fn().mockResolvedValue({
          ...reservation.delivery,
          status: "sent",
          telegramMessageId: 777,
        }),
      },
      telegram: { send, delete: vi.fn().mockResolvedValue(undefined), editFinal: vi.fn() },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-27T12:00:00.000Z"),
      dependencies,
    );

    expect(send.mock.calls[0]?.[2]).toContain("Нужна помощь наблюдателей");
    expect(send.mock.calls[0]?.[2]).toContain("tg://user?id=10");
    expect(getById).toHaveBeenCalledWith("workspace-a", "reminder-a");
    expect(stats.sent).toBe(1);
    expect(stats.errors).toEqual([]);
  });

  it("compacts the previous message when Telegram cannot delete it", async () => {
    const item = occurrence();
    const reservation = reservedDelivery(item);
    const editFinal = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({ valid: true, targetChatId: -100123 }),
        recordResult: vi.fn().mockResolvedValue({
          ...reservation.delivery,
          status: "sent",
          telegramMessageId: 777,
        }),
      },
      telegram: {
        send: vi.fn().mockResolvedValue(777),
        delete: vi.fn().mockRejectedValue(new Error("too old")),
        editFinal,
      },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:00:00.000Z"),
      dependencies,
    );

    expect(stats.sent).toBe(1);
    expect(editFinal).toHaveBeenCalledWith(
      "test-token",
      -100123,
      55,
      "↪️ Напоминание обновлено. Используйте последнее сообщение.",
    );
  });

  it("keeps the YDB cause when persisting a successful send fails", async () => {
    const item = occurrence();
    item.latestMessageChatId = null;
    item.latestMessageId = null;
    const reservation = reservedDelivery(item);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const recordResult = vi.fn()
      .mockRejectedValueOnce(new Error("code = 400080; SELECT private_value"))
      .mockResolvedValueOnce({
        ...reservation.delivery,
        status: "unknown",
        errorCode: "delivery_result_persist_failed",
      });
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({ valid: true, targetChatId: -100123 }),
        recordResult,
      },
      telegram: {
        send: vi.fn().mockResolvedValue(777),
        delete: deleteMessage,
        editFinal: vi.fn(),
      },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:00:00.000Z"),
      dependencies,
    );

    expect(deleteMessage).toHaveBeenCalledWith("test-token", -100123, 777);
    expect(stats.unknown).toBe(1);
    expect(stats.errors).toContain("delivery_result_persist_failed");
    expect(stats.errors).not.toContain("telegram_transport_unknown");
    expect(stats.errorCauses).toContain("delivery_result_persist_failed:ydb_400080:error");
    expect(recordResult).toHaveBeenNthCalledWith(
      2,
      "workspace-a",
      "delivery-a",
      { status: "unknown", errorCode: "delivery_result_persist_failed" },
      expect.any(Date),
    );
  });

  it("records a forensic cause when a successful send loses its delivery lease", async () => {
    const item = occurrence();
    item.latestMessageChatId = null;
    item.latestMessageId = null;
    const reservation = reservedDelivery(item);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const recordResult = vi.fn().mockResolvedValue({
      ...reservation.delivery,
      status: "unknown",
      errorCode: "send_lease_lost",
    });
    const dependencies = {
      workspaces: { listActive: vi.fn().mockResolvedValue([{ workspaceId: "workspace-a" }]) },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: { ...noMessageSync(), listRuntimeCandidates: vi.fn().mockResolvedValue([]), materialize: vi.fn() },
      deliveries: {
        listCandidates: vi.fn().mockResolvedValue([{ occurrenceId: item.occurrenceId }]),
        reserve: vi.fn().mockResolvedValue(reservation),
        beginSend: vi.fn().mockResolvedValue({ valid: true, targetChatId: -100123 }),
        recordResult,
      },
      telegram: {
        send: vi.fn().mockResolvedValue(777),
        delete: deleteMessage,
        editFinal: vi.fn(),
      },
    } as unknown as DispatcherDependencies;

    const stats = await runDispatcher(
      config,
      new Date("2026-08-13T12:00:00.000Z"),
      dependencies,
    );

    expect(recordResult).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith("test-token", -100123, 777);
    expect(stats.unknown).toBe(1);
    expect(stats.errors).toContain("send_lease_lost");
    expect(stats.errorCauses).toContain(
      "delivery_result_conflict:send_lease_lost:delivery_state",
    );
  });
});

it.each([null, 42])("sends to the reserved forum destination %s without changing the mention", async (messageThreadId) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { message_id: 77 } }) });
  vi.stubGlobal("fetch", fetchMock);
  try {
    await createTelegramClient().send("test-token", -100123, '<a href="tg://user?id=20">Иван</a>', { inline_keyboard: [] }, messageThreadId);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ chat_id: -100123, parse_mode: "HTML", text: '<a href="tg://user?id=20">Иван</a>' });
    if (messageThreadId == null) expect(body).not.toHaveProperty("message_thread_id");
    else expect(body.message_thread_id).toBe(42);
  } finally {
    vi.unstubAllGlobals();
  }
});
