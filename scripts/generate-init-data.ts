import { createHmac } from "node:crypto";

function generateInitData(botToken: string, userId: number, firstName = "Dev"): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: userId, first_name: firstName });
  const params: Record<string, string> = {
    auth_date: String(authDate),
    user,
  };
  const dataCheckString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

const botToken = process.env.BOT_TOKEN;
const userId = Number(process.env.DEV_USER_ID ?? "0");

if (!botToken) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

if (!userId) {
  console.error("DEV_USER_ID is required");
  process.exit(1);
}

const initData = generateInitData(botToken, userId);
console.log(initData);
console.error("\nExample:");
console.error(`  curl -H "X-Telegram-Init-Data: ${initData}" http://localhost:3000/api/workspaces`);
