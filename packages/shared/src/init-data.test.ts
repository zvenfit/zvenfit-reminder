import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateInitData } from "./init-data.js";

function buildInitData(botToken: string, user: { id: number; first_name: string }, authDate: number): string {
  const userJson = JSON.stringify(user);
  const params: Record<string, string> = {
    auth_date: String(authDate),
    user: userJson,
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  return new URLSearchParams({ ...params, hash }).toString();
}

describe("validateInitData", () => {
  it("validates correct initData", () => {
    const botToken = "123456:ABC";
    const authDate = Math.floor(Date.now() / 1000);
    const initData = buildInitData(botToken, { id: 42, first_name: "Test" }, authDate);
    const parsed = validateInitData(initData, botToken);
    expect(parsed.user.id).toBe(42);
  });

  it("rejects invalid hash", () => {
    expect(() => validateInitData("user=%7B%7D&auth_date=1&hash=deadbeef", "token")).toThrow();
  });
});
