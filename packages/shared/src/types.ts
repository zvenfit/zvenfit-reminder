export interface AppConfig {
  ydbEndpoint: string;
  ydbDatabase: string;
  botToken: string;
  webhookSecret: string;
  defaultTimezone: string;
  miniAppUrl: string;
  telegramApiRoot?: string;
  telegramProxySecret?: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new ConfigurationError(`Missing required env var: ${key}`);
    }
    return value;
  };

  const telegramApiRoot = process.env.TELEGRAM_API_ROOT?.trim() || undefined;
  const telegramProxySecret = process.env.TELEGRAM_PROXY_SECRET?.trim() || undefined;
  if ((telegramApiRoot && !telegramProxySecret) || (!telegramApiRoot && telegramProxySecret)) {
    throw new ConfigurationError(
      "TELEGRAM_API_ROOT and TELEGRAM_PROXY_SECRET must be configured together",
    );
  }

  return {
    ydbEndpoint: required("YDB_ENDPOINT"),
    ydbDatabase: required("YDB_DATABASE"),
    botToken: required("BOT_TOKEN"),
    webhookSecret: required("WEBHOOK_SECRET"),
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/Moscow",
    miniAppUrl: process.env.MINI_APP_URL ?? "",
    telegramApiRoot,
    telegramProxySecret,
  };
}
