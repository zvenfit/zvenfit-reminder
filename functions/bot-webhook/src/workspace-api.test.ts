import { describe, expect, it, vi } from "vitest";
import {
  PrivateChatUnavailableError,
  ReminderCreateForbiddenError,
  ScheduleHasNoFutureDeadlineError,
  type AppConfig,
  type ParsedInitData,
  type WorkspaceMember,
} from "@zvenfit-reminder/shared";
import {
  handleWorkspaceApi,
  type WorkspaceApiDependencies,
} from "./workspace-api.js";

const config: AppConfig = {
  ydbEndpoint: "grpc://unused",
  ydbDatabase: "/unused",
  botToken: "token",
  webhookSecret: "secret",
  defaultTimezone: "Europe/Moscow",
  miniAppUrl: "",
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
      updateSettings: vi.fn().mockImplementation(async (_workspaceId, settings) => ({
        workspaceId: "workspace-a",
        status: "active",
        ...settings,
      })),
      transferOwnership: vi.fn().mockImplementation(async (_workspaceId, targetUserId) => ({
        workspaceId: "workspace-a",
        ownerUserId: targetUserId,
        status: "active",
      })),
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
      update: vi.fn().mockImplementation(async (_workspaceId, reminderId, draft) => ({
        ...draft,
        workspaceId: "workspace-a",
        reminderId,
        creatorUserId: 20,
        status: "active",
      })),
      changeLifecycle: vi.fn().mockImplementation(async (_workspaceId, reminderId, action) => ({
        workspaceId: "workspace-a",
        reminderId,
        status: action === "archive" ? "archived" : action === "pause" ? "paused" : "active",
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
    memberAvatar: {
      load: vi.fn().mockResolvedValue("data:image/jpeg;base64,AQID"),
    },
    memberEnrollment: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as WorkspaceApiDependencies;
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

describe("handleWorkspaceApi", () => {
  const workspaceHeaders = { "X-Workspace-Id": "workspace-a" };

  it("lists every active workspace available to the actor", async () => {
    const deps = dependencies();
    deps.workspaces.listForUser = vi.fn().mockResolvedValue([
      { workspaceId: "workspace-a", displayName: "Дом", role: "member" },
      { workspaceId: "workspace-b", displayName: "Работа", role: "organizer" },
    ]);
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
      { httpMethod: "GET", path: "/api/reminders", headers: workspaceHeaders },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(403);
    expect(deps.reminders.listForActor).not.toHaveBeenCalled();
  });

  it("publishes a self-enrollment message for a workspace organizer", async () => {
    const deps = dependencies(actor("organizer"));
    deps.workspaces.getById = vi.fn().mockResolvedValue({
      workspaceId: "workspace-a",
      telegramChatId: -1001,
      displayName: "Команда",
      status: "active",
    });
    const response = await handleWorkspaceApi(
      {
        httpMethod: "POST",
        path: "/api/members/publish-enrollment",
        headers: workspaceHeaders,
        body: "{}",
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response?.body ?? "{}")).toEqual({ published: true });
    expect(deps.memberEnrollment.publish).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      telegramChatId: -1001,
      displayName: "Команда",
    });
  });

  it("does not publish an enrollment message for a regular member", async () => {
    const deps = dependencies(actor("member"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "POST",
        path: "/api/members/publish-enrollment",
        headers: workspaceHeaders,
        body: "{}",
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(403);
    expect(deps.memberEnrollment.publish).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when Telegram cannot publish the enrollment message", async () => {
    const deps = dependencies(actor("owner"));
    deps.memberEnrollment.publish = vi.fn().mockRejectedValue(new Error("provider details"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "POST",
        path: "/api/members/publish-enrollment",
        headers: workspaceHeaders,
        body: "{}",
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(502);
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "Telegram enrollment message is temporarily unavailable",
      code: "telegram_unavailable",
    });
  });

  it("returns a Telegram avatar only for an active member of the selected workspace", async () => {
    const deps = dependencies(actor("organizer"));
    deps.members.getByUserId = vi.fn()
      .mockResolvedValueOnce(actor("organizer"))
      .mockResolvedValueOnce({ ...actor("member"), userId: 30 });
    const response = await handleWorkspaceApi(
      {
        httpMethod: "GET",
        path: "/api/members/30/avatar",
        headers: workspaceHeaders,
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response?.body ?? "{}").avatar).toBe("data:image/jpeg;base64,AQID");
    expect(deps.memberAvatar.load).toHaveBeenCalledWith(30);
  });

  it("falls back safely when a member has no accessible Telegram photo", async () => {
    const deps = dependencies();
    deps.memberAvatar.load = vi.fn().mockRejectedValue(new Error("provider details"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "GET",
        path: "/api/members/20/avatar",
        headers: workspaceHeaders,
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response?.body ?? "{}")).toEqual({ avatar: null });
  });

  it("does not load an avatar for a user outside the selected workspace", async () => {
    const deps = dependencies();
    deps.members.getByUserId = vi.fn()
      .mockResolvedValueOnce(actor())
      .mockResolvedValueOnce(null);
    const response = await handleWorkspaceApi(
      {
        httpMethod: "GET",
        path: "/api/members/30/avatar",
        headers: workspaceHeaders,
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(404);
    expect(deps.memberAvatar.load).not.toHaveBeenCalled();
  });

  it("does not reveal whether an unavailable workspace exists", async () => {
    const deps = dependencies();
    deps.workspaces.getById = vi.fn().mockResolvedValue(null);
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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
      actorDisplayName: "Иван",
    });
  });

  it("validates Mini App snooze duration before changing state", async () => {
    const deps = dependencies();
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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

  it("updates workspace delivery settings for an organizer", async () => {
    const deps = dependencies(actor("organizer"));
    const settings = {
      timezone: "Asia/Yekaterinburg",
      quietHoursStart: "23:00",
      quietHoursEnd: "07:30",
      defaultAllDayReminderTime: "10:00",
    };
    const response = await handleWorkspaceApi(
      {
        httpMethod: "PATCH",
        path: "/api/workspace/settings",
        headers: workspaceHeaders,
        body: JSON.stringify(settings),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.workspaces.updateSettings).toHaveBeenCalledWith(
      "workspace-a",
      settings,
      20,
    );
  });

  it("lets the owner transfer ownership to an active member", async () => {
    const deps = dependencies(actor("owner"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "POST",
        path: "/api/workspace/transfer-ownership",
        headers: workspaceHeaders,
        body: JSON.stringify({ targetUserId: 30 }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.workspaces.transferOwnership).toHaveBeenCalledWith(
      "workspace-a",
      30,
      20,
    );
  });

  it("reassigns a paused reminder inside the selected workspace", async () => {
    const deps = dependencies(actor("organizer"));
    const response = await handleWorkspaceApi(
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

  it("archives a reminder through the workspace-scoped lifecycle transition", async () => {
    const deps = dependencies(actor("organizer"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "POST",
        path: "/api/reminders/reminder-a/archive",
        headers: workspaceHeaders,
        body: "{}",
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.reminders.changeLifecycle).toHaveBeenCalledWith(
      "workspace-a",
      "reminder-a",
      "archive",
      20,
    );
  });

  it("edits a reminder definition inside the selected workspace", async () => {
    const deps = dependencies(actor("organizer"));
    const response = await handleWorkspaceApi(
      {
        httpMethod: "PATCH",
        path: "/api/reminders/reminder-a",
        headers: workspaceHeaders,
        body: JSON.stringify({ ...privateReminderBody, title: "Новое название" }),
      },
      config,
      initData,
      deps,
    );

    expect(response?.statusCode).toBe(200);
    expect(deps.reminders.update).toHaveBeenCalledWith(
      "workspace-a",
      "reminder-a",
      expect.objectContaining({ title: "Новое название" }),
      20,
    );
  });

  it("lets an ordinary member create a private reminder for themselves", async () => {
    const deps = dependencies();
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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
    const response = await handleWorkspaceApi(
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

  it("rejects creation when the actor role is revoked during the request", async () => {
    const deps = dependencies(actor("organizer"));
    deps.reminders.create = vi.fn().mockRejectedValue(new ReminderCreateForbiddenError());
    const response = await handleWorkspaceApi(
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
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({ code: "forbidden" });
  });

  it("returns an actionable conflict when a schedule has no future deadline", async () => {
    const deps = dependencies();
    deps.reminders.create = vi.fn().mockRejectedValue(
      new ScheduleHasNoFutureDeadlineError(),
    );
    const response = await handleWorkspaceApi(
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

    expect(response?.statusCode).toBe(409);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({
      code: "schedule_has_no_future_deadline",
    });
  });
});
