import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import {
  OccurrenceUpdateConflictError,
  OccurrencesRepository,
  rowToOccurrence,
} from "./occurrences-repository.js";
import { decodeYdbValue } from "./ydb-utils.js";

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
    startDate: "2026-08-01",
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
    watcher_user_ids: JSON.stringify([10]),
  status: "active",
  version: 1,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

function occurrenceRow(overrides: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    workspace_id: "workspace-a",
    occurrence_id: "occurrence-a",
    reminder_id: "reminder-a",
    reminder_version: 1,
    due_at: "2026-08-25T15:00:00.000Z",
    due_local_date: "2026-08-25",
    all_day: false,
    reminder_start_at: "2026-08-25T15:00:00.000Z",
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
    lead_minutes: 60,
    repeat_interval_minutes: 360,
    ignore_quiet_hours: false,
    escalation_enabled: false,
    escalation_delay_minutes: null,
    escalation_repeat_minutes: null,
    watcher_user_ids: JSON.stringify([10, 30]),
    next_notification_at: "2026-08-25T15:00:00.000Z",
    notification_sequence: 0,
    snoozed_by: null,
    snoozed_at: null,
    snooze_until: null,
    latest_message_chat_id: -100123,
    latest_message_id: 55,
    completed_by: null,
    completed_at: null,
    undo_until: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancelled_at: null,
    message_sync_required: true,
    message_sync_retire_only: false,
    state_revision: 7,
    delivery_lock_key: null,
    delivery_locked_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("rowToOccurrence", () => {
  it("returns the exact editable notification snapshot", () => {
    const occurrence = rowToOccurrence(occurrenceRow());

    expect(occurrence.leadMinutes).toBe(60);
    expect(occurrence.watcherUserIds).toEqual([10, 30]);
  });

  it("keeps the lead unknown for occurrences created before migration 0005", () => {
    const occurrence = rowToOccurrence(occurrenceRow({ lead_minutes: null }));

    expect(occurrence.leadMinutes).toBeNull();
  });
});

function syncRepository(row: Record<string, Cell>) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-sync" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => ({
      resultSets: query.includes("SELECT * FROM reminder_occurrences")
        ? [resultSet([row])]
        : [],
    })),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new OccurrencesRepository("", "", runSession), session };
}

function runtimeRow(state: "ready" | "blocked" = "ready"): Record<string, Cell> {
  return {
    workspace_id: "workspace-a",
    reminder_id: "reminder-a",
    state,
    next_due_at: "2026-08-25T15:00:00.000Z",
    next_reminder_start_at: "2026-08-13T09:00:00.000Z",
    current_occurrence_id: state === "blocked" ? "existing" : null,
    schedule_version: 1,
    updated_at: "2026-08-01T10:00:00.000Z",
  };
}

function repositoryDouble(state: "ready" | "blocked" = "ready") {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-occurrence" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => {
      if (query.includes("SELECT * FROM reminder_runtime")) {
        return {
          resultSets: [
            resultSet([runtimeRow(state)]),
            resultSet([reminderRow]),
            resultSet([{ user_id: 10 }]),
          ],
        };
      }
      return { resultSets: [] };
    }),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new OccurrencesRepository("", "", runSession), session };
}

function occurrenceUpdateDraft(leadMinutes: number | null, date = "2026-08-25") {
  return {
    kind: "task" as const,
    title: "Передать показания",
    description: null,
    actionUrl: null,
    amountMinor: null,
    currency: null,
    visibility: "group" as const,
    assignment: { mode: "person" as const, responsibleUserId: 20 },
    watcherUserIds: [10, 30],
    schedule: {
      version: 1 as const,
      frequency: "once" as const,
      date,
      timing: { kind: "timed" as const, timeLocal: "18:00" },
    },
    timezone: "Europe/Moscow",
    notificationPolicy: {
      leadMinutes,
      repeatIntervalMinutes: 360,
      ignoreQuietHours: false,
      escalation: { enabled: false as const },
    },
  };
}

