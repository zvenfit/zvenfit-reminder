import type { Reminder, ReminderKind, ScheduleSpec } from "./api";
import { DEFAULT_TIMEZONE } from "./timezones";
import { localCalendarDate, isoWeekdayInTimezone, leadTimeDraftFromMinutes, type LeadTimeUnit } from "./reminder-form-utils";

type Frequency = ScheduleSpec["frequency"];
export type EditScope = "occurrence" | "series";

export interface ReminderFormState {
  kind: ReminderKind;
  title: string;
  description: string;
  actionUrl: string;
  amountMajor: string;
  currency: string;
  visibility: "group" | "private";
  messageThreadId: string;
  assignmentMode: "person" | "anyone";
  responsibleUserId: string;
  watcherUserIds: number[];
  frequency: Frequency;
  date: string;
  startDate: string;
  timeLocal: string;
  allDay: boolean;
  interval: string;
  weekdays: number[];
  monthlyDay: string;
  monthlyLastDay: boolean;
  yearlyMonth: string;
  yearlyDay: string;
  leadAmount: string;
  leadUnit: LeadTimeUnit;
  repeatIntervalMinutes: string;
  ignoreQuietHours: boolean;
}


export function cloneReminderForm(form: ReminderFormState): ReminderFormState {
  return {
    ...form,
    watcherUserIds: [...form.watcherUserIds],
    weekdays: [...form.weekdays],
  };
}


export function emptyForm(
  responsibleUserId?: number,
  timezone = DEFAULT_TIMEZONE,
  reference = new Date(),
): ReminderFormState {
  const today = localCalendarDate(reference, timezone);
  const tomorrow = localCalendarDate(reference, timezone, 1);
  const [, month, day] = today.split("-");
  return {
    kind: "task",
    title: "",
    description: "",
    actionUrl: "",
    amountMajor: "",
    currency: "RUB",
    visibility: "group",
    messageThreadId: "",
    assignmentMode: "person",
    responsibleUserId: responsibleUserId ? String(responsibleUserId) : "",
    watcherUserIds: [],
    frequency: "once",
    date: tomorrow,
    startDate: today,
    timeLocal: "09:00",
    allDay: false,
    interval: "1",
    weekdays: [isoWeekdayInTimezone(reference, timezone)],
    monthlyDay: String(Number(day)),
    monthlyLastDay: false,
    yearlyMonth: String(Number(month)),
    yearlyDay: String(Number(day)),
    leadAmount: "0",
    leadUnit: "hours",
    repeatIntervalMinutes: "360",
    ignoreQuietHours: false,
  };
}

export function reminderForm(reminder: Reminder): ReminderFormState {
  const form = emptyForm(
    reminder.assignment.mode === "person" ? reminder.assignment.responsibleUserId : undefined,
    reminder.timezone,
  );
  form.kind = reminder.kind;
  form.title = reminder.title;
  form.description = reminder.description ?? "";
  form.actionUrl = reminder.actionUrl ?? "";
  form.amountMajor = reminder.amountMinor == null ? "" : String(reminder.amountMinor / 100);
  form.currency = reminder.currency ?? "RUB";
  form.visibility = reminder.visibility;
  form.messageThreadId = reminder.messageThreadId == null ? "" : String(reminder.messageThreadId);
  form.assignmentMode = reminder.assignment.mode;
  form.responsibleUserId = reminder.assignment.mode === "person"
    ? String(reminder.assignment.responsibleUserId)
    : "";
  form.watcherUserIds = [...reminder.watcherUserIds];
  form.frequency = reminder.schedule.frequency;
  form.allDay = reminder.schedule.timing.kind === "allDay";
  if (reminder.schedule.timing.kind === "timed") {
    form.timeLocal = reminder.schedule.timing.timeLocal;
  }
  if (reminder.schedule.frequency === "once") {
    form.date = reminder.schedule.date;
  } else {
    form.startDate = reminder.schedule.startDate;
    form.interval = String(reminder.schedule.interval);
  }
  if (reminder.schedule.frequency === "weekly") {
    form.weekdays = [...reminder.schedule.weekdays];
  }
  if (reminder.schedule.frequency === "monthly") {
    form.monthlyLastDay = reminder.schedule.day.type === "lastDay";
    if (reminder.schedule.day.type === "dayOfMonth") {
      form.monthlyDay = String(reminder.schedule.day.value);
    }
  }
  if (reminder.schedule.frequency === "yearly") {
    form.yearlyMonth = String(reminder.schedule.month);
    form.yearlyDay = String(reminder.schedule.day);
  }
  const leadDraft = leadTimeDraftFromMinutes(reminder.notificationPolicy.leadMinutes);
  form.leadAmount = leadDraft.amount;
  form.leadUnit = leadDraft.unit;
  form.repeatIntervalMinutes = String(reminder.notificationPolicy.repeatIntervalMinutes);
  form.ignoreQuietHours = reminder.notificationPolicy.ignoreQuietHours;
  return form;
}

