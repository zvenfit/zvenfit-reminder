import { describe, expect, it, vi } from "vitest";
import { isOutsideGroup, syncGroupMembers } from "./members-sync.js";

describe("syncGroupMembers", () => {
  it("classifies every Telegram state outside the group", () => {
    const user = { id: 20, first_name: "Иван" };
    expect(isOutsideGroup({ status: "left", user })).toBe(true);
    expect(isOutsideGroup({ status: "kicked", user })).toBe(true);
    expect(isOutsideGroup({ status: "restricted", is_member: false, user })).toBe(true);
    expect(isOutsideGroup({ status: "restricted", is_member: true, user })).toBe(false);
  });

  it("removes cached members who are no longer in the Telegram group", async () => {
    const api = {
      getChatAdministrators: vi.fn().mockResolvedValue([]),
      getChatMember: vi.fn()
        .mockResolvedValueOnce({
          status: "restricted",
          is_member: false,
          user: { id: 20, first_name: "Иван" },
        })
        .mockResolvedValueOnce({
          status: "member",
          user: { id: 30, first_name: "Маша" },
        }),
    };
    const observed = vi.fn().mockResolvedValue(undefined);
    const removed = vi.fn().mockResolvedValue(undefined);

    const synced = await syncGroupMembers(
      api as never,
      -1001,
      [20, 30],
      observed,
      undefined,
      removed,
    );

    expect(removed).toHaveBeenCalledWith(20);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ id: 30 }));
    expect(synced).toBe(1);
  });
});
