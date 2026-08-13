import { describe, expect, it, vi } from "vitest";
import {
  PrivateChatUnavailableError,
  type AppConfig,
  type ParsedInitData,
  type WorkspaceMember,
} from "@zvenfit-reminder/shared";
import {
  handleUniversalApi,
  type UniversalApiDependencies,
} from "./universal-api.js";

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

const initData: ParsedInitData = {
  user: { id: 20, first_name: "Иван" },
  authDate: 1,
  hash: "hash",
  raw: {},
};

function actor(role: WorkspaceMember["role"] = "member") {
  return {
    workspaceId: "workspace-a",
    userId: 20,
    role,
    status: "active",
  } as WorkspaceMember;
}

function dependencies(member: WorkspaceMember | null = actor()) {
  return {
    workspaces: {
      getById: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        status: "active",
      }),
      listForUser: vi.fn().mockResolvedValue([]),
    },
    members: {
      getByUserId: vi.fn().mockResolvedValue(member),
      listProfiles: vi.fn().mockResolvedValue([]),
      setRole: vi.fn().mockImplementation(async (_workspaceId, userId, role) => ({
        workspaceId: "workspace-a",
        userId,
        role,
        status: "active",
      })),
    },
    reminders: {
      listForActor: vi.fn().mockResolvedValue([]),
      reassign: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        reminderId: "reminder-a",
        status: "active",
        assignment: { mode: "person", responsibleUserId: 30 },
      }),
      create: vi.fn().mockImplementation(async (_workspaceId, creatorUserId, draft) => ({
        ...draft,
        workspaceId: "workspace-a",
        reminderId: "reminder-a",
        creatorUserId,
      })),
    },
    occurrences: {
      listActionableForActor: vi.fn().mockResolvedValue([]),
    },
    occurrenceActions: {
      execute: vi.fn().mockResolvedValue({
        action: "done",
        occurrence: { occurrenceId: "occurrence-a", status: "completed" },
      }),
    },
  } as unknown as UniversalApiDependencies;
}

const privateReminderBody = {
  title: "Принять лекарство",
  visibility: "private",
  assignment: { mode: "person", responsibleUserId: 20 },
  schedule: {
    version: 1,
    frequency: "once",
    date: "2026-08-25",
    timing: { kind: "timed", timeLocal: "18:00" },
  },
  timezone: "Europe/Moscow",
};

describe("handleUniversalApi", () => {
  const workspaceHeaders = { "X-Workspace-Id": "workspace-a" };

  it("lists every active workspace available to the actor", async () => {
    const deps = dependencies();
    deps.workspaces.listForUser = vi.fn().mockResolvedValue([
      { workspaceId: "workspace-a", displayName: "Дом", role: "member" },
      { workspaceId: "workspace-b", displayName: "Работа", role: "organizer" },
    ]);
    const response = await handleUniversalApi(
      { httpMethod: "GET", path: "/api/workspaces" },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response?.body ?? "{}").workspaces).toHaveLength(2);
  });

  it("requires active workspace membership", async () => {
    const deps = dependencies(null);
    const response = await handleUniversalApi(
      { httpMethod: "GET", path: "/api/reminders", headers: workspaceHeaders },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(403);
    expect(deps.reminders.listForActor).not.toHaveBeenCalled();
  });

  it("does not reveal whether an unavailable workspace exists", async () => {
    const deps = dependencies();
    deps.workspaces.getById = vi.fn().mockResolvedValue(null);
    const response = await handleUniversalApi(
      { httpMethod: "GET", path: "/api/reminders", headers: workspaceHeaders },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(404);
    expect(JSON.parse(response?.body ?? "{}").code).toBe("not_found");
    expect(deps.members.getByUserId).not.toHaveBeenCalled();
  });

  it("lists only reminders visible to the authenticated actor", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      { httpMethod: "GET", path: "/api/reminders", headers: workspaceHeaders },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.reminders.listForActor).toHaveBeenCalledWith("workspace-a", 20);
  });

  it("returns the actor's actionable occurrence feed", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      { httpMethod: "GET", path: "/api/dashboard", headers: workspaceHeaders },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.occurrences.listActionableForActor).toHaveBeenCalledWith(
      "workspace-a",
      20,
    );
  });

  it("completes an occurrence through the shared action service", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/occurrences/occurrence-a/complete",
        headers: workspaceHeaders,
        body: "{}",
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.occurrenceActions.execute).toHaveBeenCalledWith({
      source: "mini-app",
      workspaceId: "workspace-a",
      action: "done",
      occurrenceId: "occurrence-a",
      actorUserId: 20,
    });
  });

  it("validates Mini App snooze duration before changing state", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/occurrences/occurrence-a/snooze",
        headers: workspaceHeaders,
        body: JSON.stringify({ minutes: 5 }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(400);
    expect(deps.occurrenceActions.execute).not.toHaveBeenCalled();
  });

  it("updates a member role through the owner-scoped repository transition", async () => {
    const deps = dependencies(actor("owner"));
    const response = await handleUniversalApi(
      {
        httpMethod: "PATCH",
        path: "/api/members/30/role",
        headers: workspaceHeaders,
        body: JSON.stringify({ role: "organizer" }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.members.setRole).toHaveBeenCalledWith(
      "workspace-a",
      30,
      "organizer",
      20,
    );
  });

  it("reassigns a paused reminder inside the selected workspace", async () => {
    const deps = dependencies(actor("organizer"));
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/reminders/reminder-a/reassign",
        headers: workspaceHeaders,
        body: JSON.stringify({ responsibleUserId: 30 }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.reminders.reassign).toHaveBeenCalledWith(
      "workspace-a",
      "reminder-a",
      30,
      20,
    );
  });

  it("lets an ordinary member create a private reminder for themselves", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/reminders",
        headers: workspaceHeaders,
        body: JSON.stringify(privateReminderBody),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(201);
    expect(deps.reminders.create).toHaveBeenCalledWith(
      "workspace-a",
      20,
      expect.objectContaining({ visibility: "private" }),
    );
  });

  it("does not let an ordinary member create group assignments", async () => {
    const deps = dependencies();
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/reminders",
        headers: workspaceHeaders,
        body: JSON.stringify({ ...privateReminderBody, visibility: "group" }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(403);
    expect(deps.reminders.create).not.toHaveBeenCalled();
  });

  it("returns an actionable conflict when private delivery is unavailable", async () => {
    const deps = dependencies(actor("owner"));
    deps.reminders.create = vi.fn().mockRejectedValue(new PrivateChatUnavailableError(30));
    const response = await handleUniversalApi(
      {
        httpMethod: "POST",
        path: "/api/reminders",
        headers: workspaceHeaders,
        body: JSON.stringify({
          ...privateReminderBody,
          assignment: { mode: "person", responsibleUserId: 30 },
        }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(409);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({
      code: "private_chat_required",
      userId: 30,
    });
  });
});
