export type WorkspaceRole = "owner" | "organizer" | "member";
export type ReminderStatus = "active" | "paused" | "archived";
export type ReminderVisibility = "group" | "private";

export interface Workspace {
  workspaceId: string;
  telegramChatId: number;
  displayName: string;
  ownerUserId: number;
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
  role: WorkspaceRole;
}

export interface WorkspaceSettings {
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
}

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
  undoUntil: string | null;
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

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const MOCK_MODE = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

const mockMembers: WorkspaceMember[] = [
  { workspaceId: "demo", userId: 10, role: "owner", status: "active", username: "anna", displayName: "Анна", privateChatAvailable: true },
  { workspaceId: "demo", userId: 20, role: "member", status: "active", username: "ivan", displayName: "Иван", privateChatAvailable: true },
  { workspaceId: "demo", userId: 30, role: "member", status: "active", username: null, displayName: "Маша", privateChatAvailable: false },
  { workspaceId: "home", userId: 10, role: "member", status: "active", username: "anna", displayName: "Анна", privateChatAvailable: true },
  { workspaceId: "home", userId: 40, role: "owner", status: "active", username: "max", displayName: "Максим", privateChatAvailable: true },
];

const mockWorkspaces: Workspace[] = [
  {
    workspaceId: "demo",
    telegramChatId: -1001,
    displayName: "ZvenFit · Команда",
    ownerUserId: 10,
    timezone: "Europe/Moscow",
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    defaultAllDayReminderTime: "09:00",
    role: "owner",
  },
  {
    workspaceId: "home",
    telegramChatId: -1002,
    displayName: "Дом",
    ownerUserId: 40,
    timezone: "Europe/Moscow",
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    defaultAllDayReminderTime: "09:00",
    role: "member",
  },
];

let selectedWorkspaceId: string | null = null;

function inSelectedWorkspace<T extends { workspaceId: string }>(items: T[]): T[] {
  return items.filter((item) => item.workspaceId === selectedWorkspaceId);
}

export function selectWorkspace(workspaceId: string): void {
  selectedWorkspaceId = workspaceId;
}

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
    assignment: { mode: "person", responsibleUserId: 20 }, status: "overdue", timezone: "Europe/Moscow", nextNotificationAt: new Date().toISOString(), undoUntil: null,
  },
  {
    workspaceId: "demo", occurrenceId: "internet", reminderId: "internet", dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    title: "Оплатить домашний интернет", description: null, amountMinor: 89000, currency: "RUB", visibility: "group",
    assignment: { mode: "person", responsibleUserId: 10 }, status: "pending", timezone: "Europe/Moscow", nextNotificationAt: new Date().toISOString(), undoUntil: null,
  },
];

export function getInitData(): string {
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
      ...(selectedWorkspaceId ? { "X-Workspace-Id": selectedWorkspaceId } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(error.error ?? "Не удалось выполнить запрос", response.status, error.code);
  }

  return response.json() as Promise<T>;
}

export function listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  if (MOCK_MODE) return Promise.resolve({ workspaces: mockWorkspaces });
  return api("/api/workspaces");
}

export function loadDashboard(): Promise<{ occurrences: ReminderOccurrence[] }> {
  if (MOCK_MODE) {
    return Promise.resolve({
      occurrences: inSelectedWorkspace(mockOccurrences).filter((occurrence) =>
        ["scheduled", "pending", "overdue"].includes(occurrence.status),
      ),
    });
  }
  return api("/api/dashboard");
}

export function listReminders(): Promise<{ reminders: Reminder[] }> {
  if (MOCK_MODE) return Promise.resolve({ reminders: inSelectedWorkspace(mockReminders) });
  return api("/api/reminders");
}

export function listMembers(): Promise<{ members: WorkspaceMember[] }> {
  if (MOCK_MODE) return Promise.resolve({ members: inSelectedWorkspace(mockMembers) });
  return api("/api/members");
}

