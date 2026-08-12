import { describe, expect, it, vi } from "vitest";
import type {
  AppConfig,
  NotificationDelivery,
  ReminderOccurrence,
  ReservedDelivery,
} from "@zvenfit-reminder/shared";
import {
  runUniversalDispatcher,
  type UniversalDispatcherDependencies,
} from "./universal-dispatcher.js";

const config: AppConfig = {
  ydbEndpoint: "grpc://unused",
  ydbDatabase: "/unused",
  botToken: "test-token",
  webhookSecret: "test-secret",
  allowedChatId: -100123,
  defaultTimezone: "Europe/Moscow",
  miniAppUrl: "",
  adminUserIds: [],
  universalRemindersEnabled: true,
};

function occurrence(): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    reminderVersion: 1,
    dueAt: new Date("2026-08-25T15:00:00.000Z"),
    dueLocalDate: "2026-08-25",
    allDay: false,
    reminderStartAt: new Date("2026-08-13T12:00:00.000Z"),
    status: "pending",
    notificationState: "waiting",
    assignment: { mode: "person", responsibleUserId: 20 },
    title: "Передать показания",
    description: null,
    actionUrl: null,
    amountMinor: null,
    currency: null,
    visibility: "group",
    timezone: "Europe/Moscow",
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 },
    nextNotificationAt: new Date("2026-08-13T12:00:00.000Z"),
    notificationSequence: 0,
    snoozedBy: null,
    snoozedAt: null,
    snoozeUntil: null,
    latestMessageChatId: -100123,
    latestMessageId: 55,
    completedBy: null,
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
      telegramMessageId: null,
      errorCode: null,
      createdAt: new Date("2026-08-13T12:00:00.000Z"),
      updatedAt: new Date("2026-08-13T12:00:00.000Z"),
    },
  };
}

describe("runUniversalDispatcher", () => {
  it("scopes every scan to the configured workspace and runs reserve-before-send", async () => {
    const item = occurrence();
    const reservation = reservedDelivery(item);
    const sentDelivery: NotificationDelivery = {
      ...reservation.delivery,
      status: "sent",
      telegramMessageId: 777,
    };
    const sendTelegram = vi.fn().mockResolvedValue(777);
    const dependencies = {
      workspaces: {
        getByTelegramChatId: vi.fn().mockResolvedValue({
          workspaceId: "workspace-a",
          status: "active",
        }),
      },
      actions: {
        listCompletionFinalizationCandidates: vi.fn().mockResolvedValue([]),
        finalizeCompletion: vi.fn(),
      },
      occurrences: {
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
        recordResult: vi.fn().mockResolvedValue(sentDelivery),
      },
      telegram: {
        send: sendTelegram,
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as UniversalDispatcherDependencies;
    const now = new Date("2026-08-13T12:00:00.000Z");

    const stats = await runUniversalDispatcher(config, now, dependencies);

    expect(stats).toMatchObject({
      mode: "universal",
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
});
