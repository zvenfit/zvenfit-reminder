import {
  OccurrenceActionsRepository,
  OccurrencesRepository,
  RemindersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  canActOnOccurrence,
  type AppConfig,
  type ReminderOccurrence,
} from "@zvenfit-reminder/shared";

export type UniversalOccurrenceAction = "done" | "snooze" | "undo";

interface UniversalOccurrenceActionInputBase {
  action: UniversalOccurrenceAction;
  occurrenceId: string;
  actorUserId: number;
  snoozeMinutes?: number;
  now?: Date;
}

export type UniversalOccurrenceActionInput = UniversalOccurrenceActionInputBase &
  (
    | { source: "telegram"; chatId: number; chatType: "private" | "group" }
    | { source: "mini-app" }
  );

export interface UniversalOccurrenceActionResult {
  action: UniversalOccurrenceAction;
  occurrence: ReminderOccurrence;
}

export class UniversalOccurrenceActionNotFoundError extends Error {
  constructor() {
    super("Reminder occurrence was not found");
    this.name = "UniversalOccurrenceActionNotFoundError";
  }
}

export class UniversalOccurrenceActionForbiddenError extends Error {
  constructor() {
    super("Actor cannot perform this reminder action");
    this.name = "UniversalOccurrenceActionForbiddenError";
  }
}

export interface UniversalOccurrenceActionDependencies {
  workspaces: Pick<WorkspacesRepository, "getByTelegramChatId">;
  members: Pick<WorkspaceMembersRepository, "getByUserId">;
  reminders: Pick<RemindersRepository, "getById">;
  occurrences: Pick<OccurrencesRepository, "getById">;
  actions: Pick<
    OccurrenceActionsRepository,
    "complete" | "snooze" | "undoCompletion"
  >;
}

function createDependencies(config: AppConfig): UniversalOccurrenceActionDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
    reminders: new RemindersRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    actions: new OccurrenceActionsRepository(config.ydbEndpoint, config.ydbDatabase),
  };
}

function callbackLocationAllowed(
  visibility: ReminderOccurrence["visibility"],
  input: UniversalOccurrenceActionInput,
  allowedGroupChatId: number,
): boolean {
  if (input.source === "mini-app") {
    return true;
  }
  if (visibility === "group") {
    return input.chatType === "group" && input.chatId === allowedGroupChatId;
  }
  return input.chatType === "private" && input.chatId === input.actorUserId;
}

export async function executeUniversalOccurrenceAction(
  config: AppConfig,
  input: UniversalOccurrenceActionInput,
  providedDependencies?: UniversalOccurrenceActionDependencies,
): Promise<UniversalOccurrenceActionResult> {
  const dependencies = providedDependencies ?? createDependencies(config);
  const now = input.now ?? new Date();
  const snoozeMinutes = input.snoozeMinutes ?? 60;
  if (!Number.isInteger(snoozeMinutes) || snoozeMinutes < 15 || snoozeMinutes > 30 * 24 * 60) {
    throw new Error("Snooze duration must be between 15 minutes and 30 days");
  }
  const workspace = await dependencies.workspaces.getByTelegramChatId(config.allowedChatId);
  if (!workspace || workspace.status !== "active") {
    throw new UniversalOccurrenceActionNotFoundError();
  }

  const occurrence = await dependencies.occurrences.getById(
    workspace.workspaceId,
    input.occurrenceId,
  );
  if (!occurrence) {
    throw new UniversalOccurrenceActionNotFoundError();
  }
  if (!callbackLocationAllowed(occurrence.visibility, input, config.allowedChatId)) {
    throw new UniversalOccurrenceActionForbiddenError();
  }

  const [actor, reminder] = await Promise.all([
    dependencies.members.getByUserId(workspace.workspaceId, input.actorUserId),
    dependencies.reminders.getById(workspace.workspaceId, occurrence.reminderId),
  ]);
  if (
    !actor ||
    !reminder ||
    !canActOnOccurrence({
      action: input.action === "done" ? "complete" : input.action,
      actor,
      reminder,
      occurrence,
    })
  ) {
    throw new UniversalOccurrenceActionForbiddenError();
  }

  const updated =
    input.action === "done"
      ? await dependencies.actions.complete(
          workspace.workspaceId,
          occurrence.occurrenceId,
          input.actorUserId,
          now,
        )
      : input.action === "snooze"
        ? await dependencies.actions.snooze(
            workspace.workspaceId,
            occurrence.occurrenceId,
            input.actorUserId,
            new Date(now.getTime() + snoozeMinutes * 60 * 1_000),
            now,
          )
        : await dependencies.actions.undoCompletion(
            workspace.workspaceId,
            occurrence.occurrenceId,
            input.actorUserId,
            now,
          );
  if (!updated) {
    throw new UniversalOccurrenceActionNotFoundError();
  }
  return { action: input.action, occurrence: updated };
}
