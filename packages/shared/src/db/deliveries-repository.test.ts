import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import {
  DeliveriesRepository,
  DeliveryTargetUnavailableError,
  createDeliveryKey,
} from "./deliveries-repository.js";
import { decodeYdbValue, parseYdbTimestamp } from "./ydb-utils.js";

type Cell = string | number | boolean | null;

function resultSet(rows: Array<Record<string, Cell>>) {
  const names = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns: names.map((name) => ({ name })),
    rows: rows.map((row) => ({
      items: names.map((name) => {
        const value = row[name];
        if (value == null) return { nullFlagValue: "NULL_VALUE" };
        if (typeof value === "string") return { textValue: value };
        if (typeof value === "boolean") return { boolValue: value };
        return { int64Value: value };
      }),
    })),
  };
}

function occurrenceRow(overrides: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    workspace_id: "workspace-a",
    occurrence_id: "occurrence-a",
    reminder_id: "reminder-a",
    reminder_version: 1,
    due_at: "2026-08-25T15:00:00.000Z",
    due_local_date: "2026-08-25",
    all_day: false,
    reminder_start_at: "2026-08-13T12:00:00.000Z",
    status: "pending",
    notification_state: "waiting",
    assignment_mode: "person",
    responsible_user_id: 20,
    title: "Передать показания",
    description: null,
    action_url: null,
    amount_minor: null,
    currency: null,
    visibility: "group",
    timezone: "Europe/Moscow",
    repeat_interval_minutes: 360,
    ignore_quiet_hours: false,
    escalation_enabled: true,
    escalation_delay_minutes: 1440,
    escalation_repeat_minutes: 1440,
    next_notification_at: "2026-08-13T12:00:00.000Z",
    notification_sequence: 0,
    snoozed_by: null,
    snoozed_at: null,
    snooze_until: null,
    latest_message_chat_id: null,
    latest_message_id: null,
    completed_by: null,
    completed_at: null,
    undo_until: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancelled_at: null,
    created_at: "2026-08-13T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

const workspaceRow: Record<string, Cell> = {
  telegram_chat_id: -100123,
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  status: "active",
};

function reservationDouble(
  occurrence: Record<string, Cell>,
  userRows: Array<Record<string, Cell>> = [],
) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-delivery" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => {
      if (query.includes("AND next_notification_at <= $now")) {
        return { resultSets: [resultSet([occurrence]), resultSet([workspaceRow])] };
      }
      if (query.includes("SELECT private_chat_available")) {
        return { resultSets: [resultSet(userRows)] };
      }
      return { resultSets: [] };
    }),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new DeliveriesRepository("", "", runSession), session };
}

describe("DeliveriesRepository.reserve", () => {
  it("reserves a deterministic initial delivery and advances the next ping", async () => {
    const { repository, session } = reservationDouble(occurrenceRow());
    const now = new Date("2026-08-13T12:00:00.000Z");
    const reservation = await repository.reserve("workspace-a", "occurrence-a", now);

    expect(reservation?.delivery).toMatchObject({
      deliveryType: "initial",
      sequence: 0,
      status: "reserved",
      telegramChatId: -100123,
    });
    expect(reservation?.delivery.deliveryKey).toBe(
      createDeliveryKey("occurrence-a", "initial", now, 0),
    );
    expect(reservation?.nextNotificationAt.toISOString()).toBe(
      "2026-08-13T18:00:00.000Z",
    );

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO notification_deliveries"),
    );
    expect(writeCall?.[0]).toContain("notification_sequence = $next_sequence");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$next_sequence)).toBe(1);
  });

  it("defers a late cron claim to 08:00 instead of sending in quiet hours", async () => {
    const scheduled = "2026-08-13T20:00:00.000Z";
    const { repository, session } = reservationDouble(
      occurrenceRow({ next_notification_at: scheduled, reminder_start_at: scheduled }),
    );
    const reservation = await repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date(scheduled),
    );

    expect(reservation).toBeNull();
    const deferCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("DECLARE $deferred_until"),
    );
    expect(
      parseYdbTimestamp(
        decodeYdbValue(deferCall?.[1]?.$deferred_until),
      )?.toISOString(),
    ).toBe(
      "2026-08-14T05:00:00.000Z",
    );
    expect(
      session.executeQuery.mock.calls.some(([query]) =>
        query.includes("INSERT INTO notification_deliveries"),
      ),
    ).toBe(false);
  });

  it("does not reserve a private delivery without an opened bot chat", async () => {
    const { repository, session } = reservationDouble(
      occurrenceRow({ visibility: "private" }),
    );

    await expect(
      repository.reserve(
        "workspace-a",
        "occurrence-a",
        new Date("2026-08-13T12:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(DeliveryTargetUnavailableError);
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "tx-delivery" });
  });
});

describe("DeliveriesRepository.recordResult", () => {
  it("rejects raw external error text before opening a database session", async () => {
    const runSession = vi.fn();
    const repository = new DeliveriesRepository("", "", runSession as SessionRunner);

    await expect(
      repository.recordResult("workspace-a", "delivery-a", {
        status: "failed",
        errorCode: "Bad Request: chat not found",
      }),
    ).rejects.toThrow("sanitized identifier");
    expect(runSession).not.toHaveBeenCalled();
  });

  it("finalizes a reserved delivery and stores the live Telegram message", async () => {
    const existing = {
      workspace_id: "workspace-a",
      delivery_key: "delivery-a",
      occurrence_id: "occurrence-a",
      reminder_id: "reminder-a",
      delivery_type: "initial",
      sequence: 0,
      scheduled_at: "2026-08-13T12:00:00.000Z",
      claimed_at: "2026-08-13T12:00:00.000Z",
      status: "reserved",
      telegram_chat_id: -100123,
      telegram_message_id: null,
      error_code: null,
      created_at: "2026-08-13T12:00:00.000Z",
      updated_at: "2026-08-13T12:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-result" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM notification_deliveries")
          ? [resultSet([existing])]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new DeliveriesRepository("", "", runSession);

    const delivery = await repository.recordResult(
      "workspace-a",
      "delivery-a",
      { status: "sent", telegramMessageId: 777 },
      new Date("2026-08-13T12:00:01.000Z"),
    );

    expect(delivery).toMatchObject({ status: "sent", telegramMessageId: 777 });
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPDATE notification_deliveries SET"),
    );
    expect(writeCall?.[0]).toContain("UPDATE reminder_occurrences SET");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$occurrence_id)).toBe("occurrence-a");
  });
});
