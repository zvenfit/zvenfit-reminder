export type WorkspaceRole = "owner" | "organizer" | "member";
export type ReminderStatus = "active" | "paused" | "archived";
export type ReminderVisibility = "group" | "private";

export interface WorkspaceMember {
  workspaceId: string;
  userId: number;
  role: WorkspaceRole;
  status: "active" | "removed";
  username: string | null;
  displayName: string;
  privateChatAvailable: boolean;
}

export type DeadlineTiming =
  | { kind: "timed"; timeLocal: string }
  | { kind: "allDay" };

export type ScheduleSpec =
  | { version: 1; frequency: "once"; date: string; timing: DeadlineTiming }
  | {
      version: 1;
      frequency: "daily";
      startDate: string;
      timing: DeadlineTiming;
      interval: number;
    }
  | {
      version: 1;
      frequency: "weekly";
      startDate: string;
      timing: DeadlineTiming;
      interval: number;
      weekdays: number[];
    }
  | {
      version: 1;
      frequency: "monthly";
      startDate: string;
      timing: DeadlineTiming;
      interval: number;
      day: { type: "dayOfMonth"; value: number; overflow: "lastDay" } | { type: "lastDay" };
    }
  | {
      version: 1;
      frequency: "yearly";
      startDate: string;
      timing: DeadlineTiming;
      interval: number;
      month: number;
      day: number;
      overflow: "lastDay";
    };

export interface Reminder {
  workspaceId: string;
  reminderId: string;
  title: string;
  description: string | null;
  actionUrl: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: ReminderVisibility;
  creatorUserId: number;
  assignment:
    | { mode: "person"; responsibleUserId: number }
    | { mode: "anyone" };
  watcherUserIds: number[];
  schedule: ScheduleSpec;
  timezone: string;
  notificationPolicy: {
    leadMinutes: number;
    repeatIntervalMinutes: number;
    ignoreQuietHours: boolean;
    escalation:
      | { enabled: false }
      | { enabled: true; delayMinutes: number; repeatMinutes: number };
  };
  status: ReminderStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderOccurrence {
  workspaceId: string;
  occurrenceId: string;
  reminderId: string;
  dueAt: string;
  title: string;
  description: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: ReminderVisibility;
  assignment:
    | { mode: "person"; responsibleUserId: number }
    | { mode: "anyone" };
  status: "scheduled" | "pending" | "overdue" | "completed" | "cancelled";
  timezone: string;
  nextNotificationAt: string | null;
}

export type CreateReminderBody = Omit<
  Reminder,
  | "workspaceId"
  | "reminderId"
  | "creatorUserId"
  | "status"
  | "version"
  | "createdAt"
  | "updatedAt"
>;

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const MOCK_MODE = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

const mockMembers: WorkspaceMember[] = [
  { workspaceId: "demo", userId: 10, role: "owner", status: "active", username: "anna", displayName: "Анна", privateChatAvailable: true },
  { workspaceId: "demo", userId: 20, role: "member", status: "active", username: "ivan", displayName: "Иван", privateChatAvailable: true },
  { workspaceId: "demo", userId: 30, role: "member", status: "active", username: null, displayName: "Маша", privateChatAvailable: false },
];

const mockReminders: Reminder[] = [
  {
    workspaceId: "demo", reminderId: "utilities", title: "Передать показания счётчиков", description: null, actionUrl: null, amountMinor: null, currency: null,
    visibility: "group", creatorUserId: 10, assignment: { mode: "person", responsibleUserId: 20 }, watcherUserIds: [10],
    schedule: { version: 1, frequency: "monthly", startDate: "2026-01-01", timing: { kind: "timed", timeLocal: "19:00" }, interval: 1, day: { type: "dayOfMonth", value: 25, overflow: "lastDay" } },
    timezone: "Europe/Moscow", notificationPolicy: { leadMinutes: 1440, repeatIntervalMinutes: 360, ignoreQuietHours: false, escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 } },
    status: "active", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    workspaceId: "demo", reminderId: "training", title: "Записаться на тренировку", description: null, actionUrl: null, amountMinor: 250000, currency: "RUB",
    visibility: "private", creatorUserId: 20, assignment: { mode: "person", responsibleUserId: 20 }, watcherUserIds: [],
    schedule: { version: 1, frequency: "weekly", startDate: "2026-01-01", timing: { kind: "timed", timeLocal: "12:00" }, interval: 1, weekdays: [1] },
    timezone: "Europe/Moscow", notificationPolicy: { leadMinutes: 0, repeatIntervalMinutes: 360, ignoreQuietHours: false, escalation: { enabled: false } },
    status: "active", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
];

const mockOccurrences: ReminderOccurrence[] = [
  {
    workspaceId: "demo", occurrenceId: "passport", reminderId: "passport", dueAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
    title: "Забрать готовый паспорт", description: null, amountMinor: null, currency: null, visibility: "group",
    assignment: { mode: "person", responsibleUserId: 20 }, status: "overdue", timezone: "Europe/Moscow", nextNotificationAt: new Date().toISOString(),
  },
  {
    workspaceId: "demo", occurrenceId: "internet", reminderId: "internet", dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    title: "Оплатить домашний интернет", description: null, amountMinor: 89000, currency: "RUB", visibility: "group",
    assignment: { mode: "person", responsibleUserId: 10 }, status: "pending", timezone: "Europe/Moscow", nextNotificationAt: new Date().toISOString(),
  },
];

function getInitData(): string {
  const devInitData = import.meta.env.VITE_DEV_INIT_DATA;
  if (devInitData) {
    return devInitData;
  }
  return window.Telegram?.WebApp?.initData ?? "";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": getInitData(),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(error.error ?? "Не удалось выполнить запрос", response.status, error.code);
  }

