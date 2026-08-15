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
    state_revision: 1,
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
    watcher_user_ids: JSON.stringify([10]),
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
  watcherRows: Array<Record<string, Cell>> = [],
  lastEscalationRows: Array<Record<string, Cell>> = [],
) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-delivery" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => {
      if (query.includes("AND next_notification_at <= $now")) {
        return {
          resultSets: [
            resultSet([occurrence]),
            resultSet([workspaceRow]),
            resultSet(watcherRows),
            resultSet(lastEscalationRows),
          ],
        };
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

    const readCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("AND next_notification_at <= $now"),
    );
    expect(readCall?.[0]).toContain("ORDER BY user_id");
    expect(readCall?.[0]).toContain("ORDER BY claimed_at DESC");
    expect(readCall?.[0]).not.toContain("ORDER BY member.user_id");
    expect(readCall?.[0]).not.toContain("ORDER BY delivery.claimed_at");

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO notification_deliveries"),
    );
    expect(writeCall?.[0]).toContain("notification_sequence = $next_sequence");
    expect(writeCall?.[0]).toContain("delivery_lock_key = $delivery_key");
    expect(writeCall?.[0]).toContain("status = IF(due_at <= $claimed_at, $overdue_status, status)");
    expect(decodeYdbValue(writeCall?.[1]?.$overdue_status)).toBe("overdue");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$next_sequence)).toBe(1);
    expect(decodeYdbValue(writeCall?.[1]?.$occurrence_revision)).toBe(1);
  });

  it("does not advance a due ping while Telegram message sync owns the occurrence", async () => {
    const { repository, session } = reservationDouble(occurrenceRow({
      delivery_lock_key: "message-sync:occurrence-a:7:active",
      delivery_locked_at: "2026-08-13T11:59:30.000Z",
    }));

    await expect(repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:00:00.000Z"),
    )).resolves.toBeNull();

    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("INSERT INTO notification_deliveries"))).toBe(false);
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

  it("escalates overdue work to active watchers no more often than configured", async () => {
    const { repository } = reservationDouble(
      occurrenceRow({
        status: "overdue",
        due_at: "2026-08-12T12:00:00.000Z",
        next_notification_at: "2026-08-13T12:00:00.000Z",
        notification_sequence: 3,
      }),
      [],
      [{ user_id: 10, display_name: "Анна" }],
    );

    const reservation = await repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(reservation?.delivery.deliveryType).toBe("escalation");
    expect(reservation?.escalationWatchers).toEqual([{ userId: 10, displayName: "Анна" }]);
  });

  it("keeps regular repeats before the next watcher escalation window", async () => {
    const { repository } = reservationDouble(
      occurrenceRow({
        status: "overdue",
        due_at: "2026-08-10T12:00:00.000Z",
        next_notification_at: "2026-08-13T12:00:00.000Z",
        notification_sequence: 4,
      }),
      [],
      [{ user_id: 10, display_name: "Анна" }],
      [{ claimed_at: "2026-08-13T06:00:00.000Z" }],
    );

    const reservation = await repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(reservation?.delivery.deliveryType).toBe("repeat");
    expect(reservation?.escalationWatchers).toEqual([]);
  });

  it("uses the latest failed escalation attempt to prevent rapid watcher retries", async () => {
    const { repository, session } = reservationDouble(
      occurrenceRow({
        status: "overdue",
        due_at: "2026-08-10T12:00:00.000Z",
        next_notification_at: "2026-08-13T12:00:00.000Z",
        notification_sequence: 4,
      }),
      [],
      [{ user_id: 10, display_name: "Анна" }],
      [{ claimed_at: "2026-08-13T06:00:00.000Z" }],
    );

    const reservation = await repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:00:00.000Z"),
    );

    const read = session.executeQuery.mock.calls[0]?.[0];
    expect(read).not.toContain("status IN ('reserved', 'sent')");
    expect(reservation?.delivery.deliveryType).toBe("repeat");
  });

  it("does not reuse an old escalation window after the due date moves forward", async () => {
    const { repository } = reservationDouble(
      occurrenceRow({
        due_at: "2026-08-25T15:00:00.000Z",
        next_notification_at: "2026-08-13T12:00:00.000Z",
        notification_sequence: 4,
      }),
      [],
      [{ user_id: 10, display_name: "Анна" }],
      [{ claimed_at: "2026-08-12T06:00:00.000Z" }],
    );

    const reservation = await repository.reserve(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:00:00.000Z"),
    );

    expect(reservation?.delivery.deliveryType).toBe("repeat");
  });
});

