import { describe, expect, it } from "vitest";
import { launchWorkspaceHint } from "./launch-context";

describe("launchWorkspaceHint", () => {
  it("accepts private Web App buttons and direct Telegram Mini App links", () => {
    expect(launchWorkspaceHint("?workspace=group-a")).toBe("group-a");
    expect(launchWorkspaceHint("?tgWebAppStartParam=ws_group-b")).toBe("group-b");
    expect(launchWorkspaceHint("?workspace=group-a", "ws_group-b")).toBe("group-b");
  });
  it("ignores missing and malformed hints", () => {
    expect(launchWorkspaceHint("?mock=1")).toBeNull();
    expect(launchWorkspaceHint("", "panel")).toBeNull();
    expect(launchWorkspaceHint("?workspace=%3Cscript%3E")).toBeNull();
    expect(launchWorkspaceHint("", "ws_")).toBeNull();
  });
});
