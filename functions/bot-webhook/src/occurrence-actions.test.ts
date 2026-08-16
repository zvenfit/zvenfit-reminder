import { describe, expect, it, vi } from "vitest";
import type {
  AppConfig,
  ReminderDefinition,
  ReminderOccurrence,
  WorkspaceMember,
} from "@zvenfit-reminder/shared";
import {
  OccurrenceActionForbiddenError,
  executeOccurrenceAction,
  type OccurrenceActionDependencies,
} from "./occurrence-actions.js";

const config: AppConfig = {
  ydbEndpoint: "grpc://unused",
  ydbDatabase: "/unused",
  botToken: "token",
  webhookSecret: "secret",
  defaultTimezone: "Europe/Moscow",
  miniAppUrl: "",
};

function occurrence(
  overrides: Partial<ReminderOccurrence> = {},
): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
    stateRevision: 1,
    kind: "task",
    visibility: "group",
    assignment: { mode: "person", responsibleUserId: 20 },
    status: "pending",
    ...overrides,
  } as ReminderOccurrence;
}

const reminder = {
  workspaceId: "workspace-a",
  reminderId: "reminder-a",
  creatorUserId: 10,
  status: "active",
} as ReminderDefinition;

function member(userId = 20, role: WorkspaceMember["role"] = "member") {
  return {
    workspaceId: "workspace-a",
    userId,
    role,
    status: "active",
  } as WorkspaceMember;
}

function dependencies(item = occurrence(), actor = member()) {
  let current = item;
  return {
    workspaces: {
      getByTelegramChatId: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        telegramChatId: -100123,
        status: "active",
      }),
      getById: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        telegramChatId: -100123,
        status: "active",
      }),
    },
    members: { getByUserId: vi.fn().mockResolvedValue(actor) },
    reminders: { getById: vi.fn().mockResolvedValue(reminder) },
    occurrences: {
      getById: vi.fn().mockResolvedValue(item),
      findByIdForActor: vi.fn().mockResolvedValue(item),
      beginMessageSync: vi.fn(async () => current.latestMessageId == null
        ? null
        : {
            occurrence: current,
            stateRevision: 2,
            retireOnly: false,
            syncKey: "action-sync-2",
          }),
      finishMessageSync: vi.fn().mockResolvedValue(undefined),
    },
    actions: {
      complete: vi.fn(async (
        _workspaceId: string, _occurrenceId: string, actorUserId: number, now: Date,
      ) => (current = {
        ...item,
        stateRevision: item.stateRevision + 1,
        status: "completed",
        notificationState: "stopped",
        completedBy: actorUserId,
        completedByDisplayName: "Иван",
        completedAt: now,
        undoUntil: new Date(now.getTime() + 10 * 60 * 1_000),
      })),
      snooze: vi.fn(async (
        _workspaceId: string,
        _occurrenceId: string,
        actorUserId: number,
        snoozeUntil: Date,
        now: Date,
      ) => (current = {
        ...item,
        stateRevision: item.stateRevision + 1,
        snoozedBy: actorUserId,
        snoozedAt: now,
        snoozeUntil,
        nextNotificationAt: snoozeUntil,
      })),
      undoCompletion: vi.fn(async () => (current = {
        ...item,
        stateRevision: item.stateRevision + 1,
        status: "pending",
        completedBy: null,
        completedByDisplayName: null,
        completedAt: null,
        undoUntil: null,
      })),
    },
    telegram: { edit: vi.fn().mockResolvedValue(undefined) },
  } as unknown as OccurrenceActionDependencies;
}

