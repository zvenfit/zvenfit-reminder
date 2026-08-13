import { describe, expect, it } from "vitest";
import { memberImportRequestId } from "./member-import.js";
import { managedWorkspaces, workspaceForMemberImport } from "./bot-workspaces.js";

const base = {
  telegramChatId: -1001,
  timezone: "Europe/Moscow",
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  defaultAllDayReminderTime: "09:00",
  status: "active" as const,
  ownerUserId: 10,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const workspaces = [
  { ...base, workspaceId: "workspace-a", displayName: "Дом", role: "owner" as const },
  { ...base, workspaceId: "workspace-b", displayName: "Работа", role: "organizer" as const },
  { ...base, workspaceId: "workspace-c", displayName: "Клуб", role: "member" as const },
];

describe("bot workspace routing", () => {
  it("offers participant import only for managed workspaces", () => {
    expect(managedWorkspaces(workspaces).map((workspace) => workspace.workspaceId))
      .toEqual(["workspace-a", "workspace-b"]);
  });

  it("resolves picker results back to the exact workspace", () => {
    expect(workspaceForMemberImport(
      workspaces,
      memberImportRequestId("workspace-b"),
    )?.workspaceId).toBe("workspace-b");
    expect(workspaceForMemberImport(workspaces, 123)).toBeNull();
  });
});
