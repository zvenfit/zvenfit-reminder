import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import {
  OccurrenceActionsRepository,
  OccurrenceNotActionableError,
  UndoWindowExpiredError,
} from "./occurrence-actions-repository.js";
import { DeliveryInProgressError } from "./delivery-guard.js";
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
    next_notification_at: "2026-08-13T12:00:00.000Z",
    notification_sequence: 1,
    snoozed_by: null,
    snoozed_at: null,
    snooze_until: null,
    latest_message_chat_id: -100123,
    latest_message_id: 777,
    completed_by: null,
    completed_by_display_name: null,
    actor_display_name: "Иван Петров",
    completed_at: null,
    undo_until: null,
    completion_finalized_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancelled_at: null,
    created_at: "2026-08-13T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

const runtimeRow: Record<string, Cell> = {
  workspace_id: "workspace-a",
  reminder_id: "reminder-a",
  state: "blocked",
  next_due_at: null,
  next_reminder_start_at: null,
  current_occurrence_id: "occurrence-a",
  schedule_version: 1,
  updated_at: "2026-08-13T12:00:00.000Z",
};

const workspaceRow: Record<string, Cell> = {
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  default_all_day_reminder_time: "09:00",
  status: "active",
};

const reminderRow: Record<string, Cell> = {
  workspace_id: "workspace-a",
  reminder_id: "reminder-a",
  title: "Передать показания",
  description: null,
  action_url: null,
  amount_minor: null,
  currency: null,
  visibility: "group",
  creator_user_id: 10,
  assignment_mode: "person",
  responsible_user_id: 20,
  schedule_spec: JSON.stringify({
    version: 1,
    frequency: "monthly",
    startDate: "2026-01-01",
    timing: { kind: "timed", timeLocal: "18:00" },
    interval: 1,
    day: { type: "dayOfMonth", value: 25, overflow: "lastDay" },
  }),
  timezone: "Europe/Moscow",
  lead_minutes: 0,
  repeat_interval_minutes: 360,
  ignore_quiet_hours: false,
  escalation_enabled: true,
  escalation_delay_minutes: 1440,
  escalation_repeat_minutes: 1440,
  status: "active",
  version: 1,
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-08-13T12:00:00.000Z",
};

function repositoryDouble(resultSetsForRead: ReturnType<typeof resultSet>[]) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-action" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => ({
      resultSets: query.includes("FROM reminder_occurrences")
        ? resultSetsForRead
        : [],
    })),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new OccurrenceActionsRepository("", "", runSession), session };
}