  return response.json() as Promise<T>;
}

export function loadDashboard(): Promise<{ occurrences: ReminderOccurrence[] }> {
  if (MOCK_MODE) {
    return Promise.resolve({
      occurrences: mockOccurrences.filter((occurrence) =>
        ["scheduled", "pending", "overdue"].includes(occurrence.status),
      ),
    });
  }
  return api("/api/dashboard");
}

export function listReminders(): Promise<{ reminders: Reminder[] }> {
  if (MOCK_MODE) return Promise.resolve({ reminders: mockReminders });
  return api("/api/reminders");
}

export function listMembers(): Promise<{ members: WorkspaceMember[] }> {
  if (MOCK_MODE) return Promise.resolve({ members: mockMembers });
  return api("/api/members");
}

export function syncMembers(): Promise<unknown> {
  if (MOCK_MODE) return Promise.resolve({ members: mockMembers });
  return api("/api/members/sync", { method: "POST", body: "{}" });
}

export function createReminder(body: CreateReminderBody): Promise<{ reminder: Reminder }> {
  if (MOCK_MODE) {
    return Promise.resolve({
      reminder: {
        ...body,
        workspaceId: "demo",
        reminderId: crypto.randomUUID(),
        creatorUserId: 10,
        status: "active",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }
  return api("/api/reminders", { method: "POST", body: JSON.stringify(body) });
}

export function completeOccurrence(
  occurrenceId: string,
): Promise<{ occurrence: ReminderOccurrence }> {
  if (MOCK_MODE) {
    const occurrence = mockOccurrences.find((item) => item.occurrenceId === occurrenceId)!;
    occurrence.status = "completed";
    return Promise.resolve({ occurrence });
  }
  return api(`/api/occurrences/${encodeURIComponent(occurrenceId)}/complete`, {
    method: "POST",
    body: "{}",
  });
}

export function snoozeOccurrence(
  occurrenceId: string,
  minutes = 60,
): Promise<{ occurrence: ReminderOccurrence }> {
  if (MOCK_MODE) {
    const occurrence = mockOccurrences.find((item) => item.occurrenceId === occurrenceId)!;
    occurrence.nextNotificationAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    return Promise.resolve({ occurrence });
  }
  return api(`/api/occurrences/${encodeURIComponent(occurrenceId)}/snooze`, {
    method: "POST",
    body: JSON.stringify({ minutes }),
  });
}

export function undoOccurrenceCompletion(
  occurrenceId: string,
): Promise<{ occurrence: ReminderOccurrence }> {
  if (MOCK_MODE) {
    const occurrence = mockOccurrences.find((item) => item.occurrenceId === occurrenceId)!;
    occurrence.status = new Date(occurrence.dueAt) <= new Date() ? "overdue" : "pending";
    return Promise.resolve({ occurrence });
  }
  return api(`/api/occurrences/${encodeURIComponent(occurrenceId)}/undo-completion`, {
    method: "POST",
    body: "{}",
  });
}

export function updateMemberRole(
  userId: number,
  role: "organizer" | "member",
): Promise<{ member: WorkspaceMember }> {
  if (MOCK_MODE) {
    const member = mockMembers.find((item) => item.userId === userId)!;
    member.role = role;
    return Promise.resolve({ member });
  }
  return api(`/api/members/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe?: { user?: { id?: number } };
        ready: () => void;
        expand: () => void;
        themeParams: Record<string, string>;
        showAlert: (message: string) => void;
      };
    };
  }
}
