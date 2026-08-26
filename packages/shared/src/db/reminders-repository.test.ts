import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import { reminderDraftSchema } from "../reminder-domain.js";
import type { SessionRunner } from "./client.js";
import {
  InactiveWorkspaceMemberError,
  PrivateChatUnavailableError,
  ReminderCreateForbiddenError,
  ReminderLifecycleConflictError,
  ReminderReassignmentForbiddenError,
  ReminderUpdateForbiddenError,
  ReminderUpdateConflictError,
  RemindersRepository,
} from "./reminders-repository.js";
import { decodeYdbValue, parseYdbTimestamp } from "./ydb-utils.js";

function resultSet(rows: Array<Record<string, string | number | boolean | null>>) {
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

function repositoryDouble(
  activeUserIds: number[],
  privateChatUserIds: number[] = activeUserIds,
  creatorRole: "owner" | "organizer" | "member" = "organizer",
) {
  const session = {
    beginTransaction: vi.fn().mockResolvedValue({ id: "tx-reminder" }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(async (query: string) => {
      if (query.includes("SELECT status, quiet_hours_start")) {
        return {
          resultSets: [
            resultSet([
              {
                status: "active",
                quiet_hours_start: "22:00",
                quiet_hours_end: "08:00",
                default_all_day_reminder_time: "09:00",
              },
            ]),
            resultSet(activeUserIds.map((userId) => ({
              user_id: userId,
              role: userId === 10 ? creatorRole : "member",
              status: "active",
            }))),
            resultSet(
              activeUserIds.map((userId) => ({
                user_id: userId,
                private_chat_available: privateChatUserIds.includes(userId),
              })),
            ),
          ],
        };
      }
      return { resultSets: [] };
    }),
  };
  const runSession: SessionRunner = async (operation) =>
    operation(session as unknown as TableSession);
  return { repository: new RemindersRepository("", "", runSession), session };
}

const draft = reminderDraftSchema.parse({
  title: "Передать показания",
  assignment: { mode: "person", responsibleUserId: 20 },
  watcherUserIds: [30],
  schedule: {
    version: 1,
    frequency: "monthly",
    startDate: "2026-08-01",
    timing: { kind: "timed", timeLocal: "18:00" },
    interval: 1,
    day: { type: "dayOfMonth", value: 25, overflow: "lastDay" },
  },
  timezone: "Europe/Moscow",
});

describe("RemindersRepository", () => {
  it("validates members and atomically inserts a reminder, runtime, and watchers", async () => {
    const { repository, session } = repositoryDouble([10, 20, 30]);

    const reminder = await repository.create("workspace-a", 10, draft, {
      reminderId: "reminder-a",
      now: new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(reminder.watcherUserIds).toEqual([10, 30]);
    expect(session.commitTransaction).toHaveBeenCalledWith({ txId: "tx-reminder" });

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO reminders"),
    );
    expect(writeCall?.[0]).toContain("INSERT INTO reminder_runtime");
    expect(writeCall?.[0]).toContain("next_reminder_start_at");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$reminder_id)).toBe("reminder-a");
    expect(decodeYdbValue(writeCall?.[1]?.$kind)).toBe("task");

    const watcherCalls = session.executeQuery.mock.calls.filter(([query]) =>
      query.includes("INSERT INTO reminder_watchers"),
    );
    expect(watcherCalls).toHaveLength(2);
    expect(
      watcherCalls.map((call) => decodeYdbValue(call[1]?.$user_id)).sort(),
    ).toEqual([10, 30]);
    expect(
      session.executeQuery.mock.calls.every((call) =>
        call[2] == null || (call[2] as { txId?: string }).txId === "tx-reminder",
      ),
    ).toBe(true);
  });

  it("rolls back before writes when any participant is not active", async () => {
    const { repository, session } = repositoryDouble([10, 20]);

    await expect(
      repository.create("workspace-a", 10, draft, {
        now: new Date("2026-08-13T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject<Partial<InactiveWorkspaceMemberError>>({ userIds: [30] });

    expect(
      session.executeQuery.mock.calls.some(([query]) => query.includes("INSERT INTO reminders")),
    ).toBe(false);
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "tx-reminder" });
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("rechecks create authorization inside the transaction", async () => {
    const { repository, session } = repositoryDouble([10, 20, 30], [10, 20, 30], "member");

    await expect(
      repository.create("workspace-a", 10, draft, {
        now: new Date("2026-08-13T10:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ReminderCreateForbiddenError);

    expect(
      session.executeQuery.mock.calls.some(([query]) => query.includes("INSERT INTO reminders")),
    ).toBe(false);
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "tx-reminder" });
  });

  it("requires workspace scope for reads", async () => {
    const { repository, session } = repositoryDouble([]);
    await repository.getById("workspace-a", "reminder-a");

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain(
      "WHERE workspace_id = $workspace_id AND reminder_id = $reminder_id",
    );
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(params?.$reminder_id)).toBe("reminder-a");
  });

  it("does not create a private reminder before the responsible user starts the bot", async () => {
    const { repository, session } = repositoryDouble([10, 20], [10]);
    const privateDraft = reminderDraftSchema.parse({
      ...draft,
      visibility: "private",
      watcherUserIds: [],
    });

    await expect(
      repository.create("workspace-a", 10, privateDraft, {
        now: new Date("2026-08-13T10:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(PrivateChatUnavailableError);
    expect(
      session.executeQuery.mock.calls.some(([query]) => query.includes("INSERT INTO reminders")),
    ).toBe(false);
  });

  it("filters list reads by workspace, visibility, and actor", async () => {
    const { repository, session } = repositoryDouble([]);
    await repository.listForActor("workspace-a", 20);

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("visibility = 'group'");
    expect(query).toContain("responsible_user_id = $actor_user_id");
    expect(query).toContain("ORDER BY reminder_id, user_id");
    expect(query).not.toContain("ORDER BY watcher.reminder_id");
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(params?.$actor_user_id)).toBe(20);
  });

  it("reassigns a paused reminder and resumes its pending occurrence", async () => {
    const reminderRow = {
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
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: "Europe/Moscow",
      lead_minutes: 0,
      repeat_interval_minutes: 360,
      ignore_quiet_hours: false,
      escalation_enabled: false,
      escalation_delay_minutes: null,
      escalation_repeat_minutes: null,
      status: "paused",
      version: 1,
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-reassign" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("SELECT role, status FROM workspace_members")) {
          return {
            resultSets: [
              resultSet([{ role: "organizer", status: "active" }]),
              resultSet([{ status: "active" }]),
              resultSet([reminderRow]),
              resultSet([{ private_chat_available: false }]),
              resultSet([{
                occurrence_id: "occurrence-a",
                delivery_lock_key: null,
                delivery_locked_at: null,
              }]),
              resultSet([{ user_id: 10 }, { user_id: 30 }]),
            ],
          };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [resultSet([{ ...reminderRow, status: "active", responsible_user_id: 30 }]), resultSet([])] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    const reminder = await repository.reassign(
      "workspace-a",
      "reminder-a",
      30,
      10,
      new Date("2026-08-14T00:00:00.000Z"),
    );

    expect(reminder?.assignment).toEqual({ mode: "person", responsibleUserId: 30 });
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPDATE reminders SET"));
    expect(write?.[0]).toContain("notification_state = $waiting_notification_state");
    expect(write?.[0]).toContain(
      "IF($activate_reminder, $ready_runtime_state, $paused_runtime_state)",
    );
    expect(decodeYdbValue(write?.[1]?.$activate_reminder)).toBe(true);
    expect(decodeYdbValue(write?.[1]?.$watcher_user_ids)).toBe("[10]");
    expect(decodeYdbValue(write?.[1]?.$retire_old_message)).toBe(false);
    expect(decodeYdbValue(write?.[1]?.$person_assignment)).toBe("person");
    expect(decodeYdbValue(write?.[1]?.$active_status)).toBe("active");
    expect(decodeYdbValue(write?.[1]?.$waiting_notification_state)).toBe("waiting");
    expect(decodeYdbValue(write?.[1]?.$revision_increment)).toBe(1);
    expect(write?.[0]).toContain("'reminder.reassigned'");
  });

  it("restores the active creator as watcher after assigning away from them", async () => {
    let latestResponsibleUserId = 20;
    const reminderRow = {
      workspace_id: "workspace-a",
      reminder_id: "reminder-a",
      title: "Передать показания",
      description: null,
      action_url: null,
      amount_minor: null,
      currency: null,
      visibility: "group",
      creator_user_id: 10,
      creator_member_status: "active",
      assignment_mode: "person",
      responsible_user_id: 20,
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: "Europe/Moscow",
      lead_minutes: 0,
      repeat_interval_minutes: 360,
      ignore_quiet_hours: false,
      escalation_enabled: false,
      escalation_delay_minutes: null,
      escalation_repeat_minutes: null,
      status: "active",
      version: 1,
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-reassign-creator" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string, params?: Record<string, unknown>) => {
        if (query.includes("SELECT role, status FROM workspace_members")) {
          latestResponsibleUserId = Number(decodeYdbValue(params?.$responsible_user_id));
          return { resultSets: [
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([{ status: "active" }]),
            resultSet([{ ...reminderRow, responsible_user_id: latestResponsibleUserId }]),
            resultSet([{ private_chat_available: true }]),
            resultSet([]),
            resultSet([]),
          ] };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [
            resultSet([{ ...reminderRow, responsible_user_id: latestResponsibleUserId }]),
            resultSet(latestResponsibleUserId === 10 ? [] : [{ user_id: 10 }]),
          ] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await repository.reassign("workspace-a", "reminder-a", 10, 40);
    await repository.reassign("workspace-a", "reminder-a", 30, 40);

    const writes = session.executeQuery.mock.calls.filter(([query]) =>
      query.includes("UPDATE reminders SET"));
    expect(decodeYdbValue(writes[0]?.[1]?.$watcher_user_ids)).toBe("[]");
    expect(decodeYdbValue(writes[1]?.[1]?.$watcher_user_ids)).toBe("[10]");
    const creatorInsert = session.executeQuery.mock.calls.filter(([query]) =>
      query.includes("INSERT INTO reminder_watchers"));
    expect(creatorInsert).toHaveLength(1);
    expect(decodeYdbValue(creatorInsert[0]?.[1]?.$user_id)).toBe(10);
  });

  it("does not let an organizer take over somebody else's private reminder", async () => {
    const privateReminderRow = {
      workspace_id: "workspace-a",
      reminder_id: "private-a",
      visibility: "private",
      creator_user_id: 10,
      responsible_user_id: 20,
      status: "paused",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-private" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT role, status FROM workspace_members")
          ? [
              resultSet([{ role: "organizer", status: "active" }]),
              resultSet([{ status: "active" }]),
              resultSet([privateReminderRow]),
              resultSet([{ private_chat_available: true }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.reassign(
      "workspace-a",
      "private-a",
      30,
      40,
    )).rejects.toBeInstanceOf(ReminderReassignmentForbiddenError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("does not let a regular private assignee transfer the reminder to another member", async () => {
    const privateReminderRow = {
      workspace_id: "workspace-a",
      reminder_id: "private-a",
      visibility: "private",
      creator_user_id: 10,
      responsible_user_id: 20,
      status: "paused",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-private-transfer" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT role, status FROM workspace_members")
          ? [
              resultSet([{ role: "member", status: "active" }]),
              resultSet([{ status: "active" }]),
              resultSet([privateReminderRow]),
              resultSet([{ private_chat_available: true }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.reassign(
      "workspace-a",
      "private-a",
      30,
      20,
    )).rejects.toBeInstanceOf(ReminderReassignmentForbiddenError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("retires the previous private audience when the creator reassigns a live reminder", async () => {
    const privateReminderRow = {
      workspace_id: "workspace-a",
      reminder_id: "private-a",
      title: "Личное напоминание",
      description: null,
      action_url: null,
      amount_minor: null,
      currency: null,
      visibility: "private",
      creator_user_id: 10,
      creator_member_status: "active",
      assignment_mode: "person",
      responsible_user_id: 20,
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: "Europe/Moscow",
      lead_minutes: 0,
      repeat_interval_minutes: 360,
      ignore_quiet_hours: false,
      escalation_enabled: false,
      escalation_delay_minutes: null,
      escalation_repeat_minutes: null,
      status: "paused",
      version: 1,
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-private-migrate" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("SELECT role, status FROM workspace_members")) {
          return { resultSets: [
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([{ status: "active" }]),
            resultSet([privateReminderRow]),
            resultSet([{ private_chat_available: true }]),
            resultSet([{
              occurrence_id: "occurrence-a",
              latest_message_id: 777,
              delivery_lock_key: null,
              delivery_locked_at: null,
            }]),
            resultSet([]),
          ] };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [
            resultSet([{ ...privateReminderRow, status: "active", responsible_user_id: 30 }]),
            resultSet([]),
          ] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await repository.reassign("workspace-a", "private-a", 30, 10);

    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("'reminder.reassigned'"));
    expect(decodeYdbValue(write?.[1]?.$retire_old_message)).toBe(true);
    expect(write?.[0]).toContain("message_sync_retire_only = IF");
    expect(write?.[0]).toContain("next_notification_at = $now");
  });

  it("never reactivates an archived reminder through reassignment", async () => {
    const archivedReminderRow = {
      workspace_id: "workspace-a",
      reminder_id: "archived-a",
      visibility: "group",
      creator_user_id: 10,
      responsible_user_id: 20,
      status: "archived",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-archived" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT role, status FROM workspace_members")
          ? [
              resultSet([{ role: "owner", status: "active" }]),
              resultSet([{ status: "active" }]),
              resultSet([archivedReminderRow]),
              resultSet([{ private_chat_available: true }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.reassign(
      "workspace-a",
      "archived-a",
      30,
      10,
    )).rejects.toBeInstanceOf(ReminderReassignmentForbiddenError);
  });

  it("preserves an amountless payment kind for legacy updates", async () => {
    const existing = {
      workspace_id: "workspace-a",
      reminder_id: "reminder-a",
      kind: "payment",
      visibility: "group",
      creator_user_id: 10,
      responsible_user_id: 20,
      status: "active",
      version: 2,
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: draft.timezone,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-update" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("SELECT status, quiet_hours_start")) {
          return { resultSets: [
            resultSet([{ status: "active", quiet_hours_start: "22:00", quiet_hours_end: "08:00", default_all_day_reminder_time: "09:00" }]),
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([existing]),
            resultSet([{
              current_occurrence_id: "occurrence-a",
              current_due_at: "2026-08-25T15:00:00.000Z",
              delivery_lock_key: null,
              delivery_locked_at: null,
            }]),
          ] };
        }
        if (query.includes("SELECT user_id, status FROM workspace_members")) {
          return { resultSets: [
            resultSet([10, 20, 30].map((userId) => ({ user_id: userId, status: "active" }))),
            resultSet([10, 20, 30].map((userId) => ({ user_id: userId, private_chat_available: true }))),
          ] };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [resultSet([]), resultSet([])] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await repository.update(
      "workspace-a",
      "reminder-a",
      { ...draft, kind: undefined, title: "Новые показания" },
      10,
      new Date("2026-08-14T00:00:00.000Z"),
    );

    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("'reminder.updated'"));
    expect(write?.[0]).toContain("UPDATE reminder_occurrences");
    expect(write?.[0]).toContain("kind = $kind");
    expect(write?.[0]).toContain("lead_minutes = $lead_minutes");
    expect(write?.[0]).toContain("watcher_user_ids = $watcher_user_ids");
    expect(write?.[0]).toContain("notification_state = 'waiting'");
    expect(write?.[0]).toContain("$now");
    expect(write?.[0]).toContain("current_occurrence_id IS NULL");
    expect(decodeYdbValue(write?.[1]?.$version)).toBe(3);
    expect(decodeYdbValue(write?.[1]?.$kind)).toBe("payment");
    expect(decodeYdbValue(write?.[1]?.$schedule_changed)).toBe(false);
    expect(decodeYdbValue(write?.[1]?.$revision_increment)).toBe(1);
    expect(decodeYdbValue(write?.[1]?.$overdue_status)).toBe("overdue");
    expect(decodeYdbValue(write?.[1]?.$pending_status)).toBe("pending");
    expect(session.executeQuery.mock.calls.some(([query]) =>
      query.includes("DELETE FROM reminder_occurrence_slots"))).toBe(false);
    const payload = JSON.parse(String(decodeYdbValue(write?.[1]?.$payload)));
    expect(payload.currentOccurrenceUpdated).toBe(true);
  });

  it("moves the current occurrence slot when its schedule changes", async () => {
    const existing = {
      workspace_id: "workspace-a",
      reminder_id: "reminder-a",
      visibility: "group",
      creator_user_id: 10,
      assignment_mode: "person",
      responsible_user_id: 20,
      status: "active",
      version: 2,
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: draft.timezone,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-update-schedule" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("SELECT status, quiet_hours_start")) {
          return { resultSets: [
            resultSet([{ status: "active", quiet_hours_start: "22:00", quiet_hours_end: "08:00", default_all_day_reminder_time: "09:00" }]),
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([existing]),
            resultSet([{
              current_occurrence_id: "occurrence-a",
              current_due_at: "2026-08-25T15:00:00.000Z",
              current_status: "pending",
              current_latest_message_id: 55,
              delivery_lock_key: null,
              delivery_locked_at: null,
            }]),
          ] };
        }
        if (query.includes("SELECT user_id, status FROM workspace_members")) {
          return { resultSets: [
            resultSet([10, 20, 30].map((userId) => ({ user_id: userId, status: "active" }))),
            resultSet([10, 20, 30].map((userId) => ({ user_id: userId, private_chat_available: true }))),
          ] };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [resultSet([]), resultSet([])] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);
    const movedDraft = reminderDraftSchema.parse({
      ...draft,
      visibility: "private",
      watcherUserIds: [],
      schedule: {
        version: 1,
        frequency: "monthly",
        startDate: "2026-08-01",
        timing: { kind: "timed", timeLocal: "18:00" },
        interval: 1,
        day: { type: "dayOfMonth", value: 20, overflow: "lastDay" },
      },
    });

    await repository.update(
      "workspace-a",
      "reminder-a",
      movedDraft,
      10,
      new Date("2026-08-14T00:00:00.000Z"),
    );

    const slotMove = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("DELETE FROM reminder_occurrence_slots"));
    expect(slotMove?.[0]).toContain("INSERT INTO reminder_occurrence_slots");
    expect(parseYdbTimestamp(decodeYdbValue(slotMove?.[1]?.$new_due_at))?.toISOString())
      .toBe("2026-08-20T15:00:00.000Z");
    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("'reminder.updated'"));
    expect(decodeYdbValue(write?.[1]?.$schedule_changed)).toBe(true);
    expect(decodeYdbValue(write?.[1]?.$migrate_live_message)).toBe(true);
    expect(write?.[0]).toContain("message_sync_retire_only = IF");
    expect(write?.[0]).toContain("$migrate_live_message");
  });

  it("rejects editing while a completion can still be undone", async () => {
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-update-completed" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT status, quiet_hours_start")
          ? [
              resultSet([{ status: "active", quiet_hours_start: "22:00", quiet_hours_end: "08:00", default_all_day_reminder_time: "09:00" }]),
              resultSet([{ role: "organizer", status: "active" }]),
              resultSet([{
                workspace_id: "workspace-a",
                reminder_id: "reminder-a",
                visibility: "group",
                creator_user_id: 10,
                status: "active",
              }]),
              resultSet([{
                current_occurrence_id: "occurrence-a",
                current_due_at: "2026-08-25T15:00:00.000Z",
                current_status: "completed",
                delivery_lock_key: null,
                delivery_locked_at: null,
              }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.update(
      "workspace-a",
      "reminder-a",
      draft,
      10,
    )).rejects.toBeInstanceOf(ReminderUpdateConflictError);
  });

  it("does not let a regular member publish a private reminder to the group by editing", async () => {
    const existing = {
      workspace_id: "workspace-a",
      reminder_id: "private-a",
      visibility: "private",
      creator_user_id: 20,
      responsible_user_id: 20,
      status: "active",
      version: 1,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-update-forbidden" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT status, quiet_hours_start")
          ? [
              resultSet([{ status: "active", quiet_hours_start: "22:00", quiet_hours_end: "08:00", default_all_day_reminder_time: "09:00" }]),
              resultSet([{ role: "member", status: "active" }]),
              resultSet([existing]),
              resultSet([{ current_occurrence_id: null }]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.update(
      "workspace-a",
      "private-a",
      { ...draft, watcherUserIds: [] },
      20,
    )).rejects.toBeInstanceOf(ReminderUpdateForbiddenError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("resumes from the next future schedule after a paused deadline was missed", async () => {
    const existing = {
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
      schedule_spec: JSON.stringify(draft.schedule),
      timezone: "Europe/Moscow",
      lead_minutes: 0,
      repeat_interval_minutes: 360,
      ignore_quiet_hours: false,
      escalation_enabled: false,
      escalation_delay_minutes: null,
      escalation_repeat_minutes: null,
      status: "paused",
      version: 2,
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-13T10:00:00.000Z",
    };
    const currentOccurrence = {
      occurrence_id: "occurrence-a",
      status: "overdue",
      due_at: "2026-08-25T15:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-resume" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("SELECT occurrence.* FROM reminder_occurrences")) {
          return { resultSets: [
            resultSet([{ role: "organizer", status: "active" }]),
            resultSet([existing]),
            resultSet([currentOccurrence]),
            resultSet([{ status: "active" }]),
            resultSet([{ quiet_hours_start: "22:00", quiet_hours_end: "08:00", default_all_day_reminder_time: "09:00" }]),
          ] };
        }
        if (query.includes("SELECT * FROM reminders")) {
          return { resultSets: [resultSet([{ ...existing, status: "active" }]), resultSet([])] };
        }
        return { resultSets: [] };
      }),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await repository.changeLifecycle(
      "workspace-a",
      "reminder-a",
      "resume",
      10,
      new Date("2026-09-01T10:00:00.000Z"),
    );

    const write = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("DECLARE $restore_current AS Bool"));
    expect(decodeYdbValue(write?.[1]?.$restore_current)).toBe(false);
    expect(decodeYdbValue(write?.[1]?.$current_occurrence_id)).toBe("occurrence-a");
    expect(write?.[0]).toContain("$missed_while_paused_reason");
    expect(decodeYdbValue(write?.[1]?.$missed_while_paused_reason))
      .toBe("missed_while_paused");
    expect(decodeYdbValue(write?.[1]?.$ready_runtime_state)).toBe("ready");
    expect(decodeYdbValue(write?.[1]?.$revision_increment)).toBe(1);
  });

  it("does not resume a reminder assigned to a removed member", async () => {
    const existing = {
      workspace_id: "workspace-a",
      reminder_id: "reminder-a",
      visibility: "group",
      creator_user_id: 10,
      assignment_mode: "person",
      responsible_user_id: 20,
      status: "paused",
      version: 1,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-resume-removed" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT occurrence.* FROM reminder_occurrences")
          ? [
              resultSet([{ role: "organizer", status: "active" }]),
              resultSet([existing]),
              resultSet([]),
              resultSet([{ status: "removed" }]),
              resultSet([]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.changeLifecycle(
      "workspace-a",
      "reminder-a",
      "resume",
      10,
    )).rejects.toBeInstanceOf(ReminderLifecycleConflictError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  it("does not pause a series while its completion can still be undone", async () => {
    const existing = {
      workspace_id: "workspace-a",
      reminder_id: "reminder-a",
      visibility: "group",
      creator_user_id: 10,
      assignment_mode: "person",
      responsible_user_id: 20,
      status: "active",
      version: 1,
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-pause-completed" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT occurrence.* FROM reminder_occurrences")
          ? [
              resultSet([{ role: "organizer", status: "active" }]),
              resultSet([existing]),
              resultSet([{
                occurrence_id: "occurrence-a",
                status: "completed",
                due_at: "2026-08-25T15:00:00.000Z",
                undo_until: "2026-08-14T00:10:00.000Z",
              }]),
              resultSet([{ status: "active" }]),
              resultSet([]),
            ]
          : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new RemindersRepository("", "", runSession);

    await expect(repository.changeLifecycle(
      "workspace-a",
      "reminder-a",
      "pause",
      10,
      new Date("2026-08-14T00:05:00.000Z"),
    )).rejects.toBeInstanceOf(ReminderLifecycleConflictError);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });
});
