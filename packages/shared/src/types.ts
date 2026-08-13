export type RuleType = "recurring" | "oneoff";
export type RuleStatus = "active" | "paused" | "archived";
export type InstanceStatus = "pending" | "done" | "skipped";

export interface Rule {
  id: string;
  title: string;
  amount: number | null;
  ruleType: RuleType;
  dayOfMonth: number | null;
  dueAt: Date | null;
  timeLocal: string;
  timezone: string;
  chatId: number;
  mentionIds: number[];
  status: RuleStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderInstance {
  id: string;
  ruleId: string;
  dueAt: Date;
  status: InstanceStatus;
  completedBy: number | null;
  completedAt: Date | null;
  messageId: number | null;
}

export interface GroupMember {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  updatedAt: Date;
}

export interface CreateRuleInput {
  title: string;
  amount?: number | null;
  ruleType: RuleType;
  dayOfMonth?: number | null;
  dueAt?: string | null;
  timeLocal: string;
  timezone?: string;
  chatId: number;
  mentionIds: number[];
}

export interface UpdateRuleInput {
  title?: string;
  amount?: number | null;
  ruleType?: RuleType;
  dayOfMonth?: number | null;
  dueAt?: string | null;
  timeLocal?: string;
  timezone?: string;
  mentionIds?: number[];
  status?: RuleStatus;
}

export interface AppConfig {
  ydbEndpoint: string;
  ydbDatabase: string;
  botToken: string;
  webhookSecret: string;
  allowedChatId: number;
  defaultTimezone: string;
  miniAppUrl: string;
  adminUserIds: number[];
  universalRemindersEnabled: boolean;
}

export function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return value;
  };

  const universalRemindersEnabled = process.env.UNIVERSAL_REMINDERS_ENABLED === "1";
  const allowedChatIdRaw = process.env.ALLOWED_CHAT_ID?.trim();
  if (!universalRemindersEnabled && !allowedChatIdRaw) {
    throw new Error("Missing required env var: ALLOWED_CHAT_ID");
  }
  const allowedChatId = allowedChatIdRaw ? Number(allowedChatIdRaw) : 0;
  if (!Number.isSafeInteger(allowedChatId)) {
    throw new Error("Invalid ALLOWED_CHAT_ID");
  }

  return {
    ydbEndpoint: required("YDB_ENDPOINT"),
    ydbDatabase: required("YDB_DATABASE"),
    botToken: required("BOT_TOKEN"),
    webhookSecret: required("WEBHOOK_SECRET"),
    allowedChatId,
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/Moscow",
    miniAppUrl: process.env.MINI_APP_URL ?? "",
    adminUserIds: (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
    universalRemindersEnabled,
  };
}
