import {
  OccurrenceActionsRepository,
  OccurrencesRepository,
  RemindersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  canActOnOccurrence,
  getNextScheduledDeadline,
  telegramApiRequest,
  type AppConfig,
  type ReminderOccurrence,
  type ScheduleSpec,
  type SnoozeResolution,
  type SnoozeSelection,
} from "@zvenfit-reminder/shared";
import type { InlineKeyboard } from "grammy";
import {
  renderOccurrenceAction,
  type OccurrencePresentationContext,
} from "./occurrence-message.js";

const TELEGRAM_API_TIMEOUT_MS = 10_000;

export type OccurrenceAction = "done" | "snooze" | "undo";

interface OccurrenceActionInputBase {
  occurrenceId: string;
  actorUserId: number;
  now?: Date;
  actorDisplayName?: string;
}

type OccurrenceActionSelection =
  | { action: "done" | "undo"; snooze?: never }
  | { action: "snooze"; snooze?: SnoozeSelection };

export type OccurrenceActionInput = OccurrenceActionInputBase &
  OccurrenceActionSelection &
  (
    | {
        source: "telegram";
        chatId: number;
        chatType: "private" | "group";
        messageId?: number;
      }
    | { source: "mini-app"; workspaceId: string; actorDisplayName: string }
  );

export interface OccurrenceActionResult {
  action: OccurrenceAction;
  occurrence: ReminderOccurrence;
  snooze?: SnoozeResolution;
  presentation?: OccurrencePresentationContext;
}

export class OccurrenceActionNotFoundError extends Error {
  constructor() {
    super("Reminder occurrence was not found");
    this.name = "OccurrenceActionNotFoundError";
  }
}

export class OccurrenceActionForbiddenError extends Error {
  constructor() {
    super("Actor cannot perform this reminder action");
    this.name = "OccurrenceActionForbiddenError";
  }
}

export interface OccurrenceActionDependencies {
  workspaces: Pick<WorkspacesRepository, "getById" | "getByTelegramChatId">;
  members: Pick<WorkspaceMembersRepository, "getByUserId">;
  reminders: Pick<RemindersRepository, "getById">;
  occurrences: Pick<
    OccurrencesRepository,
    "getById" | "findByIdForActor" | "beginMessageSync" | "finishMessageSync"
  >;
  actions: Pick<
    OccurrenceActionsRepository,
    "complete" | "snooze" | "undoCompletion"
  >;
  telegram?: {
    edit(
      botToken: string,
      chatId: number,
      messageId: number,
      text: string,
      keyboard: InlineKeyboard,
    ): Promise<void>;
  };
}

