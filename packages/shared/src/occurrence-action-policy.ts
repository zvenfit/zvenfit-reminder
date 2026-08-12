import type {
  ReminderDefinition,
  ReminderOccurrence,
  WorkspaceMember,
} from "./reminder-domain.js";

export type OccurrenceAction = "complete" | "snooze" | "undo";

export interface OccurrenceActionContext {
  action: OccurrenceAction;
  actor: WorkspaceMember;
  reminder: ReminderDefinition;
  occurrence: ReminderOccurrence;
}

export function canActOnOccurrence(context: OccurrenceActionContext): boolean {
  const { action, actor, reminder, occurrence } = context;
  if (
    actor.status !== "active" ||
    actor.workspaceId !== occurrence.workspaceId ||
    reminder.workspaceId !== occurrence.workspaceId ||
    reminder.reminderId !== occurrence.reminderId
  ) {
    return false;
  }

  const isCreator = actor.userId === reminder.creatorUserId;
  const isResponsible =
    occurrence.assignment.mode === "person" &&
    actor.userId === occurrence.assignment.responsibleUserId;

  if (occurrence.visibility === "private") {
    return isCreator || isResponsible;
  }

  const canAdministerGroup = actor.role === "owner" || actor.role === "organizer";
  if (isCreator || isResponsible || canAdministerGroup) {
    return true;
  }

  return occurrence.assignment.mode === "anyone" && action !== "snooze";
}