describe("OccurrenceActionsRepository", () => {
  it("fences completion while the reserved Telegram payload is being sent", async () => {
    const { repository, session } = repositoryDouble([
      resultSet([occurrenceRow({
        delivery_lock_key: "delivery-a",
        delivery_locked_at: "2026-08-13T12:00:00.000Z",
      })]),
      resultSet([runtimeRow]),
    ]);

    await expect(repository.complete(
      "workspace-a",
      "occurrence-a",
      20,
      new Date("2026-08-13T12:00:30.000Z"),
    )).rejects.toBeInstanceOf(DeliveryInProgressError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("snoozes through quiet hours without resetting the delivery sequence", async () => {
    const { repository, session } = repositoryDouble([
      resultSet([occurrenceRow()]),
      resultSet([workspaceRow]),
    ]);
    const occurrence = await repository.snooze(
      "workspace-a",
      "occurrence-a",
      20,
      new Date("2026-08-13T20:00:00.000Z"),
      new Date("2026-08-13T18:00:00.000Z"),
    );

    expect(occurrence?.snoozeUntil?.toISOString()).toBe("2026-08-14T05:00:00.000Z");
    expect(occurrence?.notificationSequence).toBe(1);
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("snoozed_by = $actor_user_id"),
    );
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(writeCall?.[0]).toContain("'occurrence.snoozed'");
  });

  it("marks a snoozed occurrence overdue as soon as its deadline has passed", async () => {
    const { repository, session } = repositoryDouble([
      resultSet([occurrenceRow({ due_at: "2026-08-13T17:00:00.000Z" })]),
      resultSet([workspaceRow]),
    ]);
    const occurrence = await repository.snooze(
      "workspace-a",
      "occurrence-a",
      20,
      new Date("2026-08-14T09:00:00.000Z"),
      new Date("2026-08-13T18:00:00.000Z"),
    );

    expect(occurrence?.status).toBe("overdue");
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("snoozed_by = $actor_user_id"));
    expect(writeCall?.[0]).toContain(
      "status = IF(due_at <= $now, $overdue_status, status)",
    );
    expect(decodeYdbValue(writeCall?.[1]?.$revision_increment)).toBe(1);
    expect(decodeYdbValue(writeCall?.[1]?.$overdue_status)).toBe("overdue");
  });

  it("completes idempotently while retaining the runtime slot for ten minutes", async () => {
    const { repository, session } = repositoryDouble([
      resultSet([occurrenceRow()]),
      resultSet([runtimeRow]),
    ]);
    const now = new Date("2026-08-13T12:00:00.000Z");
    const occurrence = await repository.complete("workspace-a", "occurrence-a", 20, now);

    expect(occurrence).toMatchObject({
      status: "completed",
      notificationState: "stopped",
      completedBy: 20,
      completedByDisplayName: "Иван Петров",
      nextNotificationAt: null,
    });
    expect(occurrence?.undoUntil?.toISOString()).toBe("2026-08-13T12:10:00.000Z");
    const readCall = session.executeQuery.mock.calls[0];
    expect(readCall?.[0]).toContain("INNER JOIN workspace_members AS actor");
    expect(readCall?.[0]).toContain(
      "COALESCE(actor.display_name_override, actor_user.display_name)",
    );
    expect(readCall?.[0]).toContain("AND actor.user_id = $actor_user_id");
    expect(readCall?.[0]).not.toContain(
      "ON actor.workspace_id = occurrence.workspace_id\n              AND actor.user_id",
    );
    expect(readCall?.[0]).toContain("reminder.status = 'active'");
    expect(decodeYdbValue(readCall?.[1]?.$actor_user_id)).toBe(20);
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("status = 'completed'"),
    );
    expect(writeCall?.[0]).toContain("UPDATE reminder_runtime SET updated_at = $now");
    expect(writeCall?.[0]).toContain("snoozed_by = NULL");
    expect(writeCall?.[0]).toContain("completed_by_display_name = $actor_display_name");
    expect(decodeYdbValue(writeCall?.[1]?.$actor_display_name)).toBe("Иван Петров");
    expect(writeCall?.[0]).toContain("'occurrence.completed'");
    expect(writeCall?.[0]).not.toContain("state = 'ready'");
  });

  it("rejects a duplicate completion instead of attributing it to the second actor", async () => {
    const { repository } = repositoryDouble([
      resultSet([occurrenceRow({
        status: "completed",
        completed_by: 20,
        completed_at: "2026-08-13T12:00:00.000Z",
        undo_until: "2026-08-13T12:10:00.000Z",
      })]),
      resultSet([runtimeRow]),
    ]);

    await expect(repository.complete(
      "workspace-a",
      "occurrence-a",
      30,
      new Date("2026-08-13T12:01:00.000Z"),
    )).rejects.toBeInstanceOf(OccurrenceNotActionableError);
  });

  it("undoes completion on the same occurrence and respects quiet hours", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      completed_by: 20,
      completed_at: "2026-08-13T19:58:00.000Z",
      undo_until: "2026-08-13T20:08:00.000Z",
    });
    const { repository, session } = repositoryDouble([
      resultSet([completed]),
      resultSet([runtimeRow]),
      resultSet([workspaceRow]),
    ]);
    const occurrence = await repository.undoCompletion(
      "workspace-a",
      "occurrence-a",
      20,
      new Date("2026-08-13T20:00:00.000Z"),
    );

    expect(occurrence).toMatchObject({
      status: "pending",
      notificationState: "waiting",
      completedBy: null,
      undoUntil: null,
    });
    expect(occurrence?.nextNotificationAt?.toISOString()).toBe(
      "2026-08-14T05:00:00.000Z",
    );
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("completed_by = NULL"),
    );
    expect(writeCall?.[0]).toContain("'occurrence.completion_undone'");
    expect(decodeYdbValue(writeCall?.[1]?.$actor_user_id)).toBe(20);
  });

  it("rejects a duplicate undo instead of attributing it to the second actor", async () => {
    const { repository } = repositoryDouble([
      resultSet([occurrenceRow({ status: "pending" })]),
      resultSet([runtimeRow]),
      resultSet([workspaceRow]),
    ]);

    await expect(repository.undoCompletion(
      "workspace-a",
      "occurrence-a",
      30,
      new Date("2026-08-13T20:01:00.000Z"),
    )).rejects.toBeInstanceOf(OccurrenceNotActionableError);
  });

  it("rejects undo after the ten-minute window", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      completed_by: 20,
      completed_at: "2026-08-13T12:00:00.000Z",
      undo_until: "2026-08-13T12:10:00.000Z",
    });
    const { repository } = repositoryDouble([
      resultSet([completed]),
      resultSet([runtimeRow]),
      resultSet([workspaceRow]),
    ]);

    await expect(
      repository.undoCompletion(
        "workspace-a",
        "occurrence-a",
        20,
        new Date("2026-08-13T12:10:00.001Z"),
      ),
    ).rejects.toBeInstanceOf(UndoWindowExpiredError);
  });

  it("finalizes a recurring completion to the first schedule date after now", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      due_at: "2026-08-25T15:00:00.000Z",
      completed_by: 20,
      completed_at: "2026-09-27T11:50:00.000Z",
      undo_until: "2026-09-27T12:00:00.000Z",
    });
    const { repository, session } = repositoryDouble([
      resultSet([completed]),
      resultSet([runtimeRow]),
      resultSet([reminderRow]),
      resultSet([workspaceRow]),
    ]);
    const finalized = await repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-09-27T12:01:00.000Z"),
    );

    expect(finalized?.archivedReminder).toBe(false);
    expect(finalized?.occurrence.undoUntil).toBeNull();
    expect(finalized?.nextDueAt?.toISOString()).toBe("2026-10-25T15:00:00.000Z");
    expect(finalized?.nextReminderStartAt?.toISOString()).toBe(
      "2026-10-25T15:00:00.000Z",
    );
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("current_occurrence_id = NULL"),
    );
    expect(decodeYdbValue(writeCall?.[1]?.$runtime_state)).toBe("ready");
    expect(
      parseYdbTimestamp(decodeYdbValue(writeCall?.[1]?.$next_due_at))?.toISOString(),
    ).toBe("2026-10-25T15:00:00.000Z");
  });

  it("skips the current due slot when work is completed during its lead window", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      due_at: "2026-08-25T15:00:00.000Z",
      completed_by: 20,
      completed_at: "2026-08-13T12:00:00.000Z",
      undo_until: "2026-08-13T12:10:00.000Z",
    });
    const { repository } = repositoryDouble([
      resultSet([completed]),
      resultSet([runtimeRow]),
      resultSet([reminderRow]),
      resultSet([workspaceRow]),
    ]);

    const finalized = await repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:11:00.000Z"),
    );

    expect(finalized?.nextDueAt?.toISOString()).toBe("2026-09-25T15:00:00.000Z");
  });

  it("finalizes completed work after member removal paused its series", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      completed_by: 20,
      completed_at: "2026-08-13T12:00:00.000Z",
      undo_until: "2026-08-13T12:10:00.000Z",
    });
    const { repository } = repositoryDouble([
      resultSet([completed]),
      resultSet([{ ...runtimeRow, state: "paused" }]),
      resultSet([{ ...reminderRow, status: "paused" }]),
      resultSet([workspaceRow]),
    ]);

    await expect(repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:11:00.000Z"),
    )).resolves.toMatchObject({ archivedReminder: false, nextDueAt: null });
  });

  it("archives a completed one-off reminder after the undo window", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      completed_by: 20,
      completed_at: "2026-08-25T15:00:00.000Z",
      undo_until: "2026-08-25T15:10:00.000Z",
    });
    const oneOffReminder = {
      ...reminderRow,
      schedule_spec: JSON.stringify({
        version: 1,
        frequency: "once",
        date: "2026-08-25",
        timing: { kind: "timed", timeLocal: "18:00" },
      }),
    };
    const { repository, session } = repositoryDouble([
      resultSet([completed]),
      resultSet([runtimeRow]),
      resultSet([oneOffReminder]),
      resultSet([workspaceRow]),
    ]);

    const finalized = await repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-25T15:11:00.000Z"),
    );

    expect(finalized).toMatchObject({
      archivedReminder: true,
      nextDueAt: null,
      nextReminderStartAt: null,
    });
    expect(
      session.executeQuery.mock.calls.some(([query]) =>
        query.includes("status = 'archived'"),
      ),
    ).toBe(true);
  });

  it("retries only Telegram finalization after lifecycle state already advanced", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      completed_by: 20,
      completed_at: "2026-08-13T12:00:00.000Z",
      undo_until: "2026-08-13T12:10:00.000Z",
      completion_finalized_at: "2026-08-13T12:11:00.000Z",
    });
    const { repository, session } = repositoryDouble([
      resultSet([completed]),
      resultSet([{
        ...runtimeRow,
        state: "ready",
        current_occurrence_id: null,
        next_due_at: "2026-09-25T15:00:00.000Z",
        next_reminder_start_at: "2026-09-25T15:00:00.000Z",
      }]),
      resultSet([reminderRow]),
      resultSet([workspaceRow]),
    ]);

    await expect(repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:12:00.000Z"),
    )).resolves.toMatchObject({
      occurrence: { undoUntil: null },
      nextDueAt: new Date("2026-09-25T15:00:00.000Z"),
    });
    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("current_occurrence_id = NULL"))).toBe(false);
  });

  it("removes a finalized completion from the Telegram cleanup queue", async () => {
    const { repository, session } = repositoryDouble([]);

    await repository.markCompletionMessageFinalized(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-13T12:12:00.000Z"),
    );

    const write = session.executeQuery.mock.calls[0];
    expect(write?.[0]).toContain("completion_finalized_at IS NOT NULL");
    expect(write?.[0]).toContain("undo_until = NULL");
    expect(decodeYdbValue(write?.[1]?.$workspace_id)).toBe("workspace-a");
  });

  it("uses the edited series definition after the already-started occurrence completes", async () => {
    const completed = occurrenceRow({
      status: "completed",
      notification_state: "stopped",
      next_notification_at: null,
      completed_by: 20,
      completed_at: "2026-08-25T15:00:00.000Z",
      undo_until: "2026-08-25T15:10:00.000Z",
      reminder_version: 1,
    });
    const editedOneOff = {
      ...reminderRow,
      version: 2,
      schedule_spec: JSON.stringify({
        version: 1,
        frequency: "once",
        date: "2026-09-01",
        timing: { kind: "timed", timeLocal: "18:00" },
      }),
    };
    const { repository, session } = repositoryDouble([
      resultSet([completed]),
      resultSet([{ ...runtimeRow, schedule_version: 2 }]),
      resultSet([editedOneOff]),
      resultSet([workspaceRow]),
    ]);

    const finalized = await repository.finalizeCompletion(
      "workspace-a",
      "occurrence-a",
      new Date("2026-08-25T15:11:00.000Z"),
    );

    expect(finalized?.archivedReminder).toBe(false);
    expect(finalized?.nextDueAt?.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("status = 'archived'"))).toBe(false);
  });
});