function occurrenceUpdateRepository(storedLeadMinutes: number | null) {
  const storedOccurrence = occurrenceRow({
    lead_minutes: storedLeadMinutes,
    creator_user_id: 10,
    reminder_status: "active",
    reminder_start_at: "2026-08-25T14:00:00.000Z",
    next_notification_at: "2026-08-25T16:00:00.000Z",
    notification_sequence: 3,
    snoozed_by: 20,
    snoozed_at: "2026-08-24T10:00:00.000Z",
    snooze_until: "2026-08-25T16:00:00.000Z",
  });
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-occurrence-update" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => {
      if (query.includes("SELECT status, quiet_hours_start")) {
        return {
          resultSets: [
            resultSet([{
              status: "active",
              quiet_hours_start: "22:00",
              quiet_hours_end: "08:00",
              default_all_day_reminder_time: "09:00",
            }]),
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([storedOccurrence]),
            resultSet([{ current_occurrence_id: "occurrence-a" }]),
          ],
        };
      }
      if (query.includes("SELECT user_id, status FROM workspace_members")) {
        return {
          resultSets: [
            resultSet([
              { user_id: 10, status: "active" },
              { user_id: 20, status: "active" },
              { user_id: 30, status: "active" },
            ]),
            resultSet([]),
          ],
        };
      }
      if (query.includes("SELECT * FROM reminder_occurrences")) {
        return { resultSets: [resultSet([storedOccurrence])] };
      }
      return { resultSets: [] };
    }),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new OccurrencesRepository("", "", runSession), session };
}

describe("OccurrencesRepository.materialize", () => {
  it("atomically creates a snapshot and blocks the per-reminder runtime slot", async () => {
    const { repository, session } = repositoryDouble();
    const occurrence = await repository.materialize("workspace-a", "reminder-a", {
      occurrenceId: "occurrence-a",
      now: new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(occurrence).toMatchObject({
      occurrenceId: "occurrence-a",
      kind: "task",
      dueLocalDate: "2026-08-25",
      status: "pending",
      notificationState: "waiting",
      notificationSequence: 0,
      timezone: "Europe/Moscow",
      leadMinutes: 0,
      watcherUserIds: [10],
    });

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO reminder_occurrence_slots"),
    );
    expect(writeCall?.[0]).toContain("INSERT INTO reminder_occurrences");
    expect(writeCall?.[0]).toContain("state = 'blocked'");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$occurrence_id)).toBe("occurrence-a");
    expect(decodeYdbValue(writeCall?.[1]?.$kind)).toBe("task");
    expect(decodeYdbValue(writeCall?.[1]?.$lead_minutes)).toBe(0);
    expect(decodeYdbValue(writeCall?.[1]?.$watcher_user_ids)).toBe("[10]");
    expect(decodeYdbValue(writeCall?.[1]?.$message_sync_required)).toBe(false);
    expect(decodeYdbValue(writeCall?.[1]?.$message_sync_retire_only)).toBe(false);
    expect(session.commitTransaction).toHaveBeenCalledWith({ txId: "tx-occurrence" });
  });

  it("does not create a second occurrence while the runtime slot is blocked", async () => {
    const { repository, session } = repositoryDouble("blocked");
    const occurrence = await repository.materialize("workspace-a", "reminder-a", {
      now: new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(occurrence).toBeNull();
    expect(session.executeQuery).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).toHaveBeenCalled();
  });
});

describe("OccurrencesRepository.updateCurrentForActor notification snapshot", () => {
  it("preserves the exact legacy scheduling state for a nullable unchanged lead", async () => {
    const { repository, session } = occurrenceUpdateRepository(null);

    await repository.updateCurrentForActor(
      "workspace-a",
      "occurrence-a",
      occurrenceUpdateDraft(null),
      20,
      new Date("2026-08-20T10:00:00.000Z"),
    );

    const update = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPDATE reminder_occurrences SET"),
    );
    expect(update?.[0]).not.toContain("lead_minutes = $lead_minutes");
    expect(update?.[0]).not.toContain("next_notification_at = $reminder_start_at");
    expect(update?.[0]).not.toContain("notification_sequence = 0");
    expect(update?.[0]).not.toContain("snoozed_by = NULL");
    expect(decodeYdbValue(update?.[1]?.$watcher_user_ids)).toBe("[10,30]");
  });

  it("persists a concrete lead and restarts the notification schedule", async () => {
    const { repository, session } = occurrenceUpdateRepository(null);

    await repository.updateCurrentForActor(
      "workspace-a",
      "occurrence-a",
      occurrenceUpdateDraft(1_440),
      20,
      new Date("2026-08-20T10:00:00.000Z"),
    );

    const update = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPDATE reminder_occurrences SET"),
    );
    expect(update?.[0]).toContain("lead_minutes = $lead_minutes");
    expect(update?.[0]).toContain("next_notification_at = $reminder_start_at");
    expect(update?.[0]).toContain("notification_sequence = 0");
    expect(update?.[0]).toContain("snoozed_by = NULL");
    expect(decodeYdbValue(update?.[1]?.$lead_minutes)).toBe(1_440);
  });

  it("requires a concrete lead before changing a legacy occurrence deadline", async () => {
    const { repository, session } = occurrenceUpdateRepository(null);

    await expect(repository.updateCurrentForActor(
      "workspace-a",
      "occurrence-a",
      occurrenceUpdateDraft(null, "2026-08-26"),
      20,
      new Date("2026-08-20T10:00:00.000Z"),
    )).rejects.toEqual(expect.objectContaining<Partial<OccurrenceUpdateConflictError>>({
      reason: "legacy_lead_requires_selection",
    }));
    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("UPDATE reminder_occurrences SET"))).toBe(false);
  });
});