describe("executeOccurrenceAction", () => {
  it("completes a group occurrence with workspace and actor scoping", async () => {
    const deps = dependencies();
    const now = new Date("2026-08-13T12:00:00.000Z");

    const result = await executeOccurrenceAction(
      config,
      {
        source: "telegram",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        chatId: -100123,
        chatType: "group",
        now,
      },
      deps,
    );

    expect(result.occurrence.status).toBe("completed");
    expect(deps.occurrences.getById).toHaveBeenCalledWith(
      "workspace-a",
      "occurrence-a",
    );
    expect(deps.actions.complete).toHaveBeenCalledWith(
      "workspace-a",
      "occurrence-a",
      20,
      now,
    );
  });

  it("snoozes for one hour and leaves quiet-hour adjustment to the repository", async () => {
    const deps = dependencies();
    const now = new Date("2026-08-13T12:00:00.000Z");

    await executeOccurrenceAction(
      config,
      {
        source: "telegram",
        action: "snooze",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        chatId: -100123,
        chatType: "group",
        now,
      },
      deps,
    );

    expect(deps.actions.snooze).toHaveBeenCalledWith(
      "workspace-a",
      "occurrence-a",
      20,
      new Date("2026-08-13T13:00:00.000Z"),
      now,
    );
  });

  it("does not expose a private occurrence to a workspace owner", async () => {
    const deps = dependencies(
      occurrence({ visibility: "private" }),
      member(30, "owner"),
    );

    await expect(
      executeOccurrenceAction(
        config,
        {
          source: "telegram",
          action: "done",
          occurrenceId: "occurrence-a",
          actorUserId: 30,
          chatId: 30,
          chatType: "private",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(OccurrenceActionForbiddenError);
    expect(deps.actions.complete).not.toHaveBeenCalled();
  });

  it("rejects a group callback replayed from another chat", async () => {
    const deps = dependencies();

    await expect(
      executeOccurrenceAction(
        config,
        {
          source: "telegram",
          action: "done",
          occurrenceId: "occurrence-a",
          actorUserId: 20,
          chatId: -100999,
          chatType: "group",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(OccurrenceActionForbiddenError);
    expect(deps.members.getByUserId).not.toHaveBeenCalled();
  });

  it("uses the same policy for Mini App actions without a Telegram message location", async () => {
    const deps = dependencies();

    await executeOccurrenceAction(
      config,
      {
        source: "mini-app",
        workspaceId: "workspace-a",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        actorDisplayName: "Иван",
        now: new Date("2026-08-13T12:00:00.000Z"),
      },
      deps,
    );

    expect(deps.actions.complete).toHaveBeenCalledWith(
      "workspace-a",
      "occurrence-a",
      20,
      expect.any(Date),
    );
  });

  it("best-effort updates the live Telegram message after a Mini App action", async () => {
    const item = occurrence({
      title: "Передать показания",
      dueAt: new Date("2026-08-25T15:00:00.000Z"),
      allDay: false,
      timezone: "Europe/Moscow",
      description: null,
      amountMinor: null,
      currency: null,
      latestMessageChatId: -100123,
      latestMessageId: 777,
    });
    const deps = dependencies(item);

    await executeOccurrenceAction(
      config,
      {
        source: "mini-app",
        workspaceId: "workspace-a",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        actorDisplayName: "Иван",
        now: new Date("2026-08-13T12:00:00.000Z"),
      },
      deps,
    );

    expect(deps.telegram?.edit).toHaveBeenCalledWith(
      "token",
      -100123,
      777,
      expect.stringContaining("Выполнено"),
      expect.anything(),
    );
    expect((deps.telegram?.edit as ReturnType<typeof vi.fn>).mock.calls[0]?.[3])
      .toContain("Когда: 13 августа в 15:00");
    expect(deps.occurrences.beginMessageSync).toHaveBeenCalledWith(
      "workspace-a", "occurrence-a", 2, expect.any(Date),
    );
    expect(deps.occurrences.finishMessageSync).toHaveBeenCalledWith(
      "workspace-a", "occurrence-a", 2, "action-sync-2", true,
    );
  });

  it("never writes private content into a live message from the previous audience", async () => {
    const item = occurrence({
      visibility: "private",
      assignment: { mode: "person", responsibleUserId: 20 },
      title: "Личное напоминание",
      latestMessageChatId: -100123,
      latestMessageId: 777,
    });
    const deps = dependencies(item);

    await executeOccurrenceAction(
      config,
      {
        source: "mini-app",
        workspaceId: "workspace-a",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        actorDisplayName: "Иван",
      },
      deps,
    );

    expect(deps.telegram?.edit).not.toHaveBeenCalled();
    expect(deps.occurrences.finishMessageSync).toHaveBeenCalledWith(
      "workspace-a", "occurrence-a", 2, "action-sync-2", false,
    );
  });

  it("reconciles the latest message when a callback arrives from the previous one", async () => {
    const item = occurrence({
      title: "Передать показания",
      dueAt: new Date("2026-08-25T15:00:00.000Z"),
      allDay: false,
      timezone: "Europe/Moscow",
      description: null,
      amountMinor: null,
      currency: null,
      latestMessageChatId: -100123,
      latestMessageId: 777,
    });
    const deps = dependencies(item);

    await executeOccurrenceAction(
      config,
      {
        source: "telegram",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
        actorDisplayName: "Иван",
        chatId: -100123,
        chatType: "group",
        messageId: 55,
      },
      deps,
    );

    expect(deps.telegram?.edit).toHaveBeenCalledWith(
      "token",
      -100123,
      777,
      expect.stringContaining("✅ Выполнено"),
      expect.anything(),
    );
  });
});
