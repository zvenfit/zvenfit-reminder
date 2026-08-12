import {
  InactiveWorkspaceMemberError,
  OccurrencesRepository,
  PrivateChatUnavailableError,
  RemindersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  canCreateReminder,
  reminderDraftSchema,
  type AppConfig,
  type ParsedInitData,
} from "@zvenfit-reminder/shared";
import type { ApiGatewayEvent, ApiGatewayResponse } from "./api.js";
import { getPath, jsonResponse } from "./api.js";

export interface UniversalApiDependencies {
  workspaces: Pick<WorkspacesRepository, "getByTelegramChatId">;
  members: Pick<WorkspaceMembersRepository, "getByUserId" | "listProfiles">;
  reminders: Pick<RemindersRepository, "listForActor" | "create">;
  occurrences: Pick<OccurrencesRepository, "listActionableForActor">;
}

function createDependencies(config: AppConfig): UniversalApiDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
    reminders: new RemindersRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
  };
}

function isUniversalRoute(method: string, path: string): boolean {
  return (
    (method === "GET" && (
      path === "/api/dashboard" ||
      path === "/api/reminders" ||
      path === "/api/members"
    )) ||
    (method === "POST" && path === "/api/reminders")
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
