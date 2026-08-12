import {
  InactiveWorkspaceMemberError,
  OccurrenceNotActionableError,
  OccurrencesRepository,
  PrivateChatUnavailableError,
  RemindersRepository,
  WorkspaceMembersRepository,
  WorkspaceMemberNotFoundError,
  WorkspaceRoleChangeForbiddenError,
  WorkspacesRepository,
  UndoWindowExpiredError,
  canCreateReminder,
  reminderDraftSchema,
  type AppConfig,
  type ParsedInitData,
} from "@zvenfit-reminder/shared";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import { getPath, jsonResponse } from "./api.js";
import {
  UniversalOccurrenceActionForbiddenError,
  UniversalOccurrenceActionNotFoundError,
  executeUniversalOccurrenceAction,
  type UniversalOccurrenceActionInput,
  type UniversalOccurrenceActionResult,
} from "./universal-occurrence-actions.js";

export interface UniversalApiDependencies {
  workspaces: Pick<WorkspacesRepository, "getByTelegramChatId">;
  members: Pick<WorkspaceMembersRepository, "getByUserId" | "listProfiles" | "setRole">;
  reminders: Pick<RemindersRepository, "listForActor" | "create">;
  occurrences: Pick<OccurrencesRepository, "listActionableForActor">;
  occurrenceActions: {
    execute(input: UniversalOccurrenceActionInput): Promise<UniversalOccurrenceActionResult>;
  };
}

function createDependencies(config: AppConfig): UniversalApiDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
    reminders: new RemindersRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrenceActions: {
      execute: (input) => executeUniversalOccurrenceAction(config, input),
    },
  };
}

function isUniversalRoute(method: string, path: string): boolean {
  return (
    (method === "GET" && (
      path === "/api/dashboard" ||
      path === "/api/reminders" ||
      path === "/api/members"
    )) ||
    (method === "POST" && (
      path === "/api/reminders" ||
      /^\/api\/occurrences\/[^/]+\/(complete|snooze|undo-completion)$/.test(path)
    )) ||
    (method === "PATCH" && /^\/api\/members\/\d+\/role$/.test(path))
  );
}

export async function handleUniversalApi(
  event: ApiGatewayEvent,
  config: AppConfig,
  initData: ParsedInitData,
  providedDependencies?: UniversalApiDependencies,
): Promise<ApiGatewayResponse | null> {
  const method = event.httpMethod ?? "GET";
  const path = getPath(event);
  if (!isUniversalRoute(method, path)) {
    return null;
  }
  const dependencies = providedDependencies ?? createDependencies(config);
  const workspace = await dependencies.workspaces.getByTelegramChatId(config.allowedChatId);
  if (!workspace || workspace.status !== "active") {
    return jsonResponse(503, {
      error: "Workspace is not initialized",
      code: "workspace_not_initialized",
    });
  }
  const actor = await dependencies.members.getByUserId(
    workspace.workspaceId,
    initData.user.id,
  );
  if (!actor || actor.status !== "active") {
    return jsonResponse(403, { error: "Workspace membership required", code: "forbidden" });
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

  const memberRoleMatch = path.match(/^\/api\/members\/(\d+)\/role$/);
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
        action: routeAction === "complete" ? "done" : routeAction === "snooze" ? "snooze" : "undo",
        occurrenceId,
        actorUserId: actor.userId,
        ...(routeAction === "snooze" ? { snoozeMinutes } : {}),
      });
      return jsonResponse(200, { occurrence: result.occurrence });
    } catch (error) {
      if (error instanceof UniversalOccurrenceActionForbiddenError) {
        return jsonResponse(403, { error: "Cannot act on this reminder", code: "forbidden" });
      }
      if (error instanceof UniversalOccurrenceActionNotFoundError) {
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
