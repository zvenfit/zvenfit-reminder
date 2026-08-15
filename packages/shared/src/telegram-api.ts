export const TELEGRAM_PROXY_SECRET_HEADER = "X-Zvenfit-Telegram-Proxy-Secret";
export const TELEGRAM_BOT_TOKEN_HEADER = "X-Zvenfit-Telegram-Bot-Token";

export interface TelegramApiConfig {
  botToken: string;
  telegramApiRoot?: string;
  telegramProxySecret?: string;
}

const TELEGRAM_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function normalizeTelegramProxyRoot(rawRoot: string): string {
  const root = new URL(rawRoot);
  if (
    root.protocol !== "https:" ||
    !root.hostname.endsWith(".workers.dev") ||
    root.pathname !== "/telegram" ||
    root.search !== "" ||
    root.hash !== ""
  ) {
    throw new Error("TELEGRAM_API_ROOT must be an HTTPS workers.dev /telegram URL");
  }
  return root.toString().replace(/\/$/, "");
}

export function telegramApiRequest(
  config: TelegramApiConfig,
  method: string,
): { url: string; headers: Record<string, string> } {
  if (!TELEGRAM_METHOD_PATTERN.test(method)) {
    throw new Error("Invalid Telegram API method");
  }

  const root = config.telegramApiRoot;
  const proxySecret = config.telegramProxySecret;
  if ((root && !proxySecret) || (!root && proxySecret)) {
    throw new Error("TELEGRAM_API_ROOT and TELEGRAM_PROXY_SECRET must be configured together");
  }

  if (root && proxySecret) {
    return {
      url: `${normalizeTelegramProxyRoot(root)}/${method}`,
      headers: {
        "Content-Type": "application/json",
        [TELEGRAM_PROXY_SECRET_HEADER]: proxySecret,
        [TELEGRAM_BOT_TOKEN_HEADER]: config.botToken,
      },
    };
  }

  return {
    url: `https://api.telegram.org/bot${config.botToken}/${method}`,
    headers: { "Content-Type": "application/json" },
  };
}