export function syncMembers(): Promise<unknown> {
  if (MOCK_MODE) return Promise.resolve({ members: inSelectedWorkspace(mockMembers) });
  return api("/api/members/sync", { method: "POST", body: "{}" });
}

export function updateWorkspaceSettings(
  settings: WorkspaceSettings,
): Promise<{ workspace: Workspace }> {
  if (MOCK_MODE) {
    const workspace = mockWorkspaces.find((item) => item.workspaceId === selectedWorkspaceId)!;
    Object.assign(workspace, settings);
    return Promise.resolve({ workspace });
  }
  return api("/api/workspace/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
  });
}

export function transferWorkspaceOwnership(
  targetUserId: number,
): Promise<{ workspace: Workspace }> {
  if (MOCK_MODE) {
    const workspace = mockWorkspaces.find((item) => item.workspaceId === selectedWorkspaceId)!;
    const previousOwner = mockMembers.find(
      (item) => item.workspaceId === selectedWorkspaceId && item.role === "owner",
    );
    const nextOwner = mockMembers.find(
      (item) => item.workspaceId === selectedWorkspaceId && item.userId === targetUserId,
    )!;
    if (previousOwner) previousOwner.role = "organizer";
    nextOwner.role = "owner";
    workspace.ownerUserId = targetUserId;
    workspace.role = "organizer";
    return Promise.resolve({ workspace });
  }
  return api("/api/workspace/transfer-ownership", {
    method: "POST",
    body: JSON.stringify({ targetUserId }),
  });
}

export function createReminder(body: CreateReminderBody): Promise<{ reminder: Reminder }> {
  if (MOCK_MODE) {
    const reminder: Reminder = {
      ...body,
      workspaceId: selectedWorkspaceId ?? "demo",
      reminderId: crypto.randomUUID(),
      creatorUserId: 10,
      status: "active",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockReminders.unshift(reminder);
    return Promise.resolve({ reminder });
  }
  return api("/api/reminders", { method: "POST", body: JSON.stringify(body) });
}

export function updateReminder(
  reminderId: string,
  body: CreateReminderBody,
): Promise<{ reminder: Reminder }> {
  if (MOCK_MODE) {
    const reminder = mockReminders.find((item) =>
      item.workspaceId === selectedWorkspaceId && item.reminderId === reminderId)!;
    Object.assign(reminder, body, {
      version: reminder.version + 1,
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve({ reminder });
  }
  return api(`/api/reminders/${encodeURIComponent(reminderId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function completeOccurrence(
  occurrenceId: string,
): Promise<{ occurrence: ReminderOccurrence }> {
  if (MOCK_MODE) {
    const occurrence = mockOccurrences.find((item) => item.occurrenceId === occurrenceId)!;
    occurrence.status = "completed";
    occurrence.undoUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
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
    occurrence.undoUntil = null;
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

export function reassignReminder(
  reminderId: string,
  responsibleUserId: number,
): Promise<{ reminder: Reminder }> {
  if (MOCK_MODE) {
    const reminder = mockReminders.find((item) => item.reminderId === reminderId)!;
    reminder.assignment = { mode: "person", responsibleUserId };
    reminder.status = "active";
    return Promise.resolve({ reminder });
  }
  return api(`/api/reminders/${encodeURIComponent(reminderId)}/reassign`, {
    method: "POST",
    body: JSON.stringify({ responsibleUserId }),
  });
}

export function changeReminderLifecycle(
  reminderId: string,
  action: "pause" | "resume" | "archive",
): Promise<{ reminder: Reminder }> {
  if (MOCK_MODE) {
    const reminder = mockReminders.find((item) => item.reminderId === reminderId)!;
    reminder.status = action === "archive" ? "archived" : action === "pause" ? "paused" : "active";
    return Promise.resolve({ reminder });
  }
  return api(`/api/reminders/${encodeURIComponent(reminderId)}/${action}`, {
    method: "POST",
    body: "{}",
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
        close?: () => void;
        themeParams: Record<string, string>;
        showAlert: (message: string) => void;
      };
    };
  }
}
