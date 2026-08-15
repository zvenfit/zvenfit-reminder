import { describe, expect, it } from "vitest";
import { getPath } from "./api.js";

describe("getPath", () => {
  it("uses the actual URL from a Yandex API Gateway 0.1 event", () => {
    expect(getPath({
      path: "/api/{proxy+}",
      url: "/api/workspaces",
    })).toBe("/api/workspaces");
  });

  it("extracts the path from a full URL and ignores its query", () => {
    expect(getPath({
      path: "/api/{proxy+}",
      url: "https://gateway.example/api/reminders?scope=mine",
    })).toBe("/api/reminders");
  });

  it("keeps supporting direct function events without a URL", () => {
    expect(getPath({ path: "/health/runtime" })).toBe("/health/runtime");
  });
});
