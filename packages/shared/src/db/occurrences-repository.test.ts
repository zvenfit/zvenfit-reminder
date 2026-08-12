import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { OccurrencesRepository } from "./occurrences-repository.js";
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
  status: "active",
  version: 1,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

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
        return { resultSets: [resultSet([runtimeRow(state)]), resultSet([reminderRow])] };
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
      dueLocalDate: "2026-08-25",
      status: "pending",
      notificationState: "waiting",
      notificationSequence: 0,
      timezone: "Europe/Moscow",
    });

    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("INSERT INTO reminder_occurrence_slots"),
    );
    expect(writeCall?.[0]).toContain("INSERT INTO reminder_occurrences");
    expect(writeCall?.[0]).toContain("state = 'blocked'");
    expect(decodeYdbValue(writeCall?.[1]?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(writeCall?.[1]?.$occurrence_id)).toBe("occurrence-a");
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

describe("OccurrencesRepository.listActionableForActor", () => {
  it("scopes the attention feed by workspace, actor, and visibility", async () => {
    const { repository, session } = repositoryDouble();
    await repository.listActionableForActor("workspace-a", 20);

    const [query, params] = session.executeQuery.mock.calls[0] ?? [];
    expect(query).toContain("occurrence.workspace_id = $workspace_id");
    expect(query).toContain("occurrence.visibility = 'group'");
    expect(query).toContain("reminder.creator_user_id = $actor_user_id");
    expect(decodeYdbValue(params?.$workspace_id)).toBe("workspace-a");
    expect(decodeYdbValue(params?.$actor_user_id)).toBe(20);
  });
});
