import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@zvenfit-reminder/shared";
import {
  observeTelegramIdentity,
  type TelegramObservationDependencies,
} from "./telegram-observation.js";

const config = {
  allowedChatId: -100123,
} as AppConfig;

function dependencies(): TelegramObservationDependencies {
  return {
    users: { observe: vi.fn().mockResolvedValue({}) },
    workspaces: {
      getByTelegramChatId: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        status: "active",
      }),
    },
    members: { observe: vi.fn().mockResolvedValue({}) },
  };
}

describe("observeTelegramIdentity", () => {
  it("records private-chat availability after a direct bot interaction", async () => {
    const deps = dependencies();
    await observeTelegramIdentity(
      config,
      { id: 20, username: "ivan", firstName: "Иван", languageCode: "ru" },
      { id: 20, type: "private" },
      deps,
    );

    expect(deps.users.observe).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 20, privateChatId: 20, locale: "ru" }),
    );
    expect(deps.members.observe).not.toHaveBeenCalled();
  });

  it("observes membership only in the configured group", async () => {
    const deps = dependencies();
    await observeTelegramIdentity(
      config,
      { id: 20, firstName: "Иван" },
      { id: -100123, type: "group" },
      deps,
    );

    expect(deps.users.observe).toHaveBeenCalledWith(
      expect.objectContaining({ privateChatId: null }),
    );
    expect(deps.members.observe).toHaveBeenCalledWith("workspace-a", 20);
  });
});
