import type { ReminderDraft, WorkspaceMember } from "./reminder-domain.js";

export function canCreateReminder(
  actor: WorkspaceMember,
  draft: ReminderDraft,
): boolean {
  if (actor.status !== "active") {
    return false;
  }
  if (draft.visibility === "group") {
    return actor.role === "owner" || actor.role === "organizer";
  }
  if (draft.assignment.mode !== "person") {
    return false;
  }
  return (
    actor.role === "owner" ||
    actor.role === "organizer" ||
    draft.assignment.responsibleUserId === actor.userId
  );
}