describe("DeliveriesRepository.beginSend", () => {
  it("rejects a private reservation whose responsible chat changed", async () => {
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-send" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn().mockResolvedValue({
        resultSets: [resultSet([{
          delivery_status: "reserved",
          reserved_chat_id: 100,
          occurrence_revision: 1,
          occurrence_id: "occurrence-a",
          occurrence_status: "pending",
          state_revision: 1,
          delivery_lock_key: null,
          delivery_locked_at: null,
          notification_state: "waiting",
          visibility: "private",
          assignment_mode: "person",
          responsible_user_id: 30,
          reminder_status: "active",
          workspace_status: "active",
          workspace_chat_id: -100123,
          private_chat_available: true,
          private_chat_id: 200,
        }])],
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new DeliveriesRepository("", "", runSession);

    await expect(repository.beginSend(
      "workspace-a",
      "delivery-a",
      new Date("2026-08-13T12:00:00.000Z"),
    ))
      .resolves.toEqual({ valid: false, targetChatId: 200 });
    expect(session.executeQuery.mock.calls[0]?.[0]).toContain("delivery.status AS delivery_status");
    expect(session.executeQuery.mock.calls[0]?.[0]).toContain(
      "ON user.user_id = occurrence.responsible_user_id",
    );
    expect(session.executeQuery.mock.calls[0]?.[0]).not.toContain(
      "ON occurrence.assignment_mode = 'person'",
    );
    expect(session.executeQuery.mock.calls[1]?.[0]).toContain("reservation_stale");
  });

  it("atomically fences a valid reservation before Telegram send", async () => {
    const row = {
      delivery_status: "reserved",
      reserved_chat_id: -100123,
      occurrence_revision: 7,
      occurrence_id: "occurrence-a",
      occurrence_status: "overdue",
      state_revision: 7,
      delivery_lock_key: "delivery-a",
      delivery_locked_at: "2026-08-13T11:59:30.000Z",
      notification_state: "waiting",
      visibility: "group",
      assignment_mode: "person",
      responsible_user_id: 20,
      reminder_status: "active",
      workspace_status: "active",
      workspace_chat_id: -100123,
      private_chat_available: false,
      private_chat_id: null,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-send" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("delivery.status AS delivery_status")
          ? [resultSet([row])]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new DeliveriesRepository("", "", runSession);

    await expect(repository.beginSend(
      "workspace-a",
      "delivery-a",
      new Date("2026-08-13T12:00:00.000Z"),
    )).resolves.toEqual({ valid: true, targetChatId: -100123 });

    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("status = 'sending'"));
    expect(write?.[0]).toContain("delivery_lock_key = $delivery_key");
    expect(session.commitTransaction).toHaveBeenCalled();
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

  it("finalizes a sending delivery and releases its occurrence lease", async () => {
    const existing = {
      workspace_id: "workspace-a",
      delivery_key: "delivery-a",
      occurrence_id: "occurrence-a",
      reminder_id: "reminder-a",
      delivery_type: "initial",
      sequence: 0,
      scheduled_at: "2026-08-13T12:00:00.000Z",
      claimed_at: "2026-08-13T12:00:00.000Z",
      status: "sending",
      occurrence_revision: 1,
      current_state_revision: 1,
      delivery_lock_key: "delivery-a",
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
        resultSets: query.includes("FROM notification_deliveries AS delivery")
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
    expect(writeCall?.[0]).toContain("delivery_lock_key = NULL");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$occurrence_id)).toBe("occurrence-a");
  });

  it("marks a late result unknown after its occurrence lease was reclaimed", async () => {
    const existing = {
      workspace_id: "workspace-a",
      delivery_key: "delivery-a",
      occurrence_id: "occurrence-a",
      reminder_id: "reminder-a",
      delivery_type: "initial",
      sequence: 0,
      scheduled_at: "2026-08-13T12:00:00.000Z",
      claimed_at: "2026-08-13T12:00:00.000Z",
      status: "sending",
      occurrence_revision: 1,
      current_state_revision: 2,
      delivery_lock_key: null,
      telegram_chat_id: -100123,
      telegram_message_id: null,
      error_code: null,
      created_at: "2026-08-13T12:00:00.000Z",
      updated_at: "2026-08-13T12:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-late-result" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("FROM notification_deliveries AS delivery")
          ? [resultSet([existing])]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new DeliveriesRepository("", "", runSession);

    await expect(repository.recordResult(
      "workspace-a",
      "delivery-a",
      { status: "sent", telegramMessageId: 777 },
      new Date("2026-08-13T12:03:00.000Z"),
    )).resolves.toMatchObject({ status: "unknown", errorCode: "send_lease_lost" });

    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("send_lease_lost"),
    );
    expect(write?.[0]).not.toContain("latest_message_id");
  });
});
