import {
  DeliveryInProgressError,
  InactiveWorkspaceMemberError,
  OccurrenceNotActionableError,
  OccurrencesRepository,
  PrivateChatUnavailableError,
  ReminderCreateForbiddenError,
  ReminderReassignmentForbiddenError,
  ReminderLifecycleConflictError,
  ReminderLifecycleForbiddenError,
  ReminderUpdateForbiddenError,
  ReminderUpdateConflictError,
  ScheduleHasNoFutureDeadlineError,
  RemindersRepository,
  WorkspaceMembersRepository,
  WorkspaceMemberDisplayNameChangeForbiddenError,
  WorkspaceMemberNotFoundError,
  WorkspaceOwnershipTransferForbiddenError,
  WorkspaceRoleChangeForbiddenError,
  WorkspaceSettingsForbiddenError,
  WorkspacesRepository,
  UndoWindowExpiredError,
  canCreateReminder,
  reminderDraftSchema,
  workspaceMemberDisplayNameUpdateSchema,
  workspaceSettingsSchema,
  type AppConfig,
  type ParsedInitData,
} from "@zvenfit-reminder/shared";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import { getHeader, getPath, jsonResponse } from "./api.js";
import {
  OccurrenceActionForbiddenError,
  OccurrenceActionNotFoundError,
  executeOccurrenceAction,
  type OccurrenceActionInput,
  type OccurrenceActionResult,
} from "./occurrence-actions.js";
import {
  createMemberAvatarLoader,
  type MemberAvatarLoader,
} from "./member-avatar.js";
import {
  createMemberEnrollmentPublisher,
  type MemberEnrollmentPublisher,
} from "./member-enrollment.js";

export interface WorkspaceApiDependencies {
  workspaces: Pick<
    WorkspacesRepository,
    "getById" | "listForUser" | "updateSettings" | "transferOwnership"
  >;
  members: Pick<
    WorkspaceMembersRepository,
    "getByUserId" | "listProfiles" | "setDisplayNameOverride" | "setRole"
  >;
  reminders: Pick<
    RemindersRepository,
    "listForActor" | "create" | "update" | "reassign" | "changeLifecycle"
  >;
  occurrences: Pick<OccurrencesRepository, "listActionableForActor">;
  occurrenceActions: {
    execute(input: OccurrenceActionInput): Promise<OccurrenceActionResult>;
  };
  memberAvatar: MemberAvatarLoader;
  memberEnrollment: MemberEnrollmentPublisher;
}

function createDependencies(config: AppConfig): WorkspaceApiDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
    reminders: new RemindersRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrenceActions: {
      execute: (input) => executeOccurrenceAction(config, input),
    },
    memberAvatar: createMemberAvatarLoader(config),
    memberEnrollment: createMemberEnrollmentPublisher(config),
  };
}

function isWorkspaceRoute(method: string, path: string): boolean {
  return (
    (method === "GET" && path === "/api/workspaces") ||
    (method === "GET" && (
      path === "/api/dashboard" ||
      path === "/api/reminders" ||
      path === "/api/members" ||
      /^\/api\/members\/\d+\/avatar$/.test(path)
    )) ||
    (method === "POST" && (
      path === "/api/reminders" ||
      path === "/api/members/publish-enrollment" ||
      path === "/api/workspace/transfer-ownership" ||
      /^\/api\/reminders\/[^/]+\/reassign$/.test(path) ||
      /^\/api\/reminders\/[^/]+\/(pause|resume|archive)$/.test(path) ||
      /^\/api\/occurrences\/[^/]+\/(complete|snooze|undo-completion)$/.test(path)
    )) ||
    (method === "PATCH" && (
      path === "/api/workspace/settings" ||
      /^\/api\/reminders\/[^/]+$/.test(path) ||
      /^\/api\/members\/\d+\/display-name$/.test(path) ||
      /^\/api\/members\/\d+\/role$/.test(path)
    ))
  );
}

