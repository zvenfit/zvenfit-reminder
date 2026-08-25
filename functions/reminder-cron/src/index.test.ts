import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@zvenfit-reminder/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zvenfit-reminder/shared")>();
  return {
    ...actual,
    createRequestId: vi.fn(() => "cron-request-1"),
    loadConfig: vi.fn(() => ({})),
  };
});

vi.mock("./dispatcher.js", () => ({ runDispatcher: vi.fn() }));

import { runDispatcher } from "./dispatcher.js";
import { loadConfig } from "@zvenfit-reminder/shared";
import { handler } from "./index.js";

const stats = {
  mode: "workspace" as const,
  workspaces: 1,
  completionFinalized: 0,
  messagesSynced: 0,
  materialized: 0,
  reserved: 1,
  sent: 1,
  failed: 0,
  unknown: 0,
  skipped: 0,
  errors: [],
  errorCauses: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadConfig).mockReset();
  vi.mocked(loadConfig).mockImplementation(() => ({} as ReturnType<typeof loadConfig>));
  vi.mocked(runDispatcher).mockReset();
});

describe("cron handler observability", () => {
  it("writes a searchable summary for a successful run", async () => {
    vi.mocked(runDispatcher).mockResolvedValue(stats);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await handler();

    expect(response.statusCode).toBe(200);
    const entry = String(consoleLog.mock.calls[0]?.[0]);
    expect(entry).toContain('"event":"cron_dispatch"');
    expect(entry).toContain('"sent":1');
    expect(entry).toContain('"error_count":0');
  });

  it("marks partial business failures as errors without losing counters", async () => {
    vi.mocked(runDispatcher).mockResolvedValue({
      ...stats,
      sent: 0,
      unknown: 1,
      errors: ["send_lease_lost"],
      errorCauses: ["delivery_send:send_lease_lost:error"],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler();

    expect(response.statusCode).toBe(500);
    const entry = String(consoleError.mock.calls[0]?.[0]);
    expect(entry).toContain('"unknown":1');
    expect(entry).toContain('"error_codes":["send_lease_lost"]');
    expect(entry).toContain('"error_causes":["delivery_send:send_lease_lost:error"]');
  });

  it("logs configuration failures through the fatal boundary", async () => {
    vi.mocked(loadConfig).mockImplementationOnce(() => {
      const error = new Error("Missing secret value");
      error.name = "ConfigurationError";
      throw error;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handler()).rejects.toThrow("Missing secret value");

    const entry = String(consoleError.mock.calls[0]?.[0]);
    expect(entry).toContain('"level":"FATAL"');
    expect(entry).toContain('"error_code":"configuration_error"');
    expect(entry).not.toContain("Missing secret value");
  });
});
