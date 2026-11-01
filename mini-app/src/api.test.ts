import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let api: typeof import("./api");

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", "");
  vi.stubEnv("VITE_DEV_INIT_DATA", "");
  vi.stubGlobal("window", {
    location: { search: "" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  api = await import("./api");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API request deadlines", () => {
  it("aborts a stalled read and allows a fresh successful retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_, options) => untilAborted(options!.signal!))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [] })));
    vi.stubGlobal("fetch", fetch);

    const result = api.listWorkspaces();
    const rejected = expect(result).rejects.toMatchObject({
      name: "ApiError", code: "request_timeout", status: 0,
      message: expect.stringContaining("повторите загрузку"),
    });
    await vi.advanceTimersByTimeAsync(api.API_REQUEST_TIMEOUT_MS - 1);
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(api.listWorkspaces()).resolves.toEqual({ workspaces: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])("bounds a stalled response body after HTTP %s headers", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async (_input, options: RequestInit) => ({
      ok: status === 200,
      status,
      statusText: "Service Unavailable",
      json: () => untilAborted(options.signal!),
    })));

    const rejected = expect(api.listWorkspaces()).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(api.API_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay a timed-out write and explains its uncertain result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementation((_, options) => untilAborted(options!.signal!));
    vi.stubGlobal("fetch", fetch);

    const rejected = expect(api.publishMemberEnrollment()).rejects.toMatchObject({
      code: "request_timeout",
      message: expect.stringContaining("Изменение могло сохраниться"),
    });
    await vi.advanceTimersByTimeAsync(api.API_REQUEST_TIMEOUT_MS * 3);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves API errors and clears the timer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Forbidden", code: "forbidden", reason: "membership_required",
    }), { status: 403 })));

    await expect(api.listWorkspaces()).rejects.toMatchObject({
      name: "ApiError", status: 403, code: "forbidden", reason: "membership_required",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves network errors and clears the timer", async () => {
    const error = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(api.listWorkspaces()).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connection tenant boundaries", () => {
  it("keeps account-level group operations independent of the selected workspace", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
    // Each response body can be consumed only once.
    fetch.mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    api.selectWorkspace("current-workspace");
    await api.createGroupConnection({ clientRequestId: "22222222-2222-4222-8222-222222222222", launchMode: "native" });
    await api.getGroupConnection("operation");
    await api.retryGroupConnection("operation");
    for (const [, options] of fetch.mock.calls) expect(new Headers(options?.headers).has("X-Workspace-Id")).toBe(false);
  });

  it("pins topic creation and status reads to the original workspace after selection changes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    api.selectWorkspace("other-workspace");
    const payload = { clientRequestId: "22222222-2222-4222-8222-222222222222", link: "https://t.me/c/1234567890/42", name: "Оплаты" };
    await api.createTopicConnection("draft-workspace", payload);
    api.selectWorkspace("third-workspace");
    await api.getTopicConnection("draft-workspace", "operation");
    for (const [, options] of fetch.mock.calls) expect(new Headers(options?.headers).get("X-Workspace-Id")).toBe("draft-workspace");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(payload);
    expect(fetch.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
  });
});
