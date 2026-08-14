import { getDefaultResultOrder } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWebhookFailureResponse,
  isWebhookRequest,
  resolveInitData,
} from "./index.js";

it("prefers IPv4 for Telegram calls from Yandex Cloud Functions", () => {
  expect(getDefaultResultOrder()).toBe("ipv4first");
});

describe("resolveInitData", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows the local bypass only in the development environment", () => {
    vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_USER_ID", "42");

    expect(resolveInitData(undefined, "unused-token").user.id).toBe(42);
  });

  it("fails closed when NODE_ENV is missing even if the bypass flag is set", () => {
    vi.stubEnv("SKIP_INIT_DATA_VALIDATION", "1");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("DEV_USER_ID", "42");

    expect(() => resolveInitData(undefined, "unused-token"))
      .toThrow("Missing X-Telegram-Init-Data");
  });
});

describe("isWebhookRequest", () => {
  it("accepts Telegram POSTs on the API Gateway and direct function paths", () => {
    expect(isWebhookRequest("/webhook", "POST")).toBe(true);
    expect(isWebhookRequest("/", "POST")).toBe(true);
  });

  it("does not turn other direct-function requests into webhook updates", () => {
    expect(isWebhookRequest("/", "GET")).toBe(false);
    expect(isWebhookRequest("/api/workspaces", "POST")).toBe(false);
    expect(isWebhookRequest("/other", "POST")).toBe(false);
  });
});

describe("buildWebhookFailureResponse", () => {
  it("asks Telegram to display a message error without another API request", () => {
    const response = buildWebhookFailureResponse({ message: { chat: { id: -42 } } });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({
      method: "sendMessage",
      chat_id: -42,
    });
  });

  it("shows callback failures as an alert", () => {
    const response = buildWebhookFailureResponse({ callback_query: { id: "callback-1" } });

    expect(JSON.parse(response.body ?? "{}")).toMatchObject({
      method: "answerCallbackQuery",
      callback_query_id: "callback-1",
      show_alert: true,
    });
  });

  it("acknowledges updates without a user-visible reply target", () => {
    expect(buildWebhookFailureResponse({ update_id: 1 })).toEqual({
      statusCode: 200,
      body: "",
    });
  });
});
