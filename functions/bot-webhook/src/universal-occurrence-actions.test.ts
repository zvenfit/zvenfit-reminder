import { describe, expect, it, vi } from "vitest";
import type {
  AppConfig,
  ReminderDefinition,
  ReminderOccurrence,
  WorkspaceMember,
} from "@zvenfit-reminder/shared";
import {
  UniversalOccurrenceActionForbiddenError,
  executeUniversalOccurrenceAction,
  type UniversalOccurrenceActionDependencies,
} from "./universal-occurrence-actions.js";

const config: AppConfig = {
  ydbEndpoint: "grpc://unused",
  ydbDatabase: "/unused",
  botToken: "token",
  webhookSecret: "secret",
  allowedChatId: -100123,
  defaultTimezone: "Europe/Moscow",
  miniAppUrl: "",
  adminUserIds: [],
  universalRemindersEnabled: true,
};

function occurrence(
  overrides: Partial<ReminderOccurrence> = {},
): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    occurrenceId: "occurrence-a",
    reminderId: "reminder-a",
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
  return {
    workspaces: {
      getByTelegramChatId: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        status: "active",
      }),
    },
    members: { getByUserId: vi.fn().mockResolvedValue(actor) },
    reminders: { getById: vi.fn().mockResolvedValue(reminder) },
    occurrences: { getById: vi.fn().mockResolvedValue(item) },
    actions: {
      complete: vi.fn().mockResolvedValue({ ...item, status: "completed" }),
      snooze: vi.fn().mockResolvedValue(item),
      undoCompletion: vi.fn().mockResolvedValue({ ...item, status: "pending" }),
    },
  } as unknown as UniversalOccurrenceActionDependencies;
}

describe("executeUniversalOccurrenceAction", () => {
  it("completes a group occurrence with workspace and actor scoping", async () => {
    const deps = dependencies();
    const now = new Date("2026-08-13T12:00:00.000Z");

    const result = await executeUniversalOccurrenceAction(
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

    await executeUniversalOccurrenceAction(
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
      executeUniversalOccurrenceAction(
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
    ).rejects.toBeInstanceOf(UniversalOccurrenceActionForbiddenError);
    expect(deps.actions.complete).not.toHaveBeenCalled();
  });

  it("rejects a group callback replayed from another chat", async () => {
    const deps = dependencies();

    await expect(
      executeUniversalOccurrenceAction(
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
    ).rejects.toBeInstanceOf(UniversalOccurrenceActionForbiddenError);
    expect(deps.members.getByUserId).not.toHaveBeenCalled();
  });

  it("uses the same policy for Mini App actions without a Telegram message location", async () => {
    const deps = dependencies();

    await executeUniversalOccurrenceAction(
      config,
      {
        source: "mini-app",
        action: "done",
        occurrenceId: "occurrence-a",
        actorUserId: 20,
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
});