export async function handleWorkspaceApi(
  event: ApiGatewayEvent,
  config: AppConfig,
  initData: ParsedInitData,
  providedDependencies?: WorkspaceApiDependencies,
): Promise<ApiGatewayResponse | null> {
  const method = event.httpMethod ?? "GET";
  const path = getPath(event);
  if (!isWorkspaceRoute(method, path)) {
    return null;
  }
  const dependencies = providedDependencies ?? createDependencies(config);
  if (method === "GET" && path === "/api/workspaces") {
    const workspaces = await dependencies.workspaces.listForUser(initData.user.id);
    return jsonResponse(200, { workspaces });
  }

  const workspaceId = getHeader(event, "X-Workspace-Id")?.trim();
  if (!workspaceId || workspaceId.length > 100) {
    return jsonResponse(400, {
      error: "Choose a workspace",
      code: "workspace_required",
    });
  }
  const workspace = await dependencies.workspaces.getById(workspaceId);
  if (!workspace || workspace.status !== "active") {
    return jsonResponse(404, { error: "Workspace not found", code: "not_found" });
  }
  const actor = await dependencies.members.getByUserId(
    workspace.workspaceId,
    initData.user.id,
  );
  if (!actor || actor.status !== "active") {
    return jsonResponse(403, { error: "Workspace membership required", code: "forbidden" });
  }

  if (method === "POST" && path === "/api/members/publish-enrollment") {
    if (actor.role !== "owner" && actor.role !== "organizer") {
      return jsonResponse(403, {
        error: "Only an owner or organizer can invite members",
        code: "forbidden",
      });
    }
    try {
      await dependencies.memberEnrollment.publish({
        workspaceId: workspace.workspaceId,
        telegramChatId: workspace.telegramChatId,
        displayName: workspace.displayName,
      });
      return jsonResponse(200, { published: true });
    } catch {
      return jsonResponse(502, {
        error: "Telegram enrollment message is temporarily unavailable",
        code: "telegram_unavailable",
      });
    }
  }

  if (method === "PATCH" && path === "/api/workspace/settings") {
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    const settings = workspaceSettingsSchema.safeParse(body);
    if (!settings.success) {
      return jsonResponse(400, {
        error: "Invalid workspace settings",
        code: "validation_failed",
        issues: settings.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    try {
      const updated = await dependencies.workspaces.updateSettings(
        workspace.workspaceId,
        settings.data,
        actor.userId,
      );
      return jsonResponse(200, { workspace: { ...updated, role: actor.role } });
    } catch (error) {
      if (error instanceof WorkspaceSettingsForbiddenError) {
        return jsonResponse(403, { error: "Only organizers can change settings", code: "forbidden" });
      }
      throw error;
    }
  }

  if (method === "POST" && path === "/api/workspace/transfer-ownership") {
    let targetUserId: unknown;
    try {
      targetUserId = JSON.parse(event.body ?? "{}").targetUserId;
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    if (!Number.isSafeInteger(targetUserId) || Number(targetUserId) <= 0) {
      return jsonResponse(400, { error: "Invalid target user", code: "validation_failed" });
    }
    try {
      const updated = await dependencies.workspaces.transferOwnership(
        workspace.workspaceId,
        Number(targetUserId),
        actor.userId,
      );
      return jsonResponse(200, { workspace: { ...updated, role: "organizer" } });
    } catch (error) {
      if (error instanceof WorkspaceOwnershipTransferForbiddenError) {
        return jsonResponse(403, {
          error: "Only the owner can transfer ownership to an active member",
          code: "forbidden",
        });
      }
      throw error;
    }
  }

  if (method === "GET" && path === "/api/reminders") {
    const reminders = await dependencies.reminders.listForActor(
      workspace.workspaceId,
      actor.userId,
    );
    return jsonResponse(200, { reminders });
  }

  if (method === "GET" && path === "/api/dashboard") {
    const occurrences = await dependencies.occurrences.listActionableForActor(
      workspace.workspaceId,
      actor.userId,
    );
    return jsonResponse(200, { occurrences });
  }

  if (method === "GET" && path === "/api/members") {
    const members = await dependencies.members.listProfiles(workspace.workspaceId);
    return jsonResponse(200, { members });
  }

  const memberAvatarMatch = path.match(/^\/api\/members\/(\d+)\/avatar$/);
  if (method === "GET" && memberAvatarMatch) {
    const targetUserId = Number(memberAvatarMatch[1]);
    const target = await dependencies.members.getByUserId(
      workspace.workspaceId,
      targetUserId,
    );
    if (!target || target.status !== "active") {
      return jsonResponse(404, { error: "Workspace member not found", code: "not_found" });
    }
    try {
      const avatar = await dependencies.memberAvatar.load(targetUserId);
      return jsonResponse(200, { avatar });
    } catch {
      // A missing, private, or temporarily unavailable Telegram photo should not
      // prevent the participant selector from working with its monogram fallback.
      return jsonResponse(200, { avatar: null });
    }
  }

  const reminderUpdateMatch = path.match(/^\/api\/reminders\/([^/]+)$/);
  if (method === "PATCH" && reminderUpdateMatch) {
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    const parsedDraft = reminderDraftSchema.safeParse(body);
    if (!parsedDraft.success) {
      return jsonResponse(400, {
        error: "Invalid reminder",
        code: "validation_failed",
        issues: parsedDraft.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    try {
      const reminder = await dependencies.reminders.update(
        workspace.workspaceId,
        decodeURIComponent(reminderUpdateMatch[1]),
        parsedDraft.data,
        actor.userId,
      );
      return reminder
        ? jsonResponse(200, { reminder })
        : jsonResponse(404, { error: "Reminder not found", code: "not_found" });
    } catch (error) {
      if (error instanceof DeliveryInProgressError) {
        return jsonResponse(409, {
          error: "A notification is being sent; retry in a moment",
          code: "delivery_in_progress",
        });
      }
      if (error instanceof ReminderUpdateForbiddenError) {
        return jsonResponse(403, { error: "Cannot edit this reminder", code: "forbidden" });
      }
      if (error instanceof ReminderUpdateConflictError) {
        return jsonResponse(409, {
          error: "Wait until the completion undo window closes before editing",
          code: "update_conflict",
        });
      }
      if (error instanceof ScheduleHasNoFutureDeadlineError) {
        return jsonResponse(409, {
          error: "Choose a future reminder date",
          code: "schedule_has_no_future_deadline",
        });
      }
      if (error instanceof PrivateChatUnavailableError) {
        return jsonResponse(409, {
          error: "Responsible person must start the bot first",
          code: "private_chat_required",
          userId: error.userId,
        });
      }
      if (error instanceof InactiveWorkspaceMemberError) {
        return jsonResponse(409, {
          error: "Every participant must be an active workspace member",
          code: "inactive_participant",
          userIds: error.userIds,
        });
      }
      throw error;
    }
  }

  const reminderReassignMatch = path.match(/^\/api\/reminders\/([^/]+)\/reassign$/);
  if (method === "POST" && reminderReassignMatch) {
    let responsibleUserId: unknown;
    try {
      responsibleUserId = JSON.parse(event.body ?? "{}").responsibleUserId;
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    if (!Number.isSafeInteger(responsibleUserId) || Number(responsibleUserId) <= 0) {
      return jsonResponse(400, { error: "Invalid responsible user", code: "validation_failed" });
    }
    try {
      const reminder = await dependencies.reminders.reassign(
        workspace.workspaceId,
        decodeURIComponent(reminderReassignMatch[1]),
        Number(responsibleUserId),
        actor.userId,
      );
      return reminder
        ? jsonResponse(200, { reminder })
        : jsonResponse(404, { error: "Reminder not found", code: "not_found" });
    } catch (error) {
      if (error instanceof DeliveryInProgressError) {
        return jsonResponse(409, {
          error: "A notification is being sent; retry in a moment",
          code: "delivery_in_progress",
        });
      }
      if (error instanceof ReminderReassignmentForbiddenError) {
        return jsonResponse(403, { error: "Only organizers can reassign", code: "forbidden" });
      }
      if (error instanceof InactiveWorkspaceMemberError) {
        return jsonResponse(409, { error: "Choose an active member", code: "inactive_participant" });
      }
      if (error instanceof PrivateChatUnavailableError) {
        return jsonResponse(409, {
          error: "Responsible person must start the bot first",
          code: "private_chat_required",
          userId: error.userId,
        });
      }
      throw error;
    }
  }

  const reminderLifecycleMatch = path.match(
    /^\/api\/reminders\/([^/]+)\/(pause|resume|archive)$/,
  );
  if (method === "POST" && reminderLifecycleMatch) {
    const action = reminderLifecycleMatch[2] as "pause" | "resume" | "archive";
    try {
      const reminder = await dependencies.reminders.changeLifecycle(
        workspace.workspaceId,
        decodeURIComponent(reminderLifecycleMatch[1]),
        action,
        actor.userId,
      );
      return reminder
        ? jsonResponse(200, { reminder })
        : jsonResponse(404, { error: "Reminder not found", code: "not_found" });
    } catch (error) {
      if (error instanceof DeliveryInProgressError) {
        return jsonResponse(409, {
          error: "A notification is being sent; retry in a moment",
          code: "delivery_in_progress",
        });
      }
      if (error instanceof ReminderLifecycleForbiddenError) {
        return jsonResponse(403, { error: "Cannot manage this reminder", code: "forbidden" });
      }
      if (error instanceof ReminderLifecycleConflictError) {
        return jsonResponse(409, { error: error.message, code: "lifecycle_conflict" });
      }
      throw error;
    }
  }

  const memberRoleMatch = path.match(/^\/api\/members\/(\d+)\/role$/);
  const memberDisplayNameMatch = path.match(/^\/api\/members\/(\d+)\/display-name$/);
  if (method === "PATCH" && memberDisplayNameMatch) {
    const targetUserId = Number(memberDisplayNameMatch[1]);
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
      return jsonResponse(400, { error: "Invalid user ID", code: "validation_failed" });
    }
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    const parsed = workspaceMemberDisplayNameUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "Display name must contain 1–80 characters or be null",
        code: "validation_failed",
      });
    }
    try {
      const member = await dependencies.members.setDisplayNameOverride(
        workspace.workspaceId,
        targetUserId,
        parsed.data.displayName,
        actor.userId,
      );
      return jsonResponse(200, { member });
    } catch (error) {
      if (error instanceof WorkspaceMemberDisplayNameChangeForbiddenError) {
        return jsonResponse(403, { error: "Cannot rename this member", code: "forbidden" });
      }
      if (error instanceof WorkspaceMemberNotFoundError) {
        return jsonResponse(404, { error: "Workspace member not found", code: "not_found" });
      }
      throw error;
    }
  }

  if (method === "PATCH" && memberRoleMatch) {
    const targetUserId = Number(memberRoleMatch[1]);
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
      return jsonResponse(400, { error: "Invalid user ID", code: "validation_failed" });
    }
    let role: unknown;
    try {
      role = JSON.parse(event.body ?? "{}").role;
    } catch {
      return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
    }
    if (role !== "organizer" && role !== "member") {
      return jsonResponse(400, { error: "Role must be organizer or member", code: "validation_failed" });
    }
    try {
      const member = await dependencies.members.setRole(
        workspace.workspaceId,
        targetUserId,
        role,
        actor.userId,
      );
      return jsonResponse(200, { member });
    } catch (error) {
      if (error instanceof WorkspaceRoleChangeForbiddenError) {
        return jsonResponse(403, { error: "Only the owner can change roles", code: "forbidden" });
      }
      if (error instanceof WorkspaceMemberNotFoundError) {
        return jsonResponse(404, { error: "Workspace member not found", code: "not_found" });
      }
      throw error;
    }
  }

  const occurrenceActionMatch = path.match(
    /^\/api\/occurrences\/([^/]+)\/(complete|snooze|undo-completion)$/,
  );
  if (method === "POST" && occurrenceActionMatch) {
    const occurrenceId = decodeURIComponent(occurrenceActionMatch[1]);
    const routeAction = occurrenceActionMatch[2];
    let snoozeMinutes = 60;
    if (routeAction === "snooze") {
      try {
        const body = JSON.parse(event.body ?? "{}");
        snoozeMinutes = body.minutes ?? 60;
      } catch {
        return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
      }
      if (!Number.isInteger(snoozeMinutes) || snoozeMinutes < 15 || snoozeMinutes > 43_200) {
        return jsonResponse(400, {
          error: "Snooze duration must be between 15 minutes and 30 days",
          code: "validation_failed",
        });
      }
    }
    try {
      const result = await dependencies.occurrenceActions.execute({
        source: "mini-app",
        workspaceId: workspace.workspaceId,
        action: routeAction === "complete" ? "done" : routeAction === "snooze" ? "snooze" : "undo",
        occurrenceId,
        actorUserId: actor.userId,
        actorDisplayName: [initData.user.first_name, initData.user.last_name]
          .filter(Boolean)
          .join(" ") || "Участник",
        ...(routeAction === "snooze" ? { snoozeMinutes } : {}),
      });
      return jsonResponse(200, { occurrence: result.occurrence });
    } catch (error) {
      if (error instanceof DeliveryInProgressError) {
        return jsonResponse(409, {
          error: "A notification is being sent; retry in a moment",
          code: "delivery_in_progress",
        });
      }
      if (error instanceof OccurrenceActionForbiddenError) {
        return jsonResponse(403, { error: "Cannot act on this reminder", code: "forbidden" });
      }
      if (error instanceof OccurrenceActionNotFoundError) {
        return jsonResponse(404, { error: "Reminder occurrence not found", code: "not_found" });
      }
      if (error instanceof UndoWindowExpiredError) {
        return jsonResponse(409, { error: "Undo window has expired", code: "undo_expired" });
      }
      if (error instanceof OccurrenceNotActionableError) {
        return jsonResponse(409, { error: "Reminder state has already changed", code: "not_actionable" });
      }
      throw error;
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON", code: "invalid_json" });
  }
  const parsedDraft = reminderDraftSchema.safeParse(body);
  if (!parsedDraft.success) {
    return jsonResponse(400, {
      error: "Invalid reminder",
      code: "validation_failed",
      issues: parsedDraft.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (!canCreateReminder(actor, parsedDraft.data)) {
    return jsonResponse(403, { error: "Cannot create this reminder", code: "forbidden" });
  }

  try {
    const reminder = await dependencies.reminders.create(
      workspace.workspaceId,
      actor.userId,
      parsedDraft.data,
    );
    return jsonResponse(201, { reminder });
  } catch (error) {
    if (error instanceof ReminderCreateForbiddenError) {
      return jsonResponse(403, { error: "Cannot create this reminder", code: "forbidden" });
    }
    if (error instanceof ScheduleHasNoFutureDeadlineError) {
      return jsonResponse(409, {
        error: "Choose a future reminder date",
        code: "schedule_has_no_future_deadline",
      });
    }
    if (error instanceof PrivateChatUnavailableError) {
      return jsonResponse(409, {
        error: "Responsible person must start the bot first",
        code: "private_chat_required",
        userId: error.userId,
      });
    }
    if (error instanceof InactiveWorkspaceMemberError) {
      return jsonResponse(409, {
        error: "Every participant must be an active workspace member",
        code: "inactive_participant",
        userIds: error.userIds,
      });
    }
    throw error;
  }
}
