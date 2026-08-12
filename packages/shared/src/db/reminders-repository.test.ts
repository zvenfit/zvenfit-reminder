import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import { reminderDraftSchema } from "../reminder-domain.js";
import type { SessionRunner } from "./client.js";
import {
  InactiveWorkspaceMemberError,
  RemindersRepository,
} from "./reminders-repository.js";
import { decodeYdbValue } from "./ydb-utils.js";

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

function repositoryDouble(activeUserIds: number[]) {
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
            resultSet(activeUserIds.map((userId) => ({ user_id: userId, status: "active" }))),
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
});
