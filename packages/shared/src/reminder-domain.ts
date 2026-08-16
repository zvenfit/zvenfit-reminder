import { DateTime, IANAZone } from "luxon";
import { z } from "zod";

export const DEFAULT_REPEAT_INTERVAL_MINUTES = 6 * 60;
export const DEFAULT_ESCALATION_DELAY_MINUTES = 24 * 60;
export const DEFAULT_ESCALATION_REPEAT_MINUTES = 24 * 60;
export const DEFAULT_QUIET_HOURS_START = "22:00";
export const DEFAULT_QUIET_HOURS_END = "08:00";
export const DEFAULT_ALL_DAY_REMINDER_TIME = "09:00";

export const workspaceRoleSchema = z.enum(["owner", "organizer", "member"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceStatusSchema = z.enum(["active", "archived"]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const membershipStatusSchema = z.enum(["active", "removed"]);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const workspaceMemberDisplayNameUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();

export const reminderVisibilitySchema = z.enum(["group", "private"]);
export type ReminderVisibility = z.infer<typeof reminderVisibilitySchema>;

export const reminderKindSchema = z.enum(["task", "payment"]);
export type ReminderKind = z.infer<typeof reminderKindSchema>;

export const reminderStatusSchema = z.enum(["active", "paused", "archived"]);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

export const occurrenceStatusSchema = z.enum([
  "scheduled",
  "pending",
  "overdue",
  "completed",
  "cancelled",
]);
export type OccurrenceStatus = z.infer<typeof occurrenceStatusSchema>;

export const occurrenceNotificationStateSchema = z.enum(["waiting", "stopped"]);
export type OccurrenceNotificationState = z.infer<
  typeof occurrenceNotificationStateSchema
>;

export const deliveryStatusSchema = z.enum([
  "reserved",
  "sending",
  "sent",
  "failed",
  "unknown",
  "cancelled",
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const deliveryTypeSchema = z.enum(["initial", "repeat", "escalation", "state_update"]);
export type DeliveryType = z.infer<typeof deliveryTypeSchema>;

export const reminderRuntimeStateSchema = z.enum(["ready", "blocked", "paused"]);
export type ReminderRuntimeState = z.infer<typeof reminderRuntimeStateSchema>;

export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected local time in HH:mm format");

export const localDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = DateTime.fromISO(value, { zone: "UTC" });
    return parsed.isValid && parsed.toFormat("yyyy-MM-dd") === value;
  },
  { message: "Expected a valid local date in YYYY-MM-DD format" },
);

export const ianaTimezoneSchema = z.string().refine(
  (value) => IANAZone.isValidZone(value),
  { message: "Expected a valid IANA timezone" },
);

export const deadlineTimingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timed"),
      timeLocal: localTimeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("allDay") }).strict(),
]);
export type DeadlineTiming = z.infer<typeof deadlineTimingSchema>;

const recurringBase = {
  version: z.literal(1),
  startDate: localDateSchema,
  timing: deadlineTimingSchema,
};

export const onceScheduleSchema = z
  .object({
    version: z.literal(1),
    frequency: z.literal("once"),
    date: localDateSchema,
    timing: deadlineTimingSchema,
  })
  .strict();

export const dailyScheduleSchema = z
  .object({
    ...recurringBase,
    frequency: z.literal("daily"),
    interval: z.number().int().min(1).max(365),
  })
  .strict();

const weekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((weekdays) => new Set(weekdays).size === weekdays.length, {
    message: "Weekdays must be unique",
  });

export const weeklyScheduleSchema = z
  .object({
    ...recurringBase,
    frequency: z.literal("weekly"),
    interval: z.number().int().min(1).max(52),
    weekdays: weekdaysSchema,
  })
  .strict();

export const monthlyDaySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("dayOfMonth"),
      value: z.number().int().min(1).max(31),
      overflow: z.literal("lastDay"),
    })
    .strict(),
  z.object({ type: z.literal("lastDay") }).strict(),
]);
export type MonthlyDay = z.infer<typeof monthlyDaySchema>;

export const monthlyScheduleSchema = z
  .object({
    ...recurringBase,
    frequency: z.literal("monthly"),
    interval: z.number().int().min(1).max(120),
    day: monthlyDaySchema,
  })
  .strict();

export const yearlyScheduleSchema = z
  .object({
    ...recurringBase,
    frequency: z.literal("yearly"),
    interval: z.number().int().min(1).max(20),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    overflow: z.literal("lastDay"),
  })
  .strict();

export const scheduleSpecSchema = z
  .discriminatedUnion("frequency", [
    onceScheduleSchema,
    dailyScheduleSchema,
    weeklyScheduleSchema,
    monthlyScheduleSchema,
    yearlyScheduleSchema,
  ])
  .superRefine((schedule, context) => {
    if (
      schedule.frequency === "yearly" &&
      !DateTime.utc(2000, schedule.month, schedule.day).isValid
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["day"],
        message: "Expected a valid month and day; 29 February is allowed",
      });
    }
  });
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export const assignmentSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("person"),
      responsibleUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ mode: z.literal("anyone") }).strict(),
]);
export type ReminderAssignment = z.infer<typeof assignmentSchema>;

export const escalationPolicySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      delayMinutes: z.number().int().min(0).max(365 * 24 * 60),
      repeatMinutes: z.number().int().min(60).max(365 * 24 * 60),
    })
    .strict(),
]);
export type EscalationPolicy = z.infer<typeof escalationPolicySchema>;

