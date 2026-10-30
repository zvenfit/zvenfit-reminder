export function launchWorkspaceHint(search: string, startParam?: string): string | null {
  const params = new URLSearchParams(search);
  const start = startParam ?? params.get("tgWebAppStartParam");
  const workspace = start?.startsWith("ws_") ? start.slice(3) : params.get("workspace");
  // This is a navigation hint only. The caller must match an accessible workspace.
  return workspace && /^[a-zA-Z0-9-]{1,100}$/.test(workspace) ? workspace : null;
}
