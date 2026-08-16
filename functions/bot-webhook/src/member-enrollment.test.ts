import { describe, expect, it } from "vitest";
import {
  isActiveGroupMember,
  isEnrollmentTarget,
  memberEnrollmentCallbackData,
  memberEnrollmentKeyboard,
  memberEnrollmentMessage,
  parseMemberEnrollmentCallbackData,
} from "./member-enrollment.js";

const workspaceId = "123e4567-e89b-42d3-a456-426614174000";

describe("member enrollment", () => {
  it("round-trips a workspace-scoped Telegram callback", () => {
    const data = memberEnrollmentCallbackData(workspaceId);

    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseMemberEnrollmentCallbackData(data)).toBe(workspaceId);
    expect(parseMemberEnrollmentCallbackData("member_join:workspace-a")).toBeNull();
    expect(parseMemberEnrollmentCallbackData("occurrence:done:1")).toBeNull();
  });

  it("builds a one-person self-enrollment message", () => {
    expect(memberEnrollmentMessage("Команда")).toContain("планировщику «Команда»");
    expect(memberEnrollmentKeyboard(workspaceId).inline_keyboard).toEqual([
      [{
        text: "Присоединиться к планировщику",
        callback_data: memberEnrollmentCallbackData(workspaceId),
      }],
    ]);
  });

  it("accepts only active human group members", () => {
    const user = { id: 20, is_bot: false };
    expect(isActiveGroupMember({ status: "member", user })).toBe(true);
    expect(isActiveGroupMember({ status: "administrator", user })).toBe(true);
    expect(isActiveGroupMember({ status: "restricted", is_member: true, user })).toBe(true);
    expect(isActiveGroupMember({ status: "restricted", is_member: false, user })).toBe(false);
    expect(isActiveGroupMember({ status: "left", user })).toBe(false);
    expect(isActiveGroupMember({ status: "member", user: { id: 20, is_bot: true } })).toBe(false);
  });

  it("binds enrollment to the exact active workspace and Telegram chat", () => {
    const workspace = { workspaceId, telegramChatId: -1001, status: "active" };
    expect(isEnrollmentTarget(workspace, workspaceId, -1001)).toBe(true);
    expect(isEnrollmentTarget(workspace, workspaceId, -1002)).toBe(false);
    expect(isEnrollmentTarget(workspace, "223e4567-e89b-42d3-a456-426614174000", -1001))
      .toBe(false);
    expect(isEnrollmentTarget({ ...workspace, status: "archived" }, workspaceId, -1001))
      .toBe(false);
  });
});