export const notificationPolicySchema = z
  .object({
    leadMinutes: z.number().int().min(0).max(365 * 24 * 60).default(0),
    repeatIntervalMinutes: z
      .number()
      .int()
      .min(15)
      .max(30 * 24 * 60)
      .default(DEFAULT_REPEAT_INTERVAL_MINUTES),
    ignoreQuietHours: z.boolean().default(false),
    escalation: escalationPolicySchema.default({
      enabled: true,
      delayMinutes: DEFAULT_ESCALATION_DELAY_MINUTES,
      repeatMinutes: DEFAULT_ESCALATION_REPEAT_MINUTES,
    }),
  })
  .strict();
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;

const actionUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Only HTTP and HTTPS links are supported");

const reminderDraftBaseSchema = z
  .object({
    kind: reminderKindSchema.optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).nullable().default(null),
    actionUrl: actionUrlSchema.nullable().default(null),
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
    visibility: reminderVisibilitySchema.default("group"),
    assignment: assignmentSchema,
    watcherUserIds: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(100)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Watcher IDs must be unique",
      }),
    schedule: scheduleSpecSchema,
    timezone: ianaTimezoneSchema,
    notificationPolicy: notificationPolicySchema.prefault({}),
  })
  .strict()
  .superRefine((value, context) => {
    const effectiveKind = value.kind ?? (value.amountMinor == null ? "task" : "payment");
    if ((value.amountMinor == null) !== (value.currency == null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.amountMinor == null ? ["amountMinor"] : ["currency"],
        message: "Amount and currency must be provided together",
      });
    }

    if (value.visibility === "private" && value.assignment.mode !== "person") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignment"],
        message: "Private reminders require one responsible person",
      });
    }

    if (value.visibility === "private" && value.watcherUserIds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["watcherUserIds"],
        message: "Private reminders cannot have additional watchers",
      });
    }

    if (
      value.assignment.mode === "person" &&
      value.watcherUserIds.includes(value.assignment.responsibleUserId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["watcherUserIds"],
        message: "The responsible person cannot also be a watcher",
      });
    }

    if (
      effectiveKind === "payment" &&
      value.actionUrl != null &&
      new URL(value.actionUrl).protocol !== "https:"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionUrl"],
        message: "Payment links must use HTTPS",
      });
    }
  });

export const reminderDraftUpdateSchema = reminderDraftBaseSchema;
export type ReminderDraftUpdate = z.infer<typeof reminderDraftUpdateSchema>;

export const reminderDraftSchema = reminderDraftBaseSchema
  .transform((value) => ({
    ...value,
    kind: value.kind ?? (value.amountMinor == null ? "task" as const : "payment" as const),
  }));
export type ReminderDraft = z.infer<typeof reminderDraftSchema>;

export interface Workspace {
  workspaceId: string;
  telegramChatId: number;
  displayName: string;
  ownerUserId: number;
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceAccess extends Workspace {
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: number;
  role: WorkspaceRole;
  status: MembershipStatus;
  roleGrantedBy: number | null;
  roleGrantedAt: Date | null;
  lastObservedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramUser {
  userId: number;
  username: string | null;
  displayName: string;
  privateChatAvailable: boolean;
  privateChatId: number | null;
  locale: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMemberProfile extends WorkspaceMember {
  username: string | null;
  displayName: string;
  telegramDisplayName: string;
  displayNameOverride: string | null;
  privateChatAvailable: boolean;
}

export interface ReminderDefinition extends ReminderDraft {
  workspaceId: string;
  reminderId: string;
  creatorUserId: number;
  status: ReminderStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderOccurrence {
  workspaceId: string;
  occurrenceId: string;
  reminderId: string;
  reminderVersion: number;
  stateRevision: number;
  dueAt: Date;
  dueLocalDate: string;
  allDay: boolean;
  reminderStartAt: Date;
  status: OccurrenceStatus;
  notificationState: OccurrenceNotificationState;
  assignment: ReminderAssignment;
  kind: ReminderKind;
  title: string;
  description: string | null;
  actionUrl: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: ReminderVisibility;
  timezone: string;
  repeatIntervalMinutes: number;
  ignoreQuietHours: boolean;
  escalation: EscalationPolicy;
  nextNotificationAt: Date | null;
  notificationSequence: number;
  snoozedBy: number | null;
  snoozedAt: Date | null;
  snoozeUntil: Date | null;
  latestMessageChatId: number | null;
  latestMessageId: number | null;
  completedBy: number | null;
  completedByDisplayName: string | null;
  completedAt: Date | null;
  undoUntil: Date | null;
  cancelledBy: number | null;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationDelivery {
  workspaceId: string;
  deliveryKey: string;
  occurrenceId: string;
  reminderId: string;
  deliveryType: DeliveryType;
  sequence: number;
  scheduledAt: Date;
  claimedAt: Date;
  status: DeliveryStatus;
  telegramChatId: number | null;
  telegramMessageId: number | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderRuntime {
  workspaceId: string;
  reminderId: string;
  state: ReminderRuntimeState;
  nextDueAt: Date | null;
  nextReminderStartAt: Date | null;
  currentOccurrenceId: string | null;
  scheduleVersion: number;
  updatedAt: Date;
}
