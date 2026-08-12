import { describe, expect, it } from "vitest";
import { reminderDraftSchema, type WorkspaceMember } from "./reminder-domain.js";
import { canCreateReminder } from "./reminder-access-policy.js";

function member(role: WorkspaceMember["role"], userId = 20): WorkspaceMember {
  return { role, userId, status: "active" } as WorkspaceMember;
}

const base = {
  title: "Передать показания",
  assignment: { mode: "person" as const, responsibleUserId: 20 },
  schedule: {
    version: 1 as const,
    frequency: "once" as const,
    date: "2026-08-25",
    timing: { kind: "timed" as const, timeLocal: "18:00" },
  },
  timezone: "Europe/Moscow",
};

describe("canCreateReminder", () => {
  it("allows organizers to create group reminders", () => {
    const draft = reminderDraftSchema.parse(base);
    expect(canCreateReminder(member("organizer"), draft)).toBe(true);
  });

  it("does not let an ordinary member assign group work", () => {
    const draft = reminderDraftSchema.parse(base);
    expect(canCreateReminder(member("member"), draft)).toBe(false);
  });

  it("lets a member create a private reminder only for themselves", () => {
    const own = reminderDraftSchema.parse({ ...base, visibility: "private" });
    const other = reminderDraftSchema.parse({
      ...base,
      visibility: "private",
      assignment: { mode: "person", responsibleUserId: 30 },
    });
    expect(canCreateReminder(member("member"), own)).toBe(true);
    expect(canCreateReminder(member("member"), other)).toBe(false);
    expect(canCreateReminder(member("owner"), other)).toBe(true);
  });
});