function createTelegramEditor(
  config: AppConfig,
): NonNullable<OccurrenceActionDependencies["telegram"]> {
  return {
    async edit(botToken, chatId, messageId, text, keyboard) {
      const request = telegramApiRequest({ ...config, botToken }, "editMessageText");
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard,
        }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Telegram editMessageText failed with HTTP ${response.status}`);
      }
    },
  };
}

function createDependencies(config: AppConfig): OccurrenceActionDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
    reminders: new RemindersRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    actions: new OccurrenceActionsRepository(config.ydbEndpoint, config.ydbDatabase),
    telegram: createTelegramEditor(config),
  };
}

function callbackLocationAllowed(
  visibility: ReminderOccurrence["visibility"],
  input: OccurrenceActionInput,
  workspaceChatId: number,
): boolean {
  if (input.source === "mini-app") {
    return true;
  }
  if (visibility === "group") {
    return input.chatType === "group" && input.chatId === workspaceChatId;
  }
  return input.chatType === "private" && input.chatId === input.actorUserId;
}

async function authorizeOccurrenceActionWithDependencies(
  input: OccurrenceActionInput,
  dependencies: OccurrenceActionDependencies,
) {
  const privateOccurrence = input.source === "telegram" && input.chatType === "private"
    ? await dependencies.occurrences.findByIdForActor(input.occurrenceId, input.actorUserId)
    : null;
  const workspace = input.source === "mini-app"
    ? await dependencies.workspaces.getById(input.workspaceId)
    : input.chatType === "group"
      ? await dependencies.workspaces.getByTelegramChatId(input.chatId)
      : privateOccurrence
        ? await dependencies.workspaces.getById(privateOccurrence.workspaceId)
        : null;
  if (!workspace || workspace.status !== "active") {
    throw new OccurrenceActionNotFoundError();
  }

  const occurrence = privateOccurrence ?? await dependencies.occurrences.getById(
    workspace.workspaceId, input.occurrenceId,
  );
  if (!occurrence) {
    throw new OccurrenceActionNotFoundError();
  }
  if (!callbackLocationAllowed(occurrence.visibility, input, workspace.telegramChatId)) {
    throw new OccurrenceActionForbiddenError();
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
    throw new OccurrenceActionForbiddenError();
  }

  return { workspace, occurrence, reminder };
}

function buildOccurrencePresentation(
  schedule: ScheduleSpec | undefined,
  timezone: string | undefined,
  defaultAllDayReminderTime: string | undefined,
  occurrence: ReminderOccurrence,
  action: OccurrenceAction,
  now: Date,
): OccurrencePresentationContext | undefined {
  if (!schedule) {
    return undefined;
  }
  if (action !== "done" || schedule.frequency === "once" || !timezone) {
    return { schedule };
  }

  const reference = new Date(Math.max(now.getTime(), occurrence.dueAt.getTime()));
  const nextDeadline = getNextScheduledDeadline(schedule, timezone, reference, {
    ...(defaultAllDayReminderTime ? { defaultAllDayReminderTime } : {}),
  });
  return {
    schedule,
    nextOccurrenceAt: nextDeadline?.dueAt ?? null,
  };
}

export async function executeOccurrenceAction(
  config: AppConfig,
  input: OccurrenceActionInput,
  providedDependencies?: OccurrenceActionDependencies,
): Promise<OccurrenceActionResult> {
  const dependencies = providedDependencies ?? createDependencies(config);
  const now = input.now ?? new Date();
  const { workspace, occurrence, reminder } = await authorizeOccurrenceActionWithDependencies(
    input,
    dependencies,
  );

  let updated: ReminderOccurrence | null;
  let snooze: SnoozeResolution | undefined;
  if (input.action === "done") {
    updated = await dependencies.actions.complete(
      workspace.workspaceId,
      occurrence.occurrenceId,
      input.actorUserId,
      now,
    );
  } else if (input.action === "snooze") {
    const snoozed = await dependencies.actions.snooze(
      workspace.workspaceId,
      occurrence.occurrenceId,
      input.actorUserId,
      input.snooze ?? { type: "preset", preset: "one_hour" },
      now,
    );
    updated = snoozed?.occurrence ?? null;
    snooze = snoozed?.snooze;
  } else {
    updated = await dependencies.actions.undoCompletion(
      workspace.workspaceId,
      occurrence.occurrenceId,
      input.actorUserId,
      now,
    );
  }
  if (!updated) {
    throw new OccurrenceActionNotFoundError();
  }
  const presentation = buildOccurrencePresentation(
    reminder.schedule,
    reminder.timezone,
    workspace.defaultAllDayReminderTime,
    updated,
    input.action,
    now,
  );
  const result: OccurrenceActionResult = {
    action: input.action,
    occurrence: updated,
    ...(snooze ? { snooze } : {}),
    ...(presentation ? { presentation } : {}),
  };
  const claim = await dependencies.occurrences.beginMessageSync(
    workspace.workspaceId,
    occurrence.occurrenceId,
    updated.stateRevision,
    now,
  );
  if (claim) {
    let synchronized = false;
    try {
      const current = claim.occurrence;
      const expectedMessageChatId = current.visibility === "group"
        ? workspace.telegramChatId
        : current.assignment.mode === "person"
          ? current.assignment.responsibleUserId
          : null;
      const actionStillCurrent =
        (input.action === "done" &&
          current.status === "completed" &&
          current.completedBy === input.actorUserId) ||
        (input.action === "snooze" && current.snoozedBy === input.actorUserId) ||
        (input.action === "undo" &&
          current.status !== "completed" &&
          current.completedBy == null);
      if (
        !claim.retireOnly &&
        actionStillCurrent &&
        current.latestMessageChatId != null &&
        current.latestMessageId != null &&
        expectedMessageChatId != null &&
        current.latestMessageChatId === expectedMessageChatId &&
        dependencies.telegram
      ) {
        const rendered = renderOccurrenceAction(
          { action: input.action, occurrence: current, ...(presentation ? { presentation } : {}) },
          {
            id: input.actorUserId,
            displayName: input.actorDisplayName ?? "Участник",
          },
        );
        await dependencies.telegram.edit(
          config.botToken,
          current.latestMessageChatId,
          current.latestMessageId,
          rendered.text,
          rendered.keyboard,
        );
        synchronized = true;
      }
    } catch {
      synchronized = false;
    } finally {
      await dependencies.occurrences.finishMessageSync(
        workspace.workspaceId,
        occurrence.occurrenceId,
        claim.stateRevision,
        claim.syncKey,
        synchronized,
      ).catch(() => undefined);
    }
  }
  return result;
}