describe("OccurrencesRepository message synchronization", () => {
  it("scopes pending Telegram message refreshes by workspace", async () => {
    const { repository, session } = repositoryDouble();

    await expect(repository.listMessageSyncCandidates("workspace-a"))
      .resolves.toEqual([]);

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("message_sync_required = true");
    expect(query).toContain("workspace_id = $workspace_id");
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
  });

  it("uses a unique fencing key so a late finisher cannot release a reclaimed lease", async () => {
    const { repository, session } = syncRepository(occurrenceRow({
      delivery_lock_key: "message-sync:occurrence-a:7:expired",
      delivery_locked_at: "2026-08-13T09:00:00.000Z",
    }));

    const first = await repository.beginMessageSync(
      "workspace-a", "occurrence-a", 7, new Date("2026-08-13T12:00:00.000Z"),
    );
    const second = await repository.beginMessageSync(
      "workspace-a", "occurrence-a", 7, new Date("2026-08-13T12:03:00.000Z"),
    );
    expect(first?.syncKey).toBeTruthy();
    expect(second?.syncKey).toBeTruthy();
    expect(first?.syncKey).not.toBe(second?.syncKey);

    await repository.finishMessageSync(
      "workspace-a", "occurrence-a", 7, first!.syncKey, true,
    );
    const finishCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("message_sync_retire_only = IF($succeeded"),
    );
    expect(finishCall?.[0]).toContain("delivery_lock_key = $sync_key");
    expect(decodeYdbValue(finishCall?.[1]?.$sync_key)).toBe(first?.syncKey);
    expect(first?.syncKey).not.toBe(second?.syncKey);
  });

  it("does not claim a refresh while another Telegram operation owns the lease", async () => {
    const { repository } = syncRepository(occurrenceRow({
      delivery_lock_key: "message-sync:occurrence-a:7:active",
      delivery_locked_at: "2026-08-13T11:59:30.000Z",
    }));

    await expect(repository.beginMessageSync(
      "workspace-a", "occurrence-a", 7, new Date("2026-08-13T12:00:00.000Z"),
    )).resolves.toBeNull();
  });

  it("does not let a delayed action claim a newer message revision", async () => {
    const { repository, session } = syncRepository(occurrenceRow({ state_revision: 8 }));

    await expect(repository.beginMessageSync(
      "workspace-a", "occurrence-a", 7, new Date("2026-08-13T12:00:00.000Z"),
    )).resolves.toBeNull();
    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("delivery_lock_key = $sync_key"))).toBe(false);
  });
});

describe("OccurrencesRepository history", () => {
  it("keeps history workspace-scoped and preserves private visibility", async () => {
    const session = {
      executeQuery: vi.fn().mockResolvedValue({ resultSets: [resultSet([])] }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new OccurrencesRepository("", "", runSession);

    await expect(repository.listHistoryForActor("workspace-a", 20, 40))
      .resolves.toEqual([]);

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("FROM reminder_occurrences AS occurrence");
    expect(query).not.toContain("VIEW idx_occurrences_plan");
    expect(query).toContain("occurrence.status IN ('completed', 'cancelled')");
    expect(query).toContain("occurrence.visibility = 'group'");
    expect(query).toContain("reminder.creator_user_id = $actor_user_id");
    expect(query).toContain("occurrence.responsible_user_id = $actor_user_id");
    expect(query).toContain(") AS history");
    expect(query).toContain("occurrence.completed_at");
    expect(query).toContain("occurrence.cancelled_at");
    expect(query).toContain("occurrence.updated_at");
    expect(query).toContain(
      "ORDER BY history.workspace_id, history.history_action_at DESC",
    );
    expect(query).toContain("history.occurrence_id DESC");
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(params?.$actor_user_id)).toBe(20);
    expect(decodeYdbValue(params?.$limit)).toBe(40);
  });
});

describe("OccurrencesRepository.listActionableForActor", () => {
  it("scopes the attention feed by workspace, actor, and visibility", async () => {
    const { repository, session } = repositoryDouble();
    await repository.listActionableForActor("workspace-a", 20);

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("occurrence.workspace_id = $workspace_id");
    expect(query).toContain("occurrence.visibility = 'group'");
    expect(query).toContain("reminder.status = 'active'");
    expect(query).toContain("reminder.creator_user_id = $actor_user_id");
    expect(query).toContain("ORDER BY due_at, occurrence_id");
    expect(query).not.toContain("ORDER BY occurrence.due_at");
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(params?.$actor_user_id)).toBe(20);
  });
});
