import type { WorkspaceAccess } from "@zvenfit-reminder/shared";
import { memberImportRequestId } from "./member-import.js";

export interface WorkspaceWithRole extends WorkspaceAccess {}

export function managedWorkspaces(
  workspaces: WorkspaceWithRole[],
): WorkspaceWithRole[] {
  return workspaces.filter((workspace) =>
    workspace.role === "owner" || workspace.role === "organizer");
}

export function workspaceForMemberImport(
  workspaces: WorkspaceWithRole[],
  requestId: number,
): WorkspaceWithRole | null {
  const matches = managedWorkspaces(workspaces).filter(
    (workspace) => memberImportRequestId(workspace.workspaceId) === requestId,
  );
  return matches.length === 1 ? matches[0] : null;
}
