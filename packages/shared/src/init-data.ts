import { createHmac, timingSafeEqual } from "node:crypto";

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface ParsedInitData {
  user: InitDataUser;
  authDate: number;
  hash: string;
  raw: Record<string, string>;
}

function parseInitDataRaw(initData: string): Record<string, string> {
  const params = new URLSearchParams(initData);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

// Проверка подписи Telegram Mini App initData
export function validateInitData(initData: string, botToken: string, maxAgeSeconds = 86400): ParsedInitData {
  const raw = parseInitDataRaw(initData);
  const hash = raw.hash;
  if (!hash) {
    throw new Error("Missing hash in initData");
  }

  const dataCheckString = Object.keys(raw)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${raw[key]}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const hashBuffer = Buffer.from(hash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");
  if (hashBuffer.length !== calculatedBuffer.length || !timingSafeEqual(hashBuffer, calculatedBuffer)) {
    throw new Error("Invalid initData signature");
  }

  const authDate = Number(raw.auth_date ?? 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > maxAgeSeconds) {
    throw new Error("initData expired");
  }

  const userRaw = raw.user;
  if (!userRaw) {
    throw new Error("Missing user in initData");
  }

  const user = JSON.parse(userRaw) as InitDataUser;
  if (!user.id) {
    throw new Error("Invalid user in initData");
  }

  return { user, authDate, hash, raw };
}
