import { describe, expect, it } from "vitest";
import type {
  ReminderDefinition,
  ReminderOccurrence,
  WorkspaceMember,
} from "./reminder-domain.js";
import { canActOnOccurrence, type OccurrenceAction } from "./occurrence-action-policy.js";

function actor(
  userId: number,
  role: WorkspaceMember["role"] = "member",
  status: WorkspaceMember["status"] = "active",
): WorkspaceMember {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    workspaceId: "workspace-a",
    userId,
    role,
    status,
    roleGrantedBy: null,
    roleGrantedAt: null,
    lastObservedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

const reminder = {
  workspaceId: "workspace-a",
  reminderId: "reminder-a",
  creatorUserId: 10,
} as ReminderDefinition;

function occurrence(
  visibility: ReminderOccurrence["visibility"] = "group",
  assignment: ReminderOccurrence["assignment"] = {
    mode: "person",
    responsibleUserId: 20,
  },
): ReminderOccurrence {
  return {
    workspaceId: "workspace-a",
    reminderId: "reminder-a",
    visibility,
    assignment,
  } as ReminderOccurrence;
}

function allowed(
  action: OccurrenceAction,
  member: WorkspaceMember,
  item = occurrence(),
): boolean {
  return canActOnOccurrence({ action, actor: member, reminder, occurrence: item });
}

describe("canActOnOccurrence", () => {
  it("allows the responsible person, creator, owner, and organizer on group work", () => {
    expect(allowed("complete", actor(20))).toBe(true);
    expect(allowed("snooze", actor(10))).toBe(true);
    expect(allowed("complete", actor(30, "owner"))).toBe(true);
    expect(allowed("undo", actor(40, "organizer"))).toBe(true);
  });

  it("lets any active member complete or undo anyone-mode work, but not snooze it", () => {
    const anyone = occurrence("group", { mode: "anyone" });
    expect(allowed("complete", actor(30), anyone)).toBe(true);
    expect(allowed("undo", actor(30), anyone)).toBe(true);
    expect(allowed("snooze", actor(30), anyone)).toBe(false);
  });

  it("does not grant private access through an administrative role", () => {
    const privateItem = occurrence("private");
    expect(allowed("complete", actor(30, "owner"), privateItem)).toBe(false);
    expect(allowed("complete", actor(10), privateItem)).toBe(true);
    expect(allowed("snooze", actor(20), privateItem)).toBe(true);
  });

  it("rejects removed members and cross-workspace data", () => {
    expect(allowed("complete", actor(20, "member", "removed"))).toBe(false);
    expect(
      allowed("complete", { ...actor(20), workspaceId: "workspace-b" }),
    ).toBe(false);
  });
});
