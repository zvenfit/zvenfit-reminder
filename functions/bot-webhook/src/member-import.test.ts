import { describe, expect, it, vi } from "vitest";
import {
  canImportWorkspaceMembers,
  importSharedGroupMembers,
  memberImportRequestId,
  type ImportableChatMember,
} from "./member-import.js";

function chatMember(userId: number, status = "member"): ImportableChatMember {
  return {
    status,
    user: {
      id: userId,
      is_bot: false,
      first_name: `User ${userId}`,
    },
  };
}

describe("member import", () => {
  it("derives a stable positive Telegram request ID per workspace", () => {
    expect(memberImportRequestId("workspace-a")).toBe(1340583968);
    expect(memberImportRequestId("workspace-a")).not.toBe(
      memberImportRequestId("workspace-b"),
    );
  });

  it("allows only active owners and organizers", () => {
    expect(canImportWorkspaceMembers({ role: "owner", status: "active" })).toBe(true);
    expect(canImportWorkspaceMembers({ role: "organizer", status: "active" })).toBe(true);
    expect(canImportWorkspaceMembers({ role: "member", status: "active" })).toBe(false);
    expect(canImportWorkspaceMembers({ role: "owner", status: "removed" })).toBe(false);
    expect(canImportWorkspaceMembers(null)).toBe(false);
  });

  it("imports only verified current group members", async () => {
    const saveMember = vi.fn(async () => undefined);
    const getChatMember = vi.fn(async (_chatId: number, userId: number) => {
      if (userId === 30) {
        return chatMember(userId, "left");
      }
      if (userId === 40) {
        throw new Error("not accessible");
      }
      if (userId === 50) {
        return { ...chatMember(userId, "restricted"), is_member: false };
      }
      return chatMember(userId);
    });

    const result = await importSharedGroupMembers(
      -1001,
      [
        { user_id: 20 },
        { user_id: 20 },
        { user_id: 30 },
        { user_id: 40 },
        { user_id: 50 },
      ],
      { getChatMember, saveMember },
    );

    expect(result).toEqual({ imported: 1, skipped: 3 });
    expect(getChatMember).toHaveBeenCalledTimes(4);
    expect(saveMember).toHaveBeenCalledWith(chatMember(20));
  });

  it("limits a single Telegram selection to ten unique users", async () => {
    const saveMember = vi.fn(async () => undefined);
    const getChatMember = vi.fn(async (_chatId: number, userId: number) =>
      chatMember(userId));

    const result = await importSharedGroupMembers(
      -1001,
      Array.from({ length: 12 }, (_, index) => ({ user_id: index + 1 })),
      { getChatMember, saveMember },
    );

    expect(result).toEqual({ imported: 10, skipped: 0 });
    expect(getChatMember).toHaveBeenCalledTimes(10);
  });
});
