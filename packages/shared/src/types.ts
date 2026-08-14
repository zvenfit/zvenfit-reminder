export interface AppConfig {
  ydbEndpoint: string;
  ydbDatabase: string;
  botToken: string;
  webhookSecret: string;
  defaultTimezone: string;
  miniAppUrl: string;
}

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return value;
  };

  return {
    ydbEndpoint: required("YDB_ENDPOINT"),
    ydbDatabase: required("YDB_DATABASE"),
    botToken: required("BOT_TOKEN"),
    webhookSecret: required("WEBHOOK_SECRET"),
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/Moscow",
    miniAppUrl: process.env.MINI_APP_URL ?? "",
  };
}
