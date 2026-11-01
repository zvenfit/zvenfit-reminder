import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

type Role = "owner" | "organizer" | "member";

interface ApiMember {
  workspaceId: string;
  userId: number;
  role: Role;
  status: "active";
  username: string | null;
  displayName: string;
  telegramDisplayName: string;
  displayNameOverride: string | null;
  privateChatAvailable: boolean;
}

interface ApiWorkspace {
  workspaceId: string;
  telegramChatId: number;
  isForum?: boolean;
  displayName: string;
  ownerUserId: number;
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
  role: Role;
}

interface ApiReminder {
  workspaceId: string;
  reminderId: string;
  kind: "task" | "payment";
  title: string;
  description: string | null;
  actionUrl: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: "group" | "private";
  messageThreadId?: number | null;
  creatorUserId: number;
  assignment: { mode: "person"; responsibleUserId: number } | { mode: "anyone" };
  watcherUserIds: number[];
  schedule: Record<string, unknown>;
  timezone: string;
  notificationPolicy: Record<string, unknown>;
  status: "active" | "paused" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ApiOccurrence {
  workspaceId: string;
  occurrenceId: string;
  reminderId: string;
  kind: "task" | "payment";
  dueAt: string;
  dueLocalDate?: string;
  allDay?: boolean;
  reminderStartAt?: string;
  title: string;
  description: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: "group" | "private";
  messageThreadId?: number | null;
  assignment: { mode: "person"; responsibleUserId: number } | { mode: "anyone" };
  watcherUserIds: number[];
  status: "pending" | "overdue" | "completed" | "cancelled";
  timezone: string;
  leadMinutes: number | null;
  repeatIntervalMinutes?: number;
  ignoreQuietHours?: boolean;
  escalation?:
    | { enabled: false }
    | { enabled: true; delayMinutes: number; repeatMinutes: number };
  nextNotificationAt: string | null;
  undoUntil: string | null;
  snoozeUntil?: string | null;
  actionUrl?: string | null;
  completedBy?: number | null;
  completedByDisplayName?: string | null;
  completedAt?: string | null;
  cancelledBy?: number | null;
  cancellationReason?: string | null;
  cancelledAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ApiState {
  topics?: Record<string, Array<{ messageThreadId: number; name: string; isClosed: boolean; unavailableReason?: "topic_closed" | "topic_deleted" | null }>>;
  topicsFailuresRemaining?: number;
  topicConnectionError?: string;
  topicConnectionState?: "pending" | "sending" | "succeeded" | "failed" | "unknown";
  topicConnectionGate?: Promise<void>;
  topicConnectionFailuresRemaining?: number;
  createGate?: Promise<void>;
  createResponseNeverArrives?: boolean;
  groupConnectionFailuresRemaining?: number;
  groupConnectionState?: "pending" | "validating" | "connected" | "rejected" | "expired";
  groupWorkspace?: ApiWorkspace;
  workspaces: ApiWorkspace[];
  members: Record<string, ApiMember[]>;
  reminders: Record<string, ApiReminder[]>;
  occurrences: Record<string, ApiOccurrence[]>;
  requests: Array<{
    method: string;
    path: string;
    workspaceId: string | null;
    initData: string | null;
    body: unknown;
  }>;
  undoErrorCode?: "undo_expired" | "not_actionable";
  workspaceFailuresRemaining?: number;
  workspaceDelayMs?: number;
  dashboardFailuresRemaining?: number;
  memberFailuresRemaining?: number;
  historyFailuresRemaining?: number;
  historyDelayMs?: number;
  createFailuresRemaining?: number;
  snoozeResponseGate?: Promise<void>;
  snoozeRequestedAt?: string;
  snoozeEffectiveAt?: string;
  snoozeAdjustedForQuietHours?: boolean;
  completionAt?: string;
}

const now = "2026-08-14T09:00:00.000Z";
const onceSchedule = {
  version: 1,
  frequency: "once",
  date: "2099-08-15",
  timing: { kind: "timed", timeLocal: "09:00" },
};
const policy = {
  leadMinutes: 0,
  repeatIntervalMinutes: 360,
  ignoreQuietHours: false,
  escalation: { enabled: false },
};
const avatarPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M8AAQUBAScY42YAAAAASUVORK5CYII=";

function reminder(
  workspaceId: string,
  reminderId: string,
  title: string,
  overrides: Partial<ApiReminder> = {},
): ApiReminder {
  return {
    workspaceId,
    reminderId,
    kind: "task",
    title,
    description: null,
    actionUrl: null,
    amountMinor: null,
    currency: null,
    visibility: "group",
    creatorUserId: 10,
    assignment: { mode: "person", responsibleUserId: 20 },
    watcherUserIds: [10],
    schedule: onceSchedule,
    timezone: "Europe/Moscow",
    notificationPolicy: policy,
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function occurrence(
  occurrenceId: string,
  title: string,
  overrides: Partial<ApiOccurrence> = {},
): ApiOccurrence {
  return {
    workspaceId: "team",
    occurrenceId,
    reminderId: occurrenceId,
    kind: "task",
    dueAt: "2026-08-14T12:00:00.000Z",
    dueLocalDate: "2026-08-14",
    allDay: false,
    reminderStartAt: now,
    title,
    description: null,
    amountMinor: null,
    currency: null,
    visibility: "group",
    assignment: { mode: "person", responsibleUserId: 10 },
    watcherUserIds: [],
    status: "pending",
    timezone: "Europe/Moscow",
    leadMinutes: 0,
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    nextNotificationAt: now,
    undoUntil: null,
    ...overrides,
  };
}

function createState(): ApiState {
  return {
    workspaces: [
      {
        workspaceId: "team",
        isForum: true,
        telegramChatId: -1001,
        displayName: "Команда",
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
    ],
    members: {
      team: [
        { workspaceId: "team", userId: 10, role: "owner", status: "active", username: "anna", displayName: "Анна", telegramDisplayName: "Анна", displayNameOverride: null, privateChatAvailable: true },
        { workspaceId: "team", userId: 20, role: "member", status: "active", username: "ivan", displayName: "Иван", telegramDisplayName: "Иван", displayNameOverride: null, privateChatAvailable: true },
        { workspaceId: "team", userId: 30, role: "member", status: "active", username: null, displayName: "Я", telegramDisplayName: "Я", displayNameOverride: null, privateChatAvailable: false },
      ],
      home: [
        { workspaceId: "home", userId: 10, role: "member", status: "active", username: "anna", displayName: "Анна", telegramDisplayName: "Анна", displayNameOverride: null, privateChatAvailable: true },
        { workspaceId: "home", userId: 40, role: "owner", status: "active", username: "max", displayName: "Максим", telegramDisplayName: "Максим", displayNameOverride: null, privateChatAvailable: true },
      ],
    },
    reminders: {
      team: [
        reminder("team", "meters", "Передать показания"),
        reminder("team", "water", "Заказать воду", { status: "paused", assignment: { mode: "person", responsibleUserId: 99 } }),
      ],
      home: [
        reminder("home", "flowers", "Полить цветы", {
          visibility: "private",
          assignment: { mode: "person", responsibleUserId: 10 },
        }),
      ],
    },
    occurrences: {
      team: [
        occurrence("internet", "Оплатить интернет", { kind: "payment" }),
        occurrence("passport", "Забрать паспорт", { status: "overdue", assignment: { mode: "person", responsibleUserId: 20 } }),
      ],
      home: [],
    },
    requests: [],
  };
}

function workspaceId(request: Request): string | null {
  return request.headers()["x-workspace-id"] ?? null;
}

async function installTelegramAndApi(page: Page, state: ApiState): Promise<void> {
  await installTelegram(page);
  const topicConnections = new Map<string, { link: string; name: string }>();
  const groupConnections = new Map<string, string>();

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const selected = workspaceId(request);
    const postData = request.postData();
    const body = postData ? JSON.parse(postData) as Record<string, unknown> : null;
    state.requests.push({
      method,
      path,
      workspaceId: selected,
      initData: request.headers()["x-telegram-init-data"] ?? null,
      body,
    });

    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (method === "GET" && path === "/api/workspaces") {
      if ((state.workspaceDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.workspaceDelayMs));
      }
      if ((state.workspaceFailuresRemaining ?? 0) > 0) {
        state.workspaceFailuresRemaining = (state.workspaceFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "Temporary failure", code: "temporary_failure" }, 503);
      }
      return fulfill({ workspaces: state.workspaces });
    }
    if (path.startsWith("/api/group-connections")) {
      if ((state.groupConnectionFailuresRemaining ?? 0) > 0) { state.groupConnectionFailuresRemaining!--; return fulfill({ error: "Ответ не получен", code: "temporary_failure" }, 503); }
      const id = method === "POST" && path === "/api/group-connections" ? String(body?.clientRequestId) : path.split("/")[3];
      if (body?.launchMode) groupConnections.set(id, String(body.launchMode));
      const connectionState = state.groupConnectionState ?? "pending";
      if (connectionState === "connected" && state.groupWorkspace && !state.workspaces.some((item) => item.workspaceId === state.groupWorkspace!.workspaceId)) state.workspaces.push(state.groupWorkspace);
      return fulfill({ connectionId: id, state: connectionState, expiresAt: "2099-01-01T00:00:00Z", workspaceId: state.groupWorkspace?.workspaceId,
        fallbackUrl: "https://t.me/example_bot?start=connect_group", ...(groupConnections.get(id) === "native" ? { preparedButtonId: "prepared-group-choice" } : {}) });
    }
    if (!selected || !state.members[selected]) {
      return fulfill({ error: "Workspace not found", code: "not_found" }, 404);
    }
    if (method === "GET" && path === "/api/topics") {
      if ((state.topicsFailuresRemaining ?? 0) > 0) {
        state.topicsFailuresRemaining!--;
        return fulfill({ error: "Temporary failure" }, 503);
      }
      return fulfill({ topics: state.topics?.[selected] ?? [] });
    }
    if (path.startsWith("/api/topic-connections")) {
      const id = method === "POST" ? String(body?.clientRequestId) : path.split("/")[3];
      if (method === "POST") {
        if (state.topicConnectionError) return fulfill({ error: state.topicConnectionError, code: "invalid_topic_link" }, 400);
        topicConnections.set(id, { link: String(body?.link), name: String(body?.name) });
        if ((state.topicConnectionFailuresRemaining ?? 0) > 0) { state.topicConnectionFailuresRemaining!--; return route.abort("failed"); }
        await state.topicConnectionGate;
      }
      const topic = { messageThreadId: 62, name: topicConnections.get(id)?.name ?? "Тренировки", isClosed: false };
      const connectionState = state.topicConnectionState ?? "succeeded";
      if (connectionState === "succeeded") {
        state.topics ??= {};
        state.topics[selected] = [...(state.topics[selected] ?? []).filter((item) => item.messageThreadId !== topic.messageThreadId), topic];
      }
      return fulfill({ connectionId: id, state: connectionState, expiresAt: "2099-01-01T00:00:00Z", messageThreadId: topic.messageThreadId, name: topic.name });
    }
    if (method === "GET" && path === "/api/members") {
      if ((state.memberFailuresRemaining ?? 0) > 0) {
        state.memberFailuresRemaining = (state.memberFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "Temporary failure", code: "temporary_failure" }, 503);
      }
      return fulfill({ members: state.members[selected] });
    }
    if (method === "GET" && /^\/api\/members\/\d+\/avatar$/.test(path)) {
      return fulfill({ avatar: avatarPng });
    }
    if (method === "POST" && path === "/api/members/sync") {
      return fulfill({ members: state.members[selected], synced: state.members[selected].length });
    }
    if (method === "POST" && path === "/api/members/publish-enrollment") {
      return fulfill({ published: true });
    }
    if (method === "PATCH" && path === "/api/workspace/settings") {
      const workspace = state.workspaces.find((item) => item.workspaceId === selected)!;
      Object.assign(workspace, body);
      return fulfill({ workspace });
    }
    if (method === "POST" && path === "/api/workspace/transfer-ownership") {
      const workspace = state.workspaces.find((item) => item.workspaceId === selected)!;
      const targetUserId = Number(body?.targetUserId);
      const previousOwner = state.members[selected].find((item) => item.role === "owner")!;
      const nextOwner = state.members[selected].find((item) => item.userId === targetUserId)!;
      previousOwner.role = "organizer";
      nextOwner.role = "owner";
      workspace.ownerUserId = targetUserId;
      workspace.role = "organizer";
      return fulfill({ workspace });
    }
    if (method === "GET" && path === "/api/reminders") {
      return fulfill({ reminders: state.reminders[selected] });
    }
    if (method === "GET" && path === "/api/dashboard") {
      if ((state.dashboardFailuresRemaining ?? 0) > 0) {
        state.dashboardFailuresRemaining = (state.dashboardFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "Temporary failure", code: "temporary_failure" }, 503);
      }
      return fulfill({ occurrences: state.occurrences[selected].filter((item) => item.status === "pending" || item.status === "overdue") });
    }
    if (method === "GET" && path === "/api/history") {
      if ((state.historyDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.historyDelayMs));
      }
      if ((state.historyFailuresRemaining ?? 0) > 0) {
        state.historyFailuresRemaining = (state.historyFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "History query failed", code: "history_unavailable" }, 500);
      }
      const occurrences = state.occurrences[selected]
        .filter((item) => item.status === "completed" || item.status === "cancelled")
        .sort((left, right) => new Date(
          right.completedAt ?? right.cancelledAt ?? right.updatedAt ?? right.dueAt,
        ).getTime() - new Date(
          left.completedAt ?? left.cancelledAt ?? left.updatedAt ?? left.dueAt,
        ).getTime());
      return fulfill({ occurrences });
    }
    if (method === "POST" && path === "/api/reminders") {
      await state.createGate;
      if ((state.createFailuresRemaining ?? 0) > 0) {
        state.createFailuresRemaining = (state.createFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "Temporary failure", code: "temporary_failure" }, 503);
      }
      const created = reminder(selected, `created-${state.reminders[selected].length}`, String(body?.title), {
        ...(body as Partial<ApiReminder>),
        workspaceId: selected,
        creatorUserId: 10,
      });
      state.reminders[selected].unshift(created);
      if (state.createResponseNeverArrives) return;
      return fulfill({ reminder: created }, 201);
    }
    const updateMatch = path.match(/^\/api\/reminders\/([^/]+)$/);
    if (method === "PATCH" && updateMatch) {
      const item = state.reminders[selected].find((candidate) =>
        candidate.reminderId === updateMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      Object.assign(item, body, { version: item.version + 1, updatedAt: now });
      return fulfill({ reminder: item });
    }
    const roleMatch = path.match(/^\/api\/members\/(\d+)\/role$/);
    if (method === "PATCH" && roleMatch) {
      const member = state.members[selected].find((item) => item.userId === Number(roleMatch[1]));
      if (!member) return fulfill({ error: "Not found" }, 404);
      member.role = body?.role as Role;
      return fulfill({ member });
    }
    const displayNameMatch = path.match(/^\/api\/members\/(\d+)\/display-name$/);
    if (method === "PATCH" && displayNameMatch) {
      const member = state.members[selected].find((item) =>
        item.userId === Number(displayNameMatch[1]));
      if (!member) return fulfill({ error: "Not found" }, 404);
      member.displayNameOverride = body?.displayName as string | null;
      member.displayName = member.displayNameOverride ?? member.telegramDisplayName;
      return fulfill({ member });
    }
    const reassignMatch = path.match(/^\/api\/reminders\/([^/]+)\/reassign$/);
    if (method === "POST" && reassignMatch) {
      const item = state.reminders[selected].find((candidate) => candidate.reminderId === reassignMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      item.assignment = { mode: "person", responsibleUserId: Number(body?.responsibleUserId) };
      item.status = "active";
      return fulfill({ reminder: item });
    }
    const lifecycleMatch = path.match(/^\/api\/reminders\/([^/]+)\/(pause|resume|archive)$/);
    if (method === "POST" && lifecycleMatch) {
      const item = state.reminders[selected].find((candidate) => candidate.reminderId === lifecycleMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      item.status = lifecycleMatch[2] === "archive"
        ? "archived"
        : lifecycleMatch[2] === "pause" ? "paused" : "active";
      return fulfill({ reminder: item });
    }
    const actionMatch = path.match(/^\/api\/occurrences\/([^/]+)\/(complete|snooze|undo-completion)$/);
    if (method === "POST" && actionMatch) {
      const item = state.occurrences[selected].find((candidate) => candidate.occurrenceId === actionMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      if (actionMatch[2] === "complete") {
        const completedAt = new Date(state.completionAt ?? Date.now());
        item.status = "completed";
        item.undoUntil ??= new Date(completedAt.getTime() + 10 * 60 * 1000).toISOString();
        item.completedBy = 10;
        item.completedByDisplayName = "Анна";
        item.completedAt = completedAt.toISOString();
      }
      if (actionMatch[2] === "undo-completion" && state.undoErrorCode) {
        return fulfill({ error: "Undo window expired", code: state.undoErrorCode }, 409);
      }
      if (actionMatch[2] === "undo-completion") {
        item.status = "pending";
        item.undoUntil = null;
      }
      if (actionMatch[2] === "snooze") {
        await state.snoozeResponseGate;
        const effectiveAt = state.snoozeEffectiveAt ?? "2026-08-27T05:00:00.000Z";
        item.nextNotificationAt = effectiveAt;
        item.snoozeUntil = effectiveAt;
        return fulfill({
          occurrence: item,
          snooze: {
            requestedAt: state.snoozeRequestedAt,
            effectiveAt,
            adjustedForQuietHours: state.snoozeAdjustedForQuietHours ?? false,
            timezone: item.timezone,
          },
        });
      }
      return fulfill({ occurrence: item });
    }
    const occurrenceUpdateMatch = path.match(/^\/api\/occurrences\/([^/]+)$/);
    if (method === "PATCH" && occurrenceUpdateMatch) {
      const item = state.occurrences[selected].find((candidate) => candidate.occurrenceId === occurrenceUpdateMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      Object.assign(item, body, { updatedAt: new Date().toISOString() });
      const notificationPolicy = body?.notificationPolicy as Record<string, unknown> | undefined;
      if (notificationPolicy && notificationPolicy.leadMinutes !== null) {
        item.leadMinutes = Number(notificationPolicy.leadMinutes);
      }
      if (notificationPolicy?.repeatIntervalMinutes != null) {
        item.repeatIntervalMinutes = Number(notificationPolicy.repeatIntervalMinutes);
      }
      if (notificationPolicy?.ignoreQuietHours != null) {
        item.ignoreQuietHours = Boolean(notificationPolicy.ignoreQuietHours);
      }
      return fulfill({ occurrence: item });
    }
    return fulfill({ error: `Unhandled E2E route: ${method} ${path}` }, 501);
  });
}

async function installTelegram(page: Page): Promise<void> {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.addInitScript(() => {
    const backHandlers = new Set<() => void>();
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: {
        WebApp: {
          initData: "e2e-init-data",
          initDataUnsafe: { user: { id: Number(localStorage.getItem("e2e.actorId") ?? 10), first_name: "Анна" } },
          ready() {},
          expand() {},
          BackButton: {
            show() {},
            hide() {},
            onClick(handler: () => void) { backHandlers.add(handler); },
            offClick(handler: () => void) { backHandlers.delete(handler); },
            trigger() { backHandlers.forEach((handler) => handler()); },
          },
          themeParams: {},
          showAlert() {},
        },
      },
    });
  });
}

async function openApp(page: Page, state: ApiState): Promise<void> {
  await installTelegramAndApi(page, state);
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Выбранная группа" })).toHaveValue("team");
}

async function checkRecoveryActionViewports(page: Page, name: string, outputPath: (name: string) => string, precedingBlock?: Locator, followingBlock?: Locator) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 20, top: 12 } });
  for (const width of [320, 412]) for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 568 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const action = page.getByRole("button", { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab");
    await action.focus();
    await expect(action).toBeFocused();
    await expect(action).toHaveCSS("outline-style", "solid");
    const bounds = (await action.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(548);
    if (precedingBlock) {
      const previous = (await precedingBlock.boundingBox())!;
      const outlineInset = await action.evaluate((element) => {
        const style = getComputedStyle(element);
        return Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
      });
      expect(bounds.y - outlineInset).toBeGreaterThanOrEqual(previous.y + previous.height);
      if (followingBlock) {
        const next = (await followingBlock.boundingBox())!;
        expect(bounds.y + bounds.height + outlineInset).toBeLessThanOrEqual(next.y);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: outputPath(`recovery-${width}-${colorScheme}.png`) });
  }
}

test("isolates data when switching between groups", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  await expect(page.getByLabel("ZvenFit")).toBeVisible();
  const heading = page.getByRole("heading", { name: "Требует внимания" });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeLessThanOrEqual(40);
  await expect(page.getByText("Линия внимания")).toHaveCount(0);
  expect(state.requests[0]?.initData).toBe("e2e-init-data");
  const createButton = page.getByRole("button", { name: "Новое напоминание" });
  await expect(createButton).toBeEnabled();
  expect(await createButton.evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
  await page.getByRole("button", { name: "План", exact: true }).click();
  await expect(page.getByText("Передать показания")).toBeVisible();
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "План", exact: true }).click();
  await expect(page.getByText("Полить цветы")).toBeVisible();
  await expect(page.getByText("Передать показания")).toHaveCount(0);
  expect(state.requests.filter((item) => item.path !== "/api/workspaces").at(-1)?.workspaceId)
    .toBe("home");
});

test("shows the nearest plan date across series regardless of API order", async ({ page }) => {
  const state = createState();
  state.reminders.team = [
    reminder("team", "later", "Поздняя серия", {
      schedule: {
        version: 1,
        frequency: "monthly",
        startDate: "2026-01-01",
        interval: 1,
        timing: { kind: "timed", timeLocal: "18:00" },
        day: { type: "dayOfMonth", value: 20, overflow: "lastDay" },
      },
    }),
    reminder("team", "nearer", "Ближняя серия", {
      schedule: {
        version: 1,
        frequency: "monthly",
        startDate: "2026-01-01",
        interval: 1,
        timing: { kind: "timed", timeLocal: "18:00" },
        day: { type: "dayOfMonth", value: 5, overflow: "lastDay" },
      },
    }),
  ];
  await page.clock.install({ time: new Date("2026-09-01T09:00:00.000Z") });
  await openApp(page, state);

  await expect(page.getByText(/Ближайшее · 5 сент/)).toBeVisible();
  await expect(page.getByText(/Ближайшее · 20 сент/)).toHaveCount(0);
});

test("shows a Telegram launch recovery screen without calling the API", async ({ page }) => {
  let apiRequests = 0;
  await page.route("https://telegram.org/js/telegram-web-app.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/**", (route) => {
    apiRequests += 1;
    return route.fulfill({ status: 500, json: { error: "API must not be called" } });
  });

  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("Попробуйте обновить");
  await expect(page.getByRole("button", { name: "Обновить" })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Открыть чат с ботом/ }))
    .toHaveAttribute("href", "https://t.me/zvenfit_reminder_bot?start=panel");
  await expect(page.getByRole("button", { name: /Закрыть/ })).toHaveCount(0);
  await expect(page.getByText("Missing X-Telegram-Init-Data")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Новое напоминание" })).toHaveCount(0);
  expect(apiRequests).toBe(0);
});

test("keeps the first screen readable at the 320px Telegram width", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.setViewportSize({ width: 320, height: 700 });

  await expect(page.getByRole("heading", { name: "Требует внимания" })).toBeVisible();
  const headingSize = await page.getByRole("heading", { name: "Требует внимания" })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(headingSize).toBeLessThanOrEqual(22);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const headerBox = await page.locator(".home-header").boundingBox();
  expect(headerBox?.width ?? 321).toBeLessThanOrEqual(288);

  await page.getByRole("button", { name: "План", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keeps revised supporting copy readable and primary actions AA-contrasted", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page, state);

  const homeCopySizes = await page.locator(
    ".bottom-navigation button, .rail-signal > span, .rail-signal > small",
  ).evaluateAll((elements) => elements.map((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...homeCopySizes)).toBeGreaterThanOrEqual(12);

  await page.getByRole("button", { name: "Новое напоминание" }).click();
  const darkPrimaryContrast = await page.getByRole("button", { name: "Создать поручение" })
    .evaluate((element) => {
      const channels = (value: string) => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
      const luminance = (value: string) => {
        const [red = 0, green = 0, blue = 0] = channels(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);
    });
  expect(darkPrimaryContrast).toBeGreaterThanOrEqual(4.5);

  const formCopySizes = await page.locator(
    ".form-preview__plan dt, .form-preview__plan dd, .form-submit-bar small",
  ).evaluateAll((elements) => elements.map((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...formCopySizes)).toBeGreaterThanOrEqual(12);

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const lightSecondaryContrast = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const channels = (value: string) => value.match(/[\da-f]{2}/giu)?.map((channel) =>
      Number.parseInt(channel, 16)) ?? [];
    const luminance = (value: string) => {
      const [red = 0, green = 0, blue = 0] = channels(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = luminance(root.getPropertyValue("--ink-faint").trim());
    const background = luminance(root.getPropertyValue("--canvas").trim());
    return (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05);
  });
  expect(lightSecondaryContrast).toBeGreaterThanOrEqual(4.5);
});

test("keeps custom lead and currency controls usable at supported mobile sizes", async ({ page }) => {
  const state = createState();
  await installTelegramAndApi(page, state);

  for (const scenario of [
    { width: 320, theme: "light" as const },
    { width: 320, theme: "dark" as const },
    { width: 412, theme: "light" as const },
    { width: 412, theme: "dark" as const },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 700 });
    await page.emulateMedia({ colorScheme: scenario.theme, reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Выбранная группа" })).toHaveValue("team");
    await page.getByRole("button", { name: "Новое напоминание" }).click();
    await page.getByRole("radio", { name: /Платёж/ }).click();
    await page.getByText("Дополнительные настройки", { exact: true }).click();

    const controls = [
      page.getByRole("spinbutton", { name: "Сумма" }),
      page.getByRole("combobox", { name: "Валюта" }),
      page.getByRole("spinbutton", { name: "Количество до срока" }),
      page.getByRole("combobox", { name: "Единица первого сигнала" }),
    ];
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }
});

test("shows the dashboard structure while the initial workspace is loading", async ({ page }) => {
  const state = createState();
  state.workspaceDelayMs = 500;
  await installTelegramAndApi(page, state);

  for (const scenario of [
    { width: 320, theme: "light" as const, reducedMotion: "no-preference" as const },
    { width: 320, theme: "dark" as const, reducedMotion: "no-preference" as const },
    { width: 412, theme: "light" as const, reducedMotion: "no-preference" as const },
    { width: 412, theme: "dark" as const, reducedMotion: "reduce" as const },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 700 });
    await page.emulateMedia({
      colorScheme: scenario.theme,
      reducedMotion: scenario.reducedMotion,
    });
    await page.goto("/");

    const loadingStatus = page.getByRole("status");
    await expect(loadingStatus).toHaveText("Загружаем рабочее пространство");
    await expect(page.locator(".initial-skeleton__workspace-copy")).toBeVisible();
    await expect(page.locator(".skeleton-rail--initial > i")).toHaveCount(2);
    await expect(page.locator(".initial-skeleton__navigation > i")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await expect(page.getByRole("combobox", { name: "Выбранная группа" })).toHaveValue("team");
    await expect(loadingStatus).toHaveCount(0);
  }
});

test("retries a failed dashboard load from the contextual error", async ({ page }) => {
  const state = createState();
  // Keep the service unavailable through bootstrap; recover at the user's retry.
  state.dashboardFailuresRemaining = 2;
  await installTelegramAndApi(page, state);

  await page.goto("/");

  const requestAlert = page.getByRole("alert");
  await expect(requestAlert).toContainText("Задачи временно не загрузились");
  await expect(page.getByText("3 участника")).toBeVisible();
  await expect(page.getByText("Сейчас тихо")).toHaveCount(0);
  const retryAction = requestAlert.getByRole("button", { name: "Загрузить данные" });
  await expect(retryAction).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const retryColors = await retryAction.evaluate((button) => {
    const icon = button.querySelector(".ui-icon");
    return {
      button: getComputedStyle(button).color,
      icon: icon ? getComputedStyle(icon).color : "missing",
      stroke: icon ? getComputedStyle(icon).stroke : "missing",
    };
  });
  expect(retryColors.icon).toBe(retryColors.button);
  expect(retryColors.stroke).toBe(retryColors.button);
  state.dashboardFailuresRemaining = 0;
  await retryAction.click();

  await expect(page.getByText("Забрать паспорт")).toBeVisible();
  await expect(requestAlert).toHaveCount(0);
});

test("recovers from a stalled workspace request in short light and dark viewports", async ({ page }) => {
  const state = createState();
  await installTelegramAndApi(page, state);
  await page.clock.install();
  let stalled = true;
  let requests = 0;
  await page.route("**/api/workspaces", async (route) => {
    requests += 1;
    if (!stalled) await route.fallback();
  });

  for (const width of [320, 412]) {
    for (const colorScheme of ["light", "dark"] as const) {
      stalled = true;
      const requestsBefore = requests;
      await page.setViewportSize({ width, height: 520 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/");
      await expect(page.getByRole("status")).toHaveText("Загружаем рабочее пространство");
      await expect.poll(() => requests).toBeGreaterThanOrEqual(requestsBefore + 2);
      await page.clock.fastForward(20_001);

      await expect(page.getByRole("alert")).toContainText("Сервис долго не отвечает");
      await expect(page.locator(".app--initial-loading")).toHaveCount(0);
      const retry = page.getByRole("button", { name: "Обновить", exact: true });
      await expect(retry).toBeEnabled();
      await retry.focus();
      await expect(retry).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      const retryBounds = (await retry.boundingBox())!;
      const botLinkBounds = (await page.getByRole("link", { name: "Открыть чат с ботом" }).boundingBox())!;
      expect(botLinkBounds.x >= retryBounds.x + retryBounds.width + 8 ||
        botLinkBounds.y >= retryBounds.y + retryBounds.height + 8).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`timeout-${width}-${colorScheme}.png`) });

      stalled = false;
      await retry.click();
      await expect(page.getByText("Забрать паспорт")).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
  }
});

test("shows partial data and retries when the dashboard request stalls", async ({ page }) => {
  const state = createState();
  await installTelegramAndApi(page, state);
  await page.clock.install();
  let stalled = true;
  let requests = 0;
  await page.route("**/api/dashboard", async (route) => {
    requests += 1;
    if (!stalled) await route.fallback();
  });

  await page.goto("/");
  await expect.poll(() => requests).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(20_001);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Задачи временно не загрузились");
  await expect(page.getByText("3 участника")).toBeVisible();
  await expect(page.getByText("Сейчас тихо")).toHaveCount(0);

  stalled = false;
  await alert.getByRole("button", { name: "Загрузить данные" }).click();
  await expect(page.getByText("Забрать паспорт")).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("opens tasks while history is stalled and lets history recover independently", async ({ page }) => {
  const state = createState();
  await installTelegramAndApi(page, state);
  await page.clock.install();
  let stalled = true;
  await page.route("**/api/history", async (route) => {
    if (!stalled) await route.fallback();
  });

  await page.goto("/");
  await expect(page.getByText("Забрать паспорт")).toBeVisible();
  await expect(page.getByText("3 участника")).toBeVisible();
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.locator(".history-list.skeleton-list")).toBeVisible();
  await expect(page.getByText("История пока пуста")).toHaveCount(0);

  await page.clock.fastForward(20_001);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("История временно недоступна");
  stalled = false;
  await alert.getByRole("button", { name: "Загрузить историю" }).click();
  await expect(page.getByText("История пока пуста")).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("keeps tasks and members available when history temporarily fails", async ({ page }) => {
  const state = createState();
  // Vite's StrictMode runs the initial effect twice in E2E development mode.
  state.historyFailuresRemaining = 2;
  await openApp(page, state);

  await expect(page.getByText("Забрать паспорт")).toBeVisible();
  await expect(page.getByText("3 участника")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "История", exact: true }).click();
  const historyAlert = page.getByRole("alert");
  const retryAction = historyAlert.getByRole("button", { name: "Загрузить историю" });
  await expect(historyAlert).toContainText("История временно недоступна");
  await expect(retryAction).toBeVisible();
  expect(await historyAlert.evaluate((element) => Number.parseFloat(getComputedStyle(element).gap)))
    .toBeGreaterThanOrEqual(12);
  const requestsBeforeRetry = state.requests.length;
  const historyRequestsBeforeRetry = state.requests.filter((request) =>
    request.path === "/api/history").length;
  state.historyFailuresRemaining = 0;
  await retryAction.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("История пока пуста")).toBeVisible();
  const retryRequests = state.requests.slice(requestsBeforeRetry);
  expect(retryRequests).toHaveLength(1);
  expect(retryRequests[0]?.path).toBe("/api/history");
  expect(state.requests.filter((request) => request.path === "/api/history")).toHaveLength(
    historyRequestsBeforeRetry + 1,
  );
});

test("settles an in-flight history retry when switching groups", async ({ page }) => {
  const state = createState();
  // Vite's StrictMode runs the initial effect twice in E2E development mode.
  state.historyFailuresRemaining = 2;
  await openApp(page, state);

  await page.getByRole("button", { name: "История", exact: true }).click();
  const retryAction = page.getByRole("alert")
    .getByRole("button", { name: "Загрузить историю" });
  await expect(retryAction).toBeVisible();

  state.historyDelayMs = 500;
  state.historyFailuresRemaining = 0;
  const historyRequestsBeforeRetry = state.requests.filter((request) =>
    request.path === "/api/history").length;
  await retryAction.click();
  await expect.poll(() => state.requests.filter((request) =>
    request.path === "/api/history").length).toBe(historyRequestsBeforeRetry + 1);

  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "История", exact: true }).click();

  await expect(page.getByText("История пока пуста")).toBeVisible();
  await expect(page.locator(".history-list.skeleton-list")).toHaveCount(0);
});

test("recovers from an empty workspace response without leaving disabled controls", async ({ page }) => {
  const state = createState();
  const teamWorkspace = state.workspaces[0]!;
  state.workspaces = [];
  await installTelegramAndApi(page, state);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Подключить группу" })).toBeVisible();
  await expect(page.getByText("Для аккаунта Анна")).toBeVisible();
  await expect(page.getByRole("button", { name: "Новое напоминание" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Обновить список групп" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1))
    .toBe(true);
  const initialWorkspaceRequests = state.requests.filter((request) =>
    request.path === "/api/workspaces").length;

  state.workspaces.push(teamWorkspace);
  await page.getByRole("button", { name: "Обновить список групп" }).click();

  await expect(page.getByText(teamWorkspace.displayName, { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Выбранная группа" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Новое напоминание" })).toBeEnabled();
  expect(state.requests.filter((request) => request.path === "/api/workspaces").length)
    .toBeGreaterThan(initialWorkspaceRequests);
});

test("offers refresh instead of a dead close action when workspace loading fails", async ({ page }) => {
  const state = createState();
  state.workspaceFailuresRemaining = 2;
  await installTelegramAndApi(page, state);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Попробуйте ещё раз" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Обновить" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Закрыть/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Обновить" }).click();

  await expect(page.getByRole("combobox", { name: "Выбранная группа" })).toHaveValue("team");
  expect(state.workspaceFailuresRemaining).toBe(0);
});

test("manages verified members and publishes self-enrollment to the selected group", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  await page.getByRole("button", { name: /Участники/ }).click();

  await expect(page.getByRole("heading", { name: "Кто может отвечать" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Подтверждённые участники" })).toContainText("Анна");
  await expect(page.getByRole("list", { name: "Подтверждённые участники" })).toContainText("Иван");
  await page.getByRole("button", { name: "Позвать" }).click();
  await expect(page.getByText("Отправить сообщение в «Команда»?")).toBeVisible();
  await page.getByRole("button", { name: "Да, позвать" }).click();

  expect(state.requests.find((request) =>
    request.method === "POST" && request.path === "/api/members/publish-enrollment"))
    .toMatchObject({ workspaceId: "team" });
  await expect(page.getByText("Приглашение отправлено в группу")).toBeVisible();

  state.members.team.push({
    workspaceId: "team",
    userId: 50,
    role: "member",
    status: "active",
    username: "olga",
    displayName: "Ольга",
    telegramDisplayName: "Ольга",
    displayNameOverride: null,
    privateChatAvailable: true,
  });
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("list", { name: "Подтверждённые участники" })).toContainText("Ольга");
  await expect(page.getByText("Новых участников: 1")).toBeVisible();
});

test("retries a failed member refresh without leaving the roster", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: /Участники/ }).click();
  state.memberFailuresRemaining = 1;

  await page.getByRole("button", { name: "Обновить", exact: true }).click();

  const requestAlert = page.getByRole("alert");
  await expect(requestAlert).toContainText("Сервис временно не отвечает");
  await expect(page.getByRole("list", { name: "Подтверждённые участники" }))
    .toContainText("Анна");
  await requestAlert.getByRole("button", { name: "Обновить список" }).click();

  await expect(requestAlert).toHaveCount(0);
  await expect(page.getByText("Список уже актуален")).toBeVisible();
});

test("renames a member only inside the selected workspace and keeps the Telegram identity", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page, state);
  await page.getByRole("button", { name: /Участники/ }).click();

  const editName = page.getByRole("button", { name: "Переименовать Я" });
  const editNameBox = await editName.boundingBox();
  expect(editNameBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(editNameBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await editName.click();
  await expect(page.getByText("Telegram-профиль останется «Я».")).toBeVisible();
  await page.getByLabel("Имя в этой группе").fill("Алексей Тренер");
  await page.getByRole("button", { name: "Сохранить" }).click();

  const roster = page.getByRole("list", { name: "Подтверждённые участники" });
  await expect(roster).toContainText("Алексей Тренер");
  await expect(roster).toContainText("Telegram: Я");
  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/members/30/display-name"))
    .toMatchObject({ workspaceId: "team", body: { displayName: "Алексей Тренер" } });
  expect(state.members.home.some((member) => member.displayName === "Алексей Тренер")).toBe(false);

  await page.getByLabel("Найти участника").fill("Я");
  await expect(roster).toContainText("Алексей Тренер");
  await page.getByRole("button", { name: "Переименовать Алексей Тренер" }).click();
  const editor = page.locator(".member-name-editor");
  await expect(editor.getByRole("button")).toHaveCount(3);
  const editorLayout = await editor.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      buttons: [...element.querySelectorAll("button")].map((button) => {
        const buttonBounds = button.getBoundingClientRect();
        return {
          left: buttonBounds.left - bounds.left,
          right: buttonBounds.right - bounds.left,
          height: buttonBounds.height,
        };
      }),
    };
  });
  // The focused input halo may add up to 3px of visual overflow inside the panel.
  expect(editorLayout.scrollWidth).toBeLessThanOrEqual(editorLayout.clientWidth + 3);
  for (const button of editorLayout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(editorLayout.clientWidth + 1);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Как в Telegram" }).click();
  await expect(roster).toContainText("Я");
  await expect(page.getByText("Имя из Telegram восстановлено")).toBeVisible();
});

test("uses explicit 24-hour time fields", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const time = page.getByRole("textbox", { name: "Время" });
  await expect(time).toHaveAttribute("type", "text");
  await time.fill("1845");
  await expect(time).toHaveValue("18:45");
  await expect(page.getByText(/AM|PM/)).toHaveCount(0);
});

test("shows and focuses an inline title error without submitting whitespace", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const title = page.locator("#reminder-title");
  await title.fill("   ");
  await page.getByRole("button", { name: "Создать поручение" }).click();

  await expect(page.locator("#reminder-title-error")).toHaveText("Напишите, что нужно сделать.");
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  expect(state.requests.some((request) =>
    request.method === "POST" && request.path === "/api/reminders")).toBe(false);
});

test("builds schedule defaults in the workspace timezone across midnight", async ({ page }) => {
  const state = createState();
  await page.clock.install({ time: new Date("2026-08-30T21:30:00.000Z") });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await expect(page.locator("#reminder-date")).toHaveAttribute("type", "text");
  await expect(page.locator("#reminder-date")).toHaveValue("01.09.2026");
  await expect(page.locator("#reminder-date-native")).toHaveValue("2026-09-01");
  await expect(page.locator("#reminder-date-native")).toHaveAttribute("min", "2026-08-31");

  await page.getByRole("radio", { name: "По неделям" }).click();
  await expect(page.locator("#reminder-start-date")).toHaveValue("31.08.2026");
  await expect(page.locator("#reminder-start-date-native")).toHaveValue("2026-08-31");
  const weekdays = page.locator("#reminder-weekdays");
  await expect(weekdays.getByRole("button", { name: "Пн" })).toHaveAttribute("aria-pressed", "true");
  await expect(weekdays.getByRole("button", { name: "Вс" })).toHaveAttribute("aria-pressed", "false");
});

test("keeps an impossible DD.MM.YYYY draft visible and rejects it inline", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.locator("#reminder-title").fill("Проверить календарь");

  const date = page.locator("#reminder-date");
  const dateControl = page.locator(".calendar-date-control").filter({ has: date });
  const dateLayerGeometry = await dateControl.evaluate((control) => {
    const text = control.querySelector<HTMLInputElement>(".calendar-date-control__text")!;
    const picker = control.querySelector<HTMLElement>(".calendar-date-control__picker")!;
    const native = control.querySelector<HTMLInputElement>(".calendar-date-control__native")!;
    return [text, picker, native].map((element) => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
    });
  });
  for (const layer of dateLayerGeometry.slice(1)) {
    expect(Math.abs(layer.top - dateLayerGeometry[0].top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(layer.bottom - dateLayerGeometry[0].bottom)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(layer.height - dateLayerGeometry[0].height)).toBeLessThanOrEqual(0.5);
  }
  await date.fill("31.02.2027");
  await page.getByRole("button", { name: "Создать поручение" }).click();

  await expect(date).toHaveValue("31.02.2027");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#reminder-date-error")).toHaveText("Такой даты не существует.");
  const nativePicker = page.locator("#reminder-date-native");
  await expect(nativePicker).toHaveAttribute("aria-invalid", "true");
  await expect(nativePicker).toHaveAttribute("aria-describedby", "reminder-date-error");
  await expect.poll(() => dateControl.evaluate((control) => {
    const text = control.querySelector<HTMLElement>(".calendar-date-control__text")!;
    const picker = control.querySelector<HTMLElement>(".calendar-date-control__picker")!;
    const textBorder = getComputedStyle(text).borderTopColor;
    return getComputedStyle(picker).borderLeftColor === textBorder &&
      getComputedStyle(picker).color === textBorder;
  })).toBe(true);
  await expect(date).toBeFocused();
  expect(state.requests.some((request) =>
    request.method === "POST" && request.path === "/api/reminders")).toBe(false);
});

test("matches interval units and limits and rejects an impossible yearly date", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const interval = page.locator("#reminder-interval");
  const intervalUnit = page.locator(".interval-input b");
  for (const width of [320, 412]) {
    await page.setViewportSize({ width, height: 700 });
    const frequencyLayout = await page.locator(".frequency-strip").evaluate((strip) => {
      const stripBounds = strip.getBoundingClientRect();
      const chips = [...strip.querySelectorAll<HTMLElement>(".frequency-chip")]
        .map((chip) => chip.getBoundingClientRect());
      return {
        clientWidth: strip.clientWidth,
        scrollWidth: strip.scrollWidth,
        stripCenter: stripBounds.left + stripBounds.width / 2,
        widths: chips.map((chip) => chip.width),
        heights: chips.map((chip) => chip.height),
        lastCenter: chips.at(-1)!.left + chips.at(-1)!.width / 2,
      };
    });
    expect(frequencyLayout.scrollWidth).toBeLessThanOrEqual(frequencyLayout.clientWidth);
    expect(Math.max(...frequencyLayout.widths) - Math.min(...frequencyLayout.widths))
      .toBeLessThanOrEqual(1);
    expect(Math.min(...frequencyLayout.heights)).toBeGreaterThanOrEqual(44);
    expect(Math.abs(frequencyLayout.lastCenter - frequencyLayout.stripCenter)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 320, height: 700 });

  await page.getByRole("radio", { name: "Ежедневно" }).click();
  const intervalStyle = await interval.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      appearance: style.appearance,
      fontFamily: style.fontFamily,
      fontVariantNumeric: style.fontVariantNumeric,
    };
  });
  expect(intervalStyle.appearance).toBe("textfield");
  expect(intervalStyle.fontFamily).toContain("IBM Plex Mono");
  expect(intervalStyle.fontVariantNumeric).toContain("tabular-nums");
  for (const scenario of [
    { frequency: "Ежедневно", maximum: "365", unit: "день" },
    { frequency: "По неделям", maximum: "52", unit: "неделя" },
    { frequency: "По месяцам", maximum: "120", unit: "месяц" },
    { frequency: "По годам", maximum: "20", unit: "год" },
  ]) {
    await page.getByRole("radio", { name: scenario.frequency }).click();
    await expect(interval).toHaveAttribute("min", "1");
    await expect(interval).toHaveAttribute("max", scenario.maximum);
    await expect(intervalUnit).toHaveText(scenario.unit);
  }

  const yearlyDay = page.getByRole("spinbutton", { name: "День" });
  const yearlyDayStyle = await yearlyDay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      appearance: style.appearance,
      fontFamily: style.fontFamily,
      fontVariantNumeric: style.fontVariantNumeric,
    };
  });
  expect(yearlyDayStyle.appearance).toBe("textfield");
  expect(yearlyDayStyle.fontFamily).toContain("IBM Plex Mono");
  expect(yearlyDayStyle.fontVariantNumeric).toContain("tabular-nums");
  await yearlyDay.fill("31");
  await page.getByRole("combobox", { name: "Месяц" }).selectOption("2");

  await expect(yearlyDay).toHaveAttribute("max", "29");
  await expect(yearlyDay).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#reminder-yearly-date-error"))
    .toHaveText("Для выбранного месяца допустимо от 1 до 29.");

  await page.getByRole("radio", { name: "Ежедневно" }).click();
  await page.locator("#reminder-title").fill("Проверить интервал");
  await interval.fill("0");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  const intervalError = page.locator("#reminder-interval-error");
  const intervalHint = page.locator("#reminder-interval-hint");
  await expect(interval).toHaveAttribute(
    "aria-describedby",
    "reminder-interval-error reminder-interval-hint",
  );
  await expect(intervalError).toContainText("Введите целое число от 1 до 365");
  const [errorBox, hintBox] = await Promise.all([
    intervalError.boundingBox(),
    intervalHint.boundingBox(),
  ]);
  expect(errorBox!.y).toBeLessThan(hintBox!.y);
});

test("keeps an invalid time draft visible and explains the valid range inline", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await page.locator("#reminder-title").fill("Проверить расписание");
  const time = page.locator("#reminder-time");
  await time.fill("25:00");
  await page.getByRole("button", { name: "Создать поручение" }).click();

  await expect(time).toHaveValue("25:00");
  await expect(time).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Введите время от 00:00 до 23:59", { exact: true })).toBeVisible();
  expect(state.requests.some((request) =>
    request.method === "POST" && request.path === "/api/reminders")).toBe(false);
});

test("opens additional settings and focuses an invalid payment link", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByRole("radio", { name: "Платёж" }).click();
  await page.locator("#reminder-title").fill("Оплатить подписку");

  const details = page.locator("details.additional-fields").filter({ has: page.getByText("Дополнительные настройки", { exact: true }) });
  await details.getByText("Дополнительные настройки", { exact: true }).click();
  const actionUrl = page.locator("#reminder-action-url");
  await actionUrl.fill("http://example.com/pay");
  await details.getByText("Дополнительные настройки", { exact: true }).click();
  await expect(details).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "Создать платёж" }).click();
  await expect(details).toHaveAttribute("open", "");
  await expect(page.locator("#reminder-action-url-error"))
    .toHaveText("Для оплаты нужна безопасная ссылка, которая начинается с https://.");
  await expect(actionUrl).toBeFocused();
  expect(state.requests.some((request) =>
    request.method === "POST" && request.path === "/api/reminders")).toBe(false);
});

test("explains how the quiet-hours switch changes signal delivery", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const switchControl = page.locator('input[aria-describedby="quiet-hours-behavior"]');
  const behavior = page.locator("#quiet-hours-behavior");
  await expect(switchControl).not.toBeChecked();
  await expect(behavior).toHaveText("Сигналы с 22:00 до 08:00 будут перенесены на 08:00.");

  await switchControl.check();
  await expect(behavior).toHaveText("Сигналы будут приходить и с 22:00 до 08:00.");
});

test("disables quiet-hours delivery when the group has no quiet period", async ({ page }) => {
  const state = createState();
  state.workspaces[0].quietHoursStart = "00:00";
  state.workspaces[0].quietHoursEnd = "00:00";
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const switchControl = page.locator('input[aria-describedby="quiet-hours-behavior"]');
  await expect(switchControl).toBeDisabled();
  await expect(switchControl).not.toBeChecked();
  await expect(page.locator("#quiet-hours-behavior")).toHaveText("Тихие часы в группе выключены.");
  await expect(page.getByLabel("Предпросмотр напоминания"))
    .toContainText("Тихие часы в группе выключены.");
});

test("keeps weekly targets touch-sized without horizontal overflow at 320px", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByRole("radio", { name: "По неделям" }).click();

  const targetSizes = await page.locator("#reminder-weekdays button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
  expect(targetSizes).toHaveLength(7);
  expect(Math.min(...targetSizes.map((target) => target.width))).toBeGreaterThanOrEqual(44);
  expect(Math.min(...targetSizes.map((target) => target.height))).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("separates the deadline from notification policy in the form preview", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await expect(page.getByRole("heading", { name: "Как часто появляется новый срок?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Как напоминать об открытом сроке?" })).toBeVisible();
  const calendarIcon = page.locator(".calendar-date-control__picker");
  await calendarIcon.scrollIntoViewIfNeeded();
  const calendarTarget = await page.locator("#reminder-date-native").boundingBox();
  expect(calendarTarget?.width).toBeGreaterThanOrEqual(44);
  expect(calendarTarget?.height).toBeGreaterThanOrEqual(44);
  expect(await calendarIcon.evaluate((icon) => {
    const bounds = icon.getBoundingClientRect();
    return document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    )?.id;
  })).toBe("reminder-date-native");
  await page.getByLabel("Дата", { exact: true }).fill("15.08.2099");
  await page.getByRole("combobox", { name: "Единица первого сигнала" }).selectOption("days");
  await page.getByRole("spinbutton", { name: "Количество до срока" }).fill("5");
  await page.getByRole("combobox", { name: "Повтор сигнала", exact: true }).selectOption("180");

  const preview = page.getByLabel("Предпросмотр напоминания");
  await expect(preview).toContainText("Ритм задачи");
  await expect(preview).toContainText("Это один отдельный срок");
  await expect(preview).toContainText("За 5 дн до срока");
  await expect(preview).toContainText("Ритм сигналов");
  await expect(preview).toContainText("Каждые 3 часа — до отметки «Выполнено» для этого срока");
  await expect(preview).toContainText("22:00–08:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Проверить договор");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  expect(state.requests.find((request) =>
    request.method === "POST" && request.path === "/api/reminders"))
    .toMatchObject({
      body: {
        schedule: { frequency: "once", date: "2099-08-15" },
        notificationPolicy: { leadMinutes: 7_200, repeatIntervalMinutes: 180 },
      },
    });
});

test("explains recurring task scope before and after completion", async ({ page }) => {
  const state = createState();
  state.reminders.team.unshift(reminder("team", "internet", "Оплатить интернет", {
    kind: "payment",
    schedule: {
      version: 1,
      frequency: "daily",
      startDate: "2026-08-14",
      interval: 1,
      timing: { kind: "timed", timeLocal: "15:00" },
    },
  }));
  state.completionAt = "2026-08-14T13:00:00.000Z";
  await page.clock.install({ time: new Date("2026-08-14T13:00:00.000Z") });
  await openApp(page, state);

  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });
  await expect(card).toContainText("Каждый день · 15:00");
  await expect(card).toContainText("Это один срок серии");
  await card.getByRole("button", { name: "Отметить этот срок оплаченным" }).click();

  const confirmation = page.getByRole("status").filter({ hasText: "Этот срок оплачен" });
  await expect(confirmation).toContainText("Следующий срок: 15 авг. · 15:00");
  await expect(confirmation).toContainText("Можно отменить в течение 10 минут");
});

test("names task rhythm and signal rhythm independently for a recurring form", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await page.getByRole("radio", { name: "Ежедневно" }).click();
  await page.getByRole("combobox", { name: "Повтор сигнала", exact: true }).selectOption("720");
  await expect(page.getByText("Каждый новый срок нужно закрывать отдельно.")).toBeVisible();
  await expect(page.getByText(/Каждая задача серии живёт отдельно/)).toBeVisible();

  const preview = page.getByLabel("Предпросмотр напоминания");
  await expect(preview).toContainText("Каждый срок серии закрывается отдельно");
  await expect(preview).toContainText("Ритм задачи");
  await expect(preview).toContainText("Каждый день · 09:00");
  await expect(preview).toContainText("Ритм сигналов");
  await expect(preview).toContainText("Каждые 12 часов");
  await expect(preview).toContainText("до отметки «Выполнено» для этого срока");
});

test("shows an immediate effective first signal when the selected lead is already past", async ({ page }) => {
  const state = createState();
  await page.clock.install({ time: new Date("2026-08-26T10:30:00.000Z") });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await page.getByLabel("Дата", { exact: true }).fill("26.08.2026");
  await page.getByRole("textbox", { name: "Время" }).fill("14:00");
  await page.getByRole("spinbutton", { name: "Количество до срока" }).fill("1");

  const preview = page.getByLabel("Предпросмотр напоминания");
  await expect(preview).toContainText("Сразу после сохранения");
  await expect(preview).toContainText("выбранное время уже прошло");
  await expect(preview).not.toContainText("За 1 час до срока");
});

test("creates a payment with payment-specific fields and semantics", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await page.getByRole("radio", { name: /Платёж/ }).click();
  await expect(page.getByRole("textbox", { name: "Что нужно оплатить" })).toBeVisible();
  await page.getByText("Дополнительные настройки", { exact: true }).click();
  const amount = page.getByRole("spinbutton", { name: /Сумма/ });
  const currency = page.getByRole("combobox", { name: "Валюта" });
  await expect(amount).toHaveValue("");
  await expect(currency).toHaveValue("RUB");
  await expect(currency.getByRole("option", { name: /\$ · USD/ })).toHaveCount(1);
  const amountStyle = await amount.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      appearance: style.appearance,
      fontFamily: style.fontFamily,
      fontVariantNumeric: style.fontVariantNumeric,
    };
  });
  expect(amountStyle.appearance).toBe("textfield");
  expect(amountStyle.fontFamily).toContain("IBM Plex Mono");
  expect(amountStyle.fontVariantNumeric).toContain("tabular-nums");

  const details = page.locator("textarea");
  const initialDetailsHeight = (await details.boundingBox())!.height;
  await details.fill("Строка 1\nСтрока 2\nСтрока 3\nСтрока 4\nСтрока 5\nСтрока 6");
  const expandedDetailsHeight = (await details.boundingBox())!.height;
  expect(expandedDetailsHeight).toBeGreaterThan(initialDetailsHeight);
  await expect(details).toHaveCSS("resize", "none");
  await expect(page.getByRole("heading", { name: "Как часто появляется новый срок?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Как напоминать об открытом сроке?" })).toBeVisible();

  await page.getByRole("textbox", { name: "Что нужно оплатить" }).fill("Домашний интернет");
  await amount.fill("890.50");
  await currency.selectOption("USD");
  await page.getByRole("textbox", { name: /Ссылка на оплату/ }).fill("https://example.com/pay");
  await page.getByRole("button", { name: "Создать платёж" }).click();

  expect(state.requests.find((item) =>
    item.method === "POST" && item.path === "/api/reminders"))
    .toMatchObject({
      body: {
        kind: "payment",
        amountMinor: 89_050,
        currency: "USD",
        actionUrl: "https://example.com/pay",
        schedule: { frequency: "once" },
      },
    });
});

test("keeps a reminder draft for a deliberate retry after a failed create", async ({ page }) => {
  const state = createState();
  state.createFailuresRemaining = 1;
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const title = page.getByRole("textbox", { name: "Что нужно сделать" });
  const createAction = page.getByRole("button", { name: "Создать поручение" });
  await title.fill("Заказать корм коту");
  await createAction.click();

  const requestAlert = page.getByRole("alert");
  await expect(requestAlert).toContainText("Сервис временно не отвечает");
  await expect(requestAlert.getByRole("button")).toHaveCount(0);
  await expect(title).toHaveValue("Заказать корм коту");
  await expect(createAction).toBeEnabled();

  await createAction.click();
  await expect(page.getByText("Заказать корм коту")).toBeVisible();
  await expect(requestAlert).toHaveCount(0);
});

test("returns from the member roster without losing a reminder draft", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  const title = page.getByRole("textbox", { name: "Что нужно сделать" });
  await title.fill("Сверить расписание");

  await page.getByRole("button", { name: "Участники группы" }).click();
  await expect(page.getByRole("heading", { name: "Кто может отвечать" })).toBeVisible();
  await page.getByRole("button", { name: "Назад" }).click();

  await expect(page.getByRole("heading", { name: "О чём не дать забыть?" })).toBeVisible();
  await expect(title).toHaveValue("Сверить расписание");
});

test("shows Telegram-style avatars in the participant selector", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  const selector = page.getByRole("button", { name: "Ответственный" });
  await expect(selector).toContainText("Анна");
  await selector.click();

  const ivan = page.getByRole("option", { name: /Иван/ });
  await expect(ivan).toBeVisible();
  await expect(ivan.locator("img")).toBeVisible();
  await ivan.click();
  await expect(selector).toContainText("Иван");
  expect(state.requests.some((request) =>
    request.method === "GET" && request.path === "/api/members/20/avatar"))
    .toBe(true);
});

test("supports arrow-key navigation in tabs, radio groups, and the participant selector", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  const mine = page.getByRole("tab", { name: "Моя лента" });
  const group = page.getByRole("tab", { name: "Вся группа" });
  await mine.focus();
  await page.keyboard.press("ArrowRight");
  await expect(group).toBeFocused();
  await expect(group).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Новое напоминание" }).click();
  const task = page.getByRole("radio", { name: /Поручение/ });
  const payment = page.getByRole("radio", { name: /Платёж/ });
  await task.focus();
  await page.keyboard.press("ArrowRight");
  await expect(payment).toBeFocused();
  await expect(payment).toHaveAttribute("aria-checked", "true");

  const selector = page.getByRole("button", { name: "Ответственный" });
  await selector.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Участники группы" })
    .getByRole("option").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(selector).toBeFocused();
});

test("lets a member create only a personal reminder for themselves", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await expect(page.getByRole("radio", { name: /Групповое/ })).toBeDisabled();
  await expect(page.locator(".choice-card.is-selected")).toContainText("Личное");
  await expect(page.getByRole("button", { name: "Ответственный" })).toContainText("Анна");

  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Купить лекарство");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByText("Купить лекарство")).toBeVisible();
  expect(state.requests.find((item) => item.method === "POST" && item.path === "/api/reminders"))
    .toMatchObject({ workspaceId: "home", body: { visibility: "private" } });
});

test("snoozes, completes, and undoes an occurrence", async ({ page }) => {
  const state = createState();
  let releaseSnoozeResponse!: () => void;
  state.snoozeResponseGate = new Promise<void>((resolve) => {
    releaseSnoozeResponse = resolve;
  });
  state.snoozeRequestedAt = "2026-08-27T04:00:00.000Z";
  state.snoozeEffectiveAt = "2026-08-27T05:00:00.000Z";
  state.snoozeAdjustedForQuietHours = true;
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "Напомнить позже" }).click();
  const dialog = page.getByRole("dialog", { name: "Напомнить позже" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Быстрый выбор времени" }))
    .toContainText("Через час");
  await expect(dialog.getByRole("button", { name: /Завтра утром/ }))
    .toContainText(/завтра|августа/);

  await dialog.getByRole("button", { name: /Через час/ }).click();
  try {
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByRole("button", { name: "Закрыть выбор времени" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /Завтра утром/ })).toBeDisabled();
    await expect(dialog.getByRole("status")).toContainText("Сохраняем новое время");
  } finally {
    releaseSnoozeResponse();
  }
  await expect(dialog).toHaveCount(0);
  const confirmation = page.getByRole("status");
  await expect(confirmation).toContainText("Тихие часы перенесли сигнал с");
  await expect(confirmation).toContainText("07:00");
  await expect(confirmation).toContainText("08:00");
  expect(state.requests.filter((request) =>
    request.method === "POST" && request.path === "/api/occurrences/internet/snooze"))
    .toEqual([expect.objectContaining({
      body: { type: "preset", preset: "one_hour" },
    })]);

  await card.getByRole("button", { name: "Отметить оплату" }).click();
  await expect(page.getByText("Можно отменить в течение 10 минут")).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByText("Оплатить интернет")).toBeVisible();
});

test("uses one accessible snooze picker in Tasks and closes it with Telegram Back", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page, state);
  const trigger = page.getByRole("article")
    .filter({ hasText: "Оплатить интернет" })
    .getByRole("button", { name: "Напомнить позже" });

  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Напомнить позже" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.evaluate(() => {
    (window as unknown as {
      Telegram: { WebApp: { BackButton: { trigger(): void } } };
    }).Telegram.WebApp.BackButton.trigger();
  });

  await expect(page.getByRole("dialog", { name: "Напомнить позже" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.requests.some((request) => request.path.endsWith("/snooze"))).toBe(false);
});

test("submits a custom local date and time from occurrence detail", async ({ page }) => {
  const state = createState();
  let releaseSnoozeResponse!: () => void;
  state.snoozeResponseGate = new Promise<void>((resolve) => {
    releaseSnoozeResponse = resolve;
  });
  await page.clock.install({ time: new Date("2026-08-30T09:00:00.000Z") });
  await page.setViewportSize({ width: 412, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page, state);

  await page.getByRole("button", { name: /Оплатить интернет/ }).click();
  await page.getByRole("button", { name: "Напомнить позже" }).click();
  const dialog = page.getByRole("dialog", { name: "Напомнить позже" });
  await dialog.getByRole("button", { name: /Выбрать дату и время/ }).click();
  const dateInput = dialog.getByLabel("Дата", { exact: true });
  const nativeDateInput = dialog.locator("#snooze-custom-date-native");
  const customDate = await nativeDateInput.getAttribute("max");
  expect(customDate).not.toBeNull();
  await dateInput.fill("30.09.2026");
  await dialog.getByRole("textbox", { name: "Время следующего сигнала" }).focus();
  await expect(dialog.getByText("Выберите дату не позже 29.09.2026."))
    .toBeVisible();
  await dateInput.fill("01.10.2026");
  await expect(dialog.getByText("Выберите дату не позже 29.09.2026."))
    .toBeVisible();
  await nativeDateInput.fill(customDate!);
  await expect(dateInput).toHaveValue(
    customDate!.split("-").reverse().join("."),
  );
  await expect(dialog.getByText("Выберите дату не позже 29.09.2026."))
    .toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Время следующего сигнала" }).fill("17:45");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const confirmCustomTime = dialog.getByRole("button", { name: "Напомнить в это время" });
  await confirmCustomTime.click();
  try {
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dateInput).toBeDisabled();
    await expect(nativeDateInput).toBeDisabled();
    const disabledDateStyle = await dateInput.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        cursor: style.cursor,
        opacity: style.opacity,
        textFill: style.getPropertyValue("-webkit-text-fill-color"),
      };
    });
    expect(disabledDateStyle.cursor).toBe("not-allowed");
    expect(disabledDateStyle.opacity).toBe("1");
    expect(disabledDateStyle.textFill).toBe(disabledDateStyle.color);
    await expect(dialog.locator(".calendar-date-control__picker"))
      .toHaveCSS("cursor", "not-allowed");
  } finally {
    releaseSnoozeResponse();
  }

  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((request) =>
    request.method === "POST" && request.path === "/api/occurrences/internet/snooze"))
    .toMatchObject({
      body: { type: "custom", localDate: customDate, localTime: "17:45" },
    });
});

test("opens one calm detail screen with deadline, next signal, and actions", async ({ page }) => {
  const state = createState();
  const passport = state.occurrences.team.find((item) => item.occurrenceId === "passport")!;
  passport.nextNotificationAt = "2027-01-01T06:00:00.000Z";
  await page.setViewportSize({ width: 412, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page, state);

  await page.getByRole("tab", { name: "Вся группа" }).click();
  const card = page.getByRole("article").filter({ hasText: "Забрать паспорт" });
  await expect(card.locator(".rail-signal b")).toContainText("2027");
  await expect(card.locator(".rail-signal b")).toContainText("09:00");
  await card.getByRole("button", { name: /Забрать паспорт/ }).click();

  await expect(page.getByRole("heading", { name: "Забрать паспорт" })).toBeVisible();
  await expect(page.getByText(/Просрочено на/).first()).toBeVisible();
  await expect(page.getByText("Следующий сигнал", { exact: true })).toBeVisible();
  await expect(page.locator(".detail-fact--signal b")).toContainText("2027");
  await expect(page.locator(".detail-fact--signal b")).toContainText("09:00");
  await expect(page.locator(".detail-fact--signal small")).toContainText("С учётом тихих часов");
  await expect(page.getByRole("button", { name: "Отметить выполнение" })).toBeVisible();
});

test("updates a relative next signal when its scheduled instant passes", async ({ page }) => {
  const state = createState();
  await page.clock.install({ time: new Date("2026-08-26T09:00:00.000Z") });
  const internet = state.occurrences.team.find((item) => item.occurrenceId === "internet")!;
  internet.nextNotificationAt = "2026-08-26T09:00:20.000Z";
  await openApp(page, state);

  const signal = page.getByRole("article").filter({ hasText: "Оплатить интернет" })
    .locator(".rail-signal small");
  await expect(signal).toContainText("Через 1 мин");
  await page.clock.fastForward(30_001);
  await expect(signal).toContainText("Ожидает отправки");
});

test("shows three concrete future dates for a recurring plan", async ({ page }) => {
  const state = createState();
  const target = state.reminders.team.find((item) => item.reminderId === "meters")!;
  target.schedule = {
    version: 1,
    frequency: "monthly",
    startDate: "2026-01-01",
    timing: { kind: "timed", timeLocal: "19:00" },
    interval: 1,
    day: { type: "dayOfMonth", value: 25, overflow: "lastDay" },
  };
  await openApp(page, state);

  await page.getByRole("button", { name: "План", exact: true }).click();
  const row = page.getByRole("article").filter({ hasText: "Передать показания" });
  await expect(row.getByLabel("Три ближайших срока").locator("span")).toHaveCount(3);
  await row.getByRole("button", { name: /Передать показания/ }).click();
  await expect(page.getByText("Ближайшие сроки", { exact: true })).toBeVisible();
});

test("edits only one current occurrence without changing the series", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.reminderId = "meters";
  item.kind = "task";
  item.title = "Передать показания сейчас";
  item.timezone = "Europe/Berlin";
  item.escalation = { enabled: true, delayMinutes: 90, repeatMinutes: 180 };
  await openApp(page, state);

  await page.getByRole("button", { name: /Передать показания сейчас/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByRole("radio", { name: /Только этот срок/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { name: "Когда нужно выполнить" })).toBeVisible();
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Передать показания сегодня");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();

  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/occurrences/internet"))
    .toMatchObject({
      body: {
        title: "Передать показания сегодня",
        dueLocalDate: expect.any(String),
        timezone: "Europe/Berlin",
        notificationPolicy: {
          escalation: { enabled: true, delayMinutes: 90, repeatMinutes: 180 },
        },
      },
    });
  expect(state.reminders.team.find((reminder) => reminder.reminderId === "meters")?.title)
    .toBe("Передать показания");
});

test("keeps occurrence editing stable when its date is cleared", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.reminderId = "meters";
  item.kind = "task";
  item.title = "Проверить дату отдельного срока";
  await openApp(page, state);

  await page.getByRole("button", { name: /Проверить дату отдельного срока/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  const date = page.locator("#reminder-occurrence-date");
  await date.fill("");

  await expect(page.getByLabel("Предпросмотр напоминания")).toContainText("Выберите дату срока");
  await expect(page.getByRole("radio", { name: /Только этот срок/ })).toContainText("Дата не выбрана");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();
  await expect(page.locator("#reminder-occurrence-date-error")).toHaveText("Выберите дату срока.");
  await expect(date).toBeFocused();
});

test("keeps occurrence and series edit drafts isolated", async ({ page }) => {
  const state = createState();
  state.topics = { team: [{ messageThreadId: 42, name: "Оплаты", isClosed: false }, { messageThreadId: 52, name: "Показания", isClosed: false }] };
  state.reminders.team[0].messageThreadId = 52;
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.reminderId = "meters";
  item.kind = "payment";
  item.messageThreadId = 42;
  item.title = "Разовый платёж за счётчики";
  item.amountMinor = 2_500;
  item.currency = "RUB";
  item.assignment = { mode: "person", responsibleUserId: 10 };
  item.watcherUserIds = [30];
  item.leadMinutes = 1_440;
  item.repeatIntervalMinutes = 180;
  item.ignoreQuietHours = true;
  await openApp(page, state);

  await page.getByRole("button", { name: /Разовый платёж за счётчики/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("42");
  const occurrenceTitle = page.getByRole("textbox", { name: "Что нужно оплатить" });
  await expect(occurrenceTitle).toHaveValue("Разовый платёж за счётчики");
  await expect(page.getByRole("spinbutton", { name: "Количество до срока" }))
    .toHaveValue("1");
  await expect(page.getByRole("combobox", { name: "Единица первого сигнала" }))
    .toHaveValue("days");
  await page.getByText("Добавить наблюдателей", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Я/ })).toBeChecked();
  await occurrenceTitle.fill("Черновик только этого платежа");
  await page.getByRole("spinbutton", { name: "Количество до срока" }).fill("7");

  await page.getByRole("radio", { name: /Этот и следующие/ }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("52");
  await expect(page.getByRole("textbox", { name: "Что нужно сделать" }))
    .toHaveValue("Передать показания");
  await expect(page.getByRole("spinbutton", { name: "Количество до срока" }))
    .toHaveValue("0");
  await expect(page.getByRole("combobox", { name: "Единица первого сигнала" }))
    .toHaveValue("hours");
  await expect(page.getByRole("checkbox", { name: /Анна/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Я/ })).not.toBeChecked();
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Серия показаний без утечки");

  await page.getByRole("radio", { name: /Только этот срок/ }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("42");
  await expect(page.getByRole("textbox", { name: "Что нужно оплатить" }))
    .toHaveValue("Черновик только этого платежа");
  await expect(page.getByRole("spinbutton", { name: "Количество до срока" }))
    .toHaveValue("7");
  await expect(page.getByRole("combobox", { name: "Единица первого сигнала" }))
    .toHaveValue("days");

  await page.getByRole("radio", { name: /Этот и следующие/ }).click();
  await page.getByRole("button", { name: "Сохранить серию" }).click();

  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/reminders/meters"))
    .toMatchObject({
      body: {
        kind: "task",
        title: "Серия показаний без утечки",
        watcherUserIds: [10],
        notificationPolicy: {
          leadMinutes: 0,
          repeatIntervalMinutes: 360,
          ignoreQuietHours: false,
        },
      },
    });
});

test("requires a concrete lead before moving a legacy occurrence deadline", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.reminderId = "meters";
  item.title = "Старый срок без lead policy";
  item.leadMinutes = null;
  item.reminderStartAt = "2026-08-14T09:00:00.000Z";
  await openApp(page, state);

  await page.getByRole("button", { name: /Старый срок без lead policy/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.locator("#reminder-occurrence-date")).toHaveValue("14.08.2026");
  const lead = page.getByRole("combobox", { name: "Первый сигнал", exact: true });
  await expect(lead).toHaveValue("preserve");
  await expect(lead.getByRole("option", { name: /Не менять/ })).toContainText("12:00");

  await page.getByLabel("Дата", { exact: true }).fill("15.08.2026");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();
  await expect(page.getByRole("alert")).toContainText(/выберите, когда отправить первый сигнал/i);
  expect(state.requests.some((request) =>
    request.method === "PATCH" && request.path === "/api/occurrences/internet")).toBe(false);

  await lead.selectOption("hours");
  await page.getByRole("spinbutton", { name: "Количество до срока" }).fill("1");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();
  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/occurrences/internet"))
    .toMatchObject({
      body: {
        dueLocalDate: "2026-08-15",
        notificationPolicy: { leadMinutes: 60 },
      },
    });
});

test("keeps an all-day occurrence all-day when editing only that deadline", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.reminderId = "meters";
  item.title = "Сверить документы за день";
  item.dueAt = "2026-08-28T20:59:59.999Z";
  item.dueLocalDate = "2026-08-28";
  item.allDay = true;
  item.reminderStartAt = "2026-08-28T06:00:00.000Z";
  await page.clock.install({ time: new Date("2026-08-27T10:00:00.000Z") });
  await page.setViewportSize({ width: 412, height: 700 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page, state);

  await page.getByRole("button", { name: /Сверить документы за день/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  const allDay = page.getByRole("checkbox", { name: /Весь день/ });
  await expect(allDay).toBeChecked();
  await expect(page.getByLabel("Предпросмотр напоминания")).toContainText("В день срока, в 09:00");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();

  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/occurrences/internet"))
    .toMatchObject({
      body: {
        dueLocalDate: "2026-08-28",
        timing: { kind: "allDay" },
      },
    });
});

test("keeps completed and cancelled facts in an auditable history", async ({ page }) => {
  const state = createState();
  state.occurrences.team.push(occurrence("meters-july", "Передать очень длинные показания по всем счётчикам клуба", {
    reminderId: "meters",
    status: "completed",
    dueAt: "2026-07-12T10:00:00.000Z",
    completedBy: 20,
    completedByDisplayName: "Иван",
    completedAt: "2026-08-20T12:30:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-20T12:30:00.000Z",
    assignment: { mode: "person", responsibleUserId: 10 },
  }));
  state.occurrences.team.push(occurrence("meters-cancelled", "Отменить дублирующее напоминание", {
    reminderId: "meters",
    status: "cancelled",
    dueAt: "2026-08-25T10:00:00.000Z",
    cancelledBy: 10,
    cancelledAt: "2026-08-19T09:00:00.000Z",
    cancellationReason: "reminder_archived",
    updatedAt: "2026-08-19T09:00:00.000Z",
    assignment: { mode: "person", responsibleUserId: 20 },
  }));
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page, state);

  await page.getByRole("button", { name: "История", exact: true }).click();
  const rows = page.locator(".history-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Передать очень длинные показания");
  await expect(rows.nth(0)).toContainText("Выполнение отмечено: Иван");
  await expect(rows.nth(0)).toContainText("Ответственный: Анна");
  await expect(rows.nth(1)).toContainText("Повтор отменён: Анна");
  await expect(rows.nth(1)).toContainText("Ответственный: Иван");
  await expect(rows.nth(1)).not.toContainText("reminder_archived");
  await expect(rows.nth(1)).not.toContainText("Причина:");
  const longTitle = rows.nth(0).locator(".history-row__copy > b");
  expect(await longTitle.evaluate((element) => ({
    lineClamp: getComputedStyle(element).webkitLineClamp,
    overflow: getComputedStyle(element).overflow,
  }))).toEqual({ lineClamp: "none", overflow: "visible" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await rows.nth(0).click();
  await expect(page.getByText("История этого повтора", { exact: true })).toBeVisible();
  await expect(page.getByText(/Выполнение отметил/)).toBeVisible();
  await expect(page.getByText(/Иван/).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Отметить выполнение" })).toHaveCount(0);
  await page.getByRole("button", { name: "Назад" }).click();

  await page.locator(".history-row").nth(1).click();
  await expect(page.getByText("Причина: Серия архивирована")).toBeVisible();
  await expect(page.getByText(/reminder_archived/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Напомнить позже" })).toHaveCount(0);
});

test("hides Undo when its completion window expires", async ({ page }) => {
  const state = createState();
  const completionAt = "2026-08-30T12:00:00.000Z";
  state.completionAt = completionAt;
  await page.clock.install({ time: new Date(completionAt) });
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });
  const undo = page.getByRole("button", { name: "Отменить" });

  await card.getByRole("button", { name: "Отметить оплату" }).click();
  await expect(undo).toBeVisible();
  await page.clock.fastForward(10 * 60 * 1000 + 1);
  await expect(undo).toHaveCount(0);
});

test("dismisses stale Undo after the server rejects it", async ({ page }) => {
  const state = createState();
  state.undoErrorCode = "undo_expired";
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "Отметить оплату" }).click();
  await page.getByRole("button", { name: "Отменить" }).click();

  await expect(page.getByRole("button", { name: "Отменить" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Отменить выполнение уже нельзя: прошло 10 минут.");
});

test("reassigns a paused reminder and manages organizer access", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("tab", { name: "Вся группа" }).click();

  const paused = page.getByRole("article").filter({ hasText: "Заказать воду" });
  await paused.getByRole("combobox", { name: /Новый ответственный/ }).selectOption("20");
  await paused.getByRole("button", { name: "Переназначить" }).click();
  await expect(page.getByText("Ответственный изменён, напоминание снова активно")).toBeVisible();
  await expect(paused.getByText("Ответственный вышел")).toHaveCount(0);

  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await page.getByRole("button", { name: /Участники/ }).click();
  await page.getByRole("combobox", { name: "Роль: Иван" }).selectOption("organizer");
  await expect(page.getByText("Доступ организатора выдан")).toBeVisible();
});

test("pauses, resumes, and archives a reminder series", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("tab", { name: "Вся группа" }).click();
  const row = page.getByRole("article").filter({ hasText: "Передать показания" });

  await row.getByRole("button", { name: /Передать показания/ }).click();
  await page.getByRole("button", { name: "Поставить на паузу" }).click();
  await expect(page.getByText("Серия приостановлена")).toBeVisible();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByText("Серия продолжена")).toBeVisible();
  await page.getByRole("button", { name: "Архивировать" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("останутся в истории");
  await page.getByRole("alertdialog").getByRole("button", { name: "Архивировать" }).click();
  await expect(page.getByText("Серия завершена")).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("edits the current and future definition of a reminder series", async ({ page }) => {
  const state = createState();
  const target = state.reminders.team.find((item) => item.reminderId === "meters")!;
  target.kind = "payment";
  target.actionUrl = "https://example.com/context";
  target.amountMinor = 1250;
  target.currency = "USD";
  target.notificationPolicy = {
    leadMinutes: 0,
    repeatIntervalMinutes: 360,
    ignoreQuietHours: false,
    escalation: { enabled: false },
  };
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("tab", { name: "Вся группа" }).click();
  const row = page.getByRole("article").filter({ hasText: "Передать показания" });

  await row.getByRole("button", { name: /Передать показания/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByRole("heading", { name: "Что изменить?" })).toBeVisible();
  await page.getByText("Дополнительные настройки", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Валюта" })).toHaveValue("USD");
  await page.getByRole("textbox", { name: "Что нужно оплатить" }).fill("Передать новые показания");
  await page.getByRole("button", { name: "Сохранить серию" }).click();

  await expect(page.getByText("Передать новые показания")).toBeVisible();
  expect(state.requests.find((item) =>
    item.method === "PATCH" && item.path === "/api/reminders/meters"))
    .toMatchObject({
      workspaceId: "team",
      body: {
        kind: "payment",
        title: "Передать новые показания",
        actionUrl: "https://example.com/context",
        currency: "USD",
        notificationPolicy: { escalation: { enabled: false } },
      },
    });
});

test("keeps the creator actions after the creator becomes an ordinary member", async ({ page }) => {
  const state = createState();
  state.workspaces[0].role = "member";
  state.members.team[0].role = "member";
  state.occurrences.team = [occurrence("meters", "Передать показания", {
    assignment: { mode: "person", responsibleUserId: 20 },
  })];
  await openApp(page, state);

  const card = page.getByRole("article").filter({ hasText: "Передать показания" }).first();
  await expect(card.getByRole("button", { name: "Отметить выполнение" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Напомнить позже" })).toBeVisible();
});

test("does not offer occurrence actions to an unrelated ordinary member", async ({ page }) => {
  const state = createState();
  state.workspaces[0].role = "member";
  state.members.team[0].role = "member";
  state.occurrences.team = [occurrence("foreign", "Чужое поручение", {
    assignment: { mode: "person", responsibleUserId: 20 },
  })];
  await openApp(page, state);
  await page.getByRole("tab", { name: "Вся группа" }).click();
  const card = page.getByRole("article").filter({ hasText: "Чужое поручение" });

  await expect(card.getByRole("button", { name: "Отметить выполнение" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Напомнить позже" })).toHaveCount(0);
});

test("updates group rhythm and confirms ownership transfer", async ({ page }) => {
  const state = createState();
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page, state);

  await page.getByRole("button", { name: /Ритм группы/ }).click();
  await expect(page.getByRole("heading", { name: "Когда можно звенеть" })).toBeVisible();
  const timezonePreview = page.locator(".timezone-preview");
  await expect(timezonePreview).toContainText("Москва");
  await expect(timezonePreview).toContainText("UTC+3");
  for (const scenario of [
    { width: 320, theme: "dark" as const },
    { width: 412, theme: "light" as const },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 700 });
    await page.emulateMedia({ colorScheme: scenario.theme });
    const previewLayout = await timezonePreview.evaluate((preview) => {
      const city = preview.querySelector<HTMLElement>(".timezone-preview__place b")!
        .getBoundingClientRect();
      const badge = preview.querySelector<HTMLElement>(".timezone-preview__default")!
        .getBoundingClientRect();
      const overlaps = city.left < badge.right && city.right > badge.left &&
        city.top < badge.bottom && city.bottom > badge.top;
      return { overlaps };
    });
    expect(previewLayout.overlaps).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }
  const timezone = page.getByLabel("Город или часовой пояс");
  await timezone.fill("Mars/Olympus");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.locator("#workspace-timezone-error"))
    .toHaveText("Выберите корректный город или часовой пояс IANA.");
  await expect(timezone).toBeFocused();
  expect(state.requests.some((request) =>
    request.method === "PATCH" && request.path === "/api/workspace/settings")).toBe(false);
  await timezone.fill("Asia/Yekaterinburg");
  await expect(timezonePreview).toContainText("Екатеринбург");
  await expect(timezonePreview).toContainText("UTC+5");
  await page.getByLabel("Начало тишины").fill("23:00");
  await page.getByLabel("Конец тишины").fill("07:30");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.getByText("Ритм группы обновлён")).toBeVisible();
  expect(state.workspaces[0]).toMatchObject({
    timezone: "Asia/Yekaterinburg",
    quietHoursStart: "23:00",
    quietHoursEnd: "07:30",
  });

  await page.getByLabel("Новый владелец").selectOption("20");
  await page.getByRole("button", { name: "Передать управление" }).click();
  await expect(page.getByText("Передать управление участнику «Иван»?")).toBeVisible();
  await page.getByRole("button", { name: "Да, передать" }).click();
  await expect(page.getByText("Владелец группы изменён")).toBeVisible();
  expect(state.workspaces[0]).toMatchObject({ ownerUserId: 20, role: "organizer" });
  expect(state.members.team.find((member) => member.userId === 20)?.role).toBe("owner");
});

test("updates the live timezone clock and allows equal quiet-hour boundaries", async ({ page }) => {
  const state = createState();
  await page.clock.install({ time: new Date("2026-08-30T12:00:00.000Z") });
  await openApp(page, state);
  await page.getByRole("button", { name: /Ритм группы/ }).click();

  const currentTime = page.locator(".timezone-preview__clock b");
  await expect(currentTime).toHaveText("15:00");
  await page.clock.fastForward(60_000);
  await expect(currentTime).toHaveText("15:01");

  const quietStart = page.getByLabel("Начало тишины");
  const quietEnd = page.getByLabel("Конец тишины");
  const rhythmMap = page.locator(".rhythm-map");
  await quietStart.fill("08:00");
  await quietEnd.fill("22:00");
  await expect(rhythmMap).toHaveClass(/rhythm-map--same-day/);
  expect(await page.locator(".rhythm-map__night").evaluate((night) =>
    getComputedStyle(night, "::after").display)).toBe("none");

  await quietEnd.fill("08:00");
  await expect(rhythmMap).toHaveClass(/rhythm-map--disabled/);
  await expect(page.getByText("Одинаковое время выключает тихие часы для всей группы."))
    .toBeVisible();
  await page.getByRole("button", { name: "Сохранить настройки" }).click();

  await expect(page.getByText("Ритм группы обновлён")).toBeVisible();
  expect(state.workspaces[0]).toMatchObject({
    quietHoursStart: "08:00",
    quietHoursEnd: "08:00",
  });
});

test("warns before assigning a personal reminder to a user without a private chat", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByRole("radio", { name: /Личное/ }).click();
  await page.getByRole("button", { name: "Ответственный" }).click();
  await page.getByRole("option", { name: /Я/ }).click();
  await expect(page.getByText(/Я сначала отправил боту \/start/)).toBeVisible();
});

test("keeps a reminder created in the built-in preview mode", async ({ page }) => {
  await installTelegram(page);
  await page.goto("/?mock=1");
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await expect(page.getByRole("button", { name: "Ответственный" })).toContainText("Анна");
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Купить корм");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByText("Купить корм")).toBeVisible();
});

test("forum destination saves with the responsible participant and clears for private delivery", async ({ page }) => {
  const state = createState();
  state.topics = { team: [
    { messageThreadId: 42, name: "Оплаты", isClosed: false },
    { messageThreadId: 52, name: "Архив", isClosed: true },
  ] };
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Оплатить аренду зала");
  const destination = page.getByLabel("Куда отправлять");
  await expect(destination).toBeEnabled();
  await expect(destination.locator('option[value="52"]')).toBeDisabled();
  await destination.selectOption("42");
  await page.getByRole("button", { name: "Ответственный", exact: true }).click();
  await page.getByRole("option", { name: /Иван/ }).click();
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  expect(state.requests.find((item) => item.method === "POST" && item.path === "/api/reminders"))
    .toMatchObject({ workspaceId: "team", body: { messageThreadId: 42, assignment: { mode: "person", responsibleUserId: 20 } } });

  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Личная задача");
  await expect(destination).toBeEnabled();
  await destination.selectOption("42");
  await page.getByRole("radio", { name: /Личное/ }).click();
  await expect(destination).toHaveCount(0);
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders").at(-1))
    .toMatchObject({ body: { visibility: "private", messageThreadId: null } });
});

test("forum topic connects through UI and becomes the reminder destination without losing the draft", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Напомнить про тренировку");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  const destination = page.getByLabel("Куда отправлять");
  await expect(destination).toHaveValue("62");
  await expect(destination).toBeFocused();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Напомнить про тренировку");
  await expect(page.getByLabel("Ссылка на тему", { exact: true })).not.toBeVisible();
  expect(state.requests.find((item) => item.method === "POST" && item.path === "/api/topic-connections"))
    .toMatchObject({ workspaceId: "team", body: { link: "https://t.me/c/1234567890/62", name: "Тренировки" } });
  await page.getByRole("button", { name: "Обновить темы" }).click();
  await expect(destination.locator('option[value="62"]')).toHaveText("Тренировки");
  await expect(destination).toBeEnabled();
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  expect(state.requests.find((item) => item.method === "POST" && item.path === "/api/reminders"))
    .toMatchObject({ body: { messageThreadId: 62, title: "Напомнить про тренировку" } });
});

test("forum topic connection errors keep both the selected topic and entered values", async ({ page }) => {
  const state = createState();
  state.topics = { team: [{ messageThreadId: 42, name: "Оплаты", isClosed: false }] };
  state.topicConnectionError = "Эта тема из другой группы. Выберите тему текущей группы.";
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  const destination = page.getByLabel("Куда отправлять");
  await expect(destination).toBeEnabled();
  await destination.selectOption("42");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByLabel("Ссылка на тему", { exact: true })).toBeFocused();
  expect(state.requests.some((item) => item.method === "POST" && item.path === "/api/topic-connections")).toBe(false);
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/9876543210/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByText(state.topicConnectionError)).toBeVisible();
  await expect(destination).toHaveValue("42");
  await expect(page.getByLabel("Название темы", { exact: true })).toHaveValue("Тренировки");
  await expect(page.getByLabel("Ссылка на тему", { exact: true })).toHaveValue("https://t.me/c/9876543210/62");
  state.topicConnectionError = undefined;
  await page.getByRole("button", { name: "Начать новую проверку" }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).press("Enter");
  await expect(destination).toHaveValue("62");
  expect(state.requests.some((item) => item.method === "POST" && item.path === "/api/reminders")).toBe(false);
});

test("forum destination survives a failed list refresh without silently moving to General", async ({ page }) => {
  const state = createState();
  state.reminders.team[0].messageThreadId = 42;
  state.topics = { team: [{ messageThreadId: 42, name: "Показания", isClosed: false }] };
  state.topicsFailuresRemaining = 2;
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("button", { name: /Передать показания/ }).click();
  // Detail loads topics independently; editing still keeps its stored destination.
  await expect.poll(() => state.topicsFailuresRemaining).toBe(1);
  await page.getByRole("button", { name: "Изменить" }).click();
  const destination = page.getByLabel("Куда отправлять");
  await expect(destination).toHaveValue("42");
  await page.getByRole("button", { name: "Обновить темы" }).click();
  await expect(page.getByText("Не удалось загрузить темы. Обновите список перед выбором.")).toBeVisible();
  await expect(destination).toHaveValue("42");
  await page.getByRole("button", { name: "Обновить темы" }).click();
  await expect(destination.locator('option[value="42"]')).toHaveText("Показания");
  await expect(destination).toHaveValue("42");
});

test("forum entry hints select only an accessible workspace", async ({ page }) => {
  const state = createState();
  await installTelegramAndApi(page, state);
  await page.goto("/?tgWebAppStartParam=ws_home");
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("home");
  await page.goto("/?workspace=team");
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("team");
  await page.goto("/?workspace=foreign-workspace");
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("team");
  expect(state.requests.some((request) => request.workspaceId === "foreign-workspace")).toBe(false);
});

test("forum destination remains usable in short light and dark Telegram viewports", async ({ page }, testInfo) => {
  const state = createState();
  state.topics = { team: [{ messageThreadId: 42, name: "Оплаты и организационные вопросы команды", isClosed: false }] };
  await installTelegramAndApi(page, state);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 20, top: 12 } });
  for (const width of [320, 412]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 568 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/");
      await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("zvenfit.reminder-draft.")) localStorage.removeItem(key); });
      await page.getByRole("button", { name: "Новое напоминание" }).click();

      const destination = page.getByLabel("Куда отправлять");
      await expect(destination).toBeEnabled();
      await destination.selectOption("42");
      await destination.scrollIntoViewIfNeeded();
      await destination.focus();
      await expect(destination).toBeFocused();
      const bounds = await destination.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`forum-${width}-${colorScheme}.png`) });
      await page.getByText("Подключить тему", { exact: true }).click();
      const link = page.getByLabel("Ссылка на тему", { exact: true });
      await link.fill("https://t.me/c/1234567890/62");
      await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      await expect(link).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`forum-connect-${width}-${colorScheme}.png`) });
      const connect = page.getByRole("button", { name: "Проверить и подключить" });
      await connect.scrollIntoViewIfNeeded();
      const connectBounds = await connect.boundingBox();
      expect(connectBounds!.height).toBeGreaterThanOrEqual(44);
      expect(connectBounds!.y + connectBounds!.height).toBeLessThanOrEqual(568);
      const save = page.getByRole("button", { name: "Создать поручение" });
      await save.scrollIntoViewIfNeeded();
      const saveBounds = await save.boundingBox();
      expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(568);
    }
  }
});

test("connects the first group from the empty screen through the native Telegram chooser", async ({ page }) => {
  const state = createState();
  state.groupWorkspace = state.workspaces[0];
  state.workspaces = [];
  await installTelegramAndApi(page, state);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Подключить группу", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const app = (window as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp;
    app.requestChat = (id: string, callback: (sent: boolean) => void) => { app.chosenRequest = id; callback(true); };
  });
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { Telegram: { WebApp: { chosenRequest?: string } } }).Telegram.WebApp.chosenRequest)).toBe("prepared-group-choice");
  expect(state.requests.find((item) => item.path === "/api/group-connections"))
    .toMatchObject({ workspaceId: null, body: { launchMode: "native", clientRequestId: expect.any(String) } });
  state.groupConnectionState = "connected";
  await expect(page.getByRole("button", { name: "Новое напоминание" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Подключить группу", exact: true })).toHaveCount(0);
});

test("offers the private-chat button fallback and activates the connected group", async ({ page }) => {
  const state = createState();
  state.groupWorkspace = state.workspaces[1];
  await openApp(page, state);
  await page.evaluate(() => {
    const app = (window as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp;
    app.openTelegramLink = (url: string) => { app.openedLink = url; };
  });
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect(page.getByText(/Печатать команду не нужно/)).toBeVisible();
  expect(state.requests.find((item) => item.path === "/api/group-connections"))
    .toMatchObject({ workspaceId: null, body: { launchMode: "private_chat" } });
  state.groupConnectionState = "connected";
  await page.getByRole("button", { name: "Проверить результат" }).click();
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("home");
});

test("restores the full reminder draft and raw date/time after relaunch without sending anything", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Черновик после Telegram");
  await page.getByLabel("Дата", { exact: true }).fill("31022099");
  await page.getByLabel("Время", { exact: true }).fill("2599");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.reload();
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Черновик после Telegram");
  await expect(page.getByLabel("Дата", { exact: true })).toHaveValue("31.02.2099");
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("25:99");
  await page.getByText("Подключить тему", { exact: true }).click();
  await expect(page.getByLabel("Ссылка на тему", { exact: true })).toHaveValue("https://t.me/c/1234567890/62");
  await expect(page.getByLabel("Название темы", { exact: true })).toHaveValue("Тренировки");
  expect(state.requests.some((item) => item.method === "POST")).toBe(false);
});

test("does not repeat an uncertain topic send after reload or status checks", async ({ page }) => {
  const state = createState();
  state.topicConnectionState = "unknown";
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Не отправлять дважды");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByText(/Результат отправки неизвестен/)).toBeVisible();
  const initial = state.requests.find((item) => item.method === "POST" && item.path === "/api/topic-connections")!;
  await page.reload();
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByText(/Результат отправки неизвестен/)).toBeVisible();
  await page.getByRole("button", { name: "Проверить результат", exact: true }).click();
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections")).toHaveLength(1);
  await page.getByRole("button", { name: "Начать новую проверку" }).click();
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect.poll(() => state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections").length).toBe(2);
  const latest = state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections").at(-1)!;
  expect((latest.body as { clientRequestId: string }).clientRequestId).not.toBe((initial.body as { clientRequestId: string }).clientRequestId);
});

test("clears a confirmed reminder draft and keeps other workspaces isolated", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Сохранить один раз");
  await page.reload();
  await page.getByLabel("Выбранная группа").selectOption("home");
  await expect(page.getByRole("button", { name: "Продолжить черновик" })).toHaveCount(0);
  await page.getByLabel("Выбранная группа").selectOption("team");
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Продолжить черновик" })).toHaveCount(0);
});

test("ordinary groups do not offer a forum connection", async ({ page }) => {
  const state = createState(); state.workspaces[0].isForum = false;
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await expect(page.getByText("Подключить тему", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Куда отправлять")).toHaveCount(0);
});

test("uses the same group attempt when native choice fails and a new UUID after expiration", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.evaluate(() => {
    const app = (window as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp;
    app.requestChat = () => { throw new Error("unsupported client"); };
    app.openTelegramLink = (url: string) => { app.openedLink = url; };
  });
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect(page.getByText(/Печатать команду не нужно/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { Telegram: { WebApp: { openedLink?: string } } }).Telegram.WebApp.openedLink)).toContain("https://t.me/");
  const first = state.requests.find((item) => item.path === "/api/group-connections")!;
  state.groupConnectionState = "expired";
  await page.getByRole("button", { name: "Проверить результат" }).click();
  await page.getByRole("button", { name: "Начать новое подключение" }).click();
  state.groupConnectionState = "pending";
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect.poll(() => state.requests.filter((item) => item.path === "/api/group-connections").length).toBe(2);
  const next = state.requests.filter((item) => item.path === "/api/group-connections").at(-1)!;
  expect((next.body as { clientRequestId: string }).clientRequestId).not.toBe((first.body as { clientRequestId: string }).clientRequestId);
});

test("restores both editing scopes on normal reopen and warns about a changed occurrence", async ({ page }) => {
  const state = createState();
  const item = occurrence("meters-open", "Передать показания", { reminderId: "meters" });
  state.occurrences.team = [item];
  item.updatedAt = "2026-10-30T10:00:00Z";
  await openApp(page, state);
  await page.getByRole("button", { name: /Передать показания/ }).first().click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await page.getByLabel("Что нужно сделать").fill("Черновик срока");
  await page.getByRole("radio", { name: /Этот и следующие/ }).click();
  await page.getByLabel("Что нужно сделать").fill("Черновик серии");
  await page.reload();
  item.updatedAt = "2026-10-30T11:00:00Z";
  await page.reload();
  await page.getByRole("button", { name: /Передать показания/ }).first().click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByText(/изменилось, пока вы были вне приложения/)).toBeVisible();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Черновик серии");
  await page.getByRole("radio", { name: /Только этот срок/ }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Черновик срока");
  expect(state.requests.some((item) => item.method === "PATCH")).toBe(false);
});

test("keeps a topic repair control after forum mode is disabled", async ({ page }) => {
  const state = createState(); state.workspaces[0].isForum = false;
  state.reminders.team[0].messageThreadId = 42;
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("button", { name: /Передать показания/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("42");
  await expect(page.getByText("Подключить тему", { exact: true })).toHaveCount(0);
  await page.getByLabel("Куда отправлять").selectOption("");
  await page.getByRole("button", { name: "Сохранить серию" }).click();
  await expect.poll(() => state.requests.find((item) => item.method === "PATCH" && item.path === "/api/reminders/meters")?.body).toMatchObject({ messageThreadId: null });
});

test("prevents draft edits or navigation while a confirmed save is pending", async ({ page }) => {
  const state = createState();
  let release!: () => void;
  state.createGate = new Promise<void>((resolve) => { release = resolve; });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Сохраняемый черновик");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("button", { name: "Назад" })).toBeDisabled();
  await expect(page.locator("form.reminder-form")).toHaveAttribute("inert", "");
  release();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Продолжить черновик" })).toHaveCount(0);
});

test("group onboarding fits short Telegram viewports in both themes", async ({ page }, testInfo) => {
  const state = createState(); state.workspaces = [];
  await installTelegramAndApi(page, state);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 20, top: 12 } });
  for (const width of [320, 412]) for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 568 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    const choose = page.getByRole("button", { name: "Выбрать группу", exact: true });
    await expect(choose).toBeVisible();
    await choose.focus();
    await expect(choose).toBeFocused();
    const bounds = await choose.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(548);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`group-onboarding-${width}-${colorScheme}.png`) });
  }
});

test("retries lost connection responses with the original client request UUID", async ({ page }) => {
  const state = createState(); state.groupConnectionFailuresRemaining = 1;
  await openApp(page, state);
  await page.evaluate(() => { window.Telegram!.WebApp!.openTelegramLink = () => {}; });
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect(page.getByText("Ответ не получен", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Продолжить подключение" }).click();
  await expect(page.getByRole("button", { name: "Проверить результат" })).toBeEnabled();
  const groups = state.requests.filter((item) => item.method === "POST" && item.path === "/api/group-connections");
  expect(groups).toHaveLength(2);
  expect(groups[0].body).toEqual(groups[1].body);
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  state.topicConnectionFailuresRemaining = 1;
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByText(/Ответ не получен. Проверьте результат этой попытки/)).toBeVisible();
  await page.getByRole("button", { name: "Проверить результат" }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("62");
  const topics = state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections");
  expect(topics).toHaveLength(2);
  expect(topics[0].body).toEqual(topics[1].body);
});

test("a late topic response does not overwrite a different workspace draft", async ({ page }) => {
  const state = createState(); let release!: () => void;
  state.topicConnectionGate = new Promise<void>((resolve) => { release = resolve; });
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Черновик команды");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await page.getByLabel("Выбранная группа").selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Домашний черновик");
  release();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Домашний черновик");
  await page.reload();
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Домашний черновик");
  await expect(page.getByLabel("Куда отправлять")).toHaveCount(0);
});

test("recovers a stalled group validation through retry without replacing its attempt", async ({ page }) => {
  const state = createState(); state.groupConnectionState = "validating"; state.groupWorkspace = state.workspaces[1];
  await openApp(page, state);
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await page.getByRole("button", { name: "Повторить проверку" }).click();
  await expect(page.getByRole("button", { name: "Повторить проверку" })).toBeEnabled();
  state.groupConnectionState = "connected";
  await page.getByRole("button", { name: "Повторить проверку" }).click();
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("home");
  const created = state.requests.filter((item) => item.method === "POST" && item.path === "/api/group-connections");
  expect(created).toHaveLength(1);
  const clientRequestId = (created[0].body as { clientRequestId: string }).clientRequestId;
  expect(state.requests.filter((item) => item.method === "POST" && item.path === `/api/group-connections/${clientRequestId}/retry`)).toHaveLength(2);
});

test("a timed-out committed save can verify the fresh Plan without repeating its write", async ({ page }, testInfo) => {
  const state = createState(); state.createResponseNeverArrives = true;
  await installTelegramAndApi(page, state);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Сохранено без ответа");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect.poll(() => state.reminders.team.some((item) => item.title === "Сохранено без ответа")).toBe(true);
  await page.clock.fastForward(20_001);
  await expect(page.getByText(/Прошлая попытка сохранения могла завершиться/)).toBeVisible();
  const readsBefore = state.requests.filter((item) => item.method === "GET" && item.path === "/api/reminders").length;
  await checkRecoveryActionViewports(page, "Проверить План", (name) => testInfo.outputPath(name), page.getByText(/Прошлая попытка сохранения могла завершиться/), page.getByText("Что создаём", { exact: true }));
  await page.getByRole("button", { name: "Проверить План", exact: true }).click();
  await expect(page.getByRole("button", { name: /Сохранено без ответа/ })).toBeVisible();
  expect(state.requests.filter((item) => item.method === "GET" && item.path === "/api/reminders").length).toBeGreaterThan(readsBefore);
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders")).toHaveLength(1);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Сохранено без ответа");
  await expect(page.getByText(/Прошлая попытка сохранения могла завершиться/)).toBeVisible();
});

test("relaunch after a lost topic POST retains the original attempt without an automatic send", async ({ page }) => {
  const state = createState(); state.topicConnectionFailuresRemaining = 1;
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Без повторной проверки");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByText(/Ответ не получен. Проверьте результат этой попытки/)).toBeVisible();
  const original = state.requests.find((item) => item.method === "POST" && item.path === "/api/topic-connections")!;
  await page.reload();
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByLabel("Ссылка на тему", { exact: true })).toBeDisabled();
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections")).toHaveLength(1);
  await page.getByRole("button", { name: "Проверить результат", exact: true }).click();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("62");
  const attempts = state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections");
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(original.body);
});

test("native cancellation keeps the same group attempt available for another selection", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.evaluate(() => {
    const app = window.Telegram!.WebApp!;
    app.requestChat = (_id, callback) => callback?.(false);
  });
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect(page.getByText("Выбор отменён. Можно выбрать группу позже.")).toBeVisible();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await expect(page.getByText("Выбор отменён. Можно выбрать группу позже.")).toBeVisible();
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/group-connections")).toHaveLength(1);
  expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/retry"))).toBe(false);
});

test("relaunching another Telegram account isolates drafts and group operations", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.evaluate(() => { window.Telegram!.WebApp!.openTelegramLink = () => {}; });
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Черновик Анны");
  await page.evaluate(() => localStorage.setItem("e2e.actorId", "20"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Продолжить черновик" })).toHaveCount(0);
  await page.getByRole("button", { name: "Подключить группу", exact: true }).click();
  await expect(page.getByRole("button", { name: "Проверить результат" })).toHaveCount(0);
  await page.evaluate(() => { window.Telegram!.WebApp!.openTelegramLink = () => {}; });
  await page.getByRole("button", { name: "Выбрать группу", exact: true }).click();
  const attempts = state.requests.filter((item) => item.method === "POST" && item.path === "/api/group-connections");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].body).not.toEqual(attempts[1].body);
  await page.evaluate(() => localStorage.setItem("e2e.actorId", "10"));
  await page.reload();
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Черновик Анны");
});

test("delivery-unavailable topics remain visible and disabled until the user repairs the destination", async ({ page }) => {
  const state = createState();
  state.reminders.team[0].messageThreadId = 42;
  state.topics = { team: [{ messageThreadId: 42, name: "Удалённая тема", isClosed: false, unavailableReason: "topic_deleted" }, { messageThreadId: 52, name: "Новая тема", isClosed: false }] };
  await openApp(page, state);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await page.getByRole("button", { name: /Передать показания/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  const destination = page.getByLabel("Куда отправлять");
  await expect(destination).toHaveValue("42");
  await expect(destination.locator('option[value="42"]')).toBeDisabled();
  await expect(destination.locator('option[value="42"]')).toHaveText("Удалённая тема · недоступна");
  await page.getByRole("button", { name: "Сохранить серию" }).click();
  await expect(page.getByText("Выберите открытую тему или общий чат.")).toBeVisible();
  expect(state.requests.some((item) => item.method === "PATCH")).toBe(false);
  await destination.selectOption("52");
  await page.getByRole("button", { name: "Сохранить серию" }).click();
  await expect.poll(() => state.requests.find((item) => item.method === "PATCH" && item.path === "/api/reminders/meters")?.body).toMatchObject({ messageThreadId: 52 });
});

test("late save and Plan refresh responses preserve a newer draft in another workspace", async ({ page }) => {
  const state = createState();
  let releaseWrite!: () => void;
  let releaseRead!: () => void;
  state.createGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const oldReadGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  await installTelegramAndApi(page, state);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Отложенное сохранение команды");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect.poll(() => state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders").length).toBe(1);
  await page.clock.fastForward(20_001);
  await expect(page.getByText(/Прошлая попытка сохранения могла завершиться/)).toBeVisible();
  let waitingOldReads = 0;
  await page.route("**/api/reminders", async (route) => {
    if (route.request().method() === "GET" && workspaceId(route.request()) === "team") { waitingOldReads += 1; await oldReadGate; }
    await route.fallback();
  });
  await page.getByRole("button", { name: "Назад" }).click();
  await expect.poll(() => waitingOldReads).toBe(1);
  await page.getByLabel("Выбранная группа").selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Новый домашний черновик");
  releaseWrite(); releaseRead();
  await expect.poll(() => state.reminders.team.some((item) => item.title === "Отложенное сохранение команды")).toBe(true);
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Новый домашний черновик");
  await page.reload();
  await expect(page.getByLabel("Выбранная группа")).toHaveValue("home");
  await page.getByRole("button", { name: "Продолжить черновик" }).click();
  await expect(page.getByLabel("Что нужно сделать")).toHaveValue("Новый домашний черновик");
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders")).toHaveLength(1);
});

test("an unsuccessful Plan verification labels cached data and offers a read-only retry", async ({ page }, testInfo) => {
  const state = createState(); state.createResponseNeverArrives = true;
  await installTelegramAndApi(page, state);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Проверка после таймаута");
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect.poll(() => state.reminders.team.some((item) => item.title === "Проверка после таймаута")).toBe(true);
  await page.clock.fastForward(20_001);
  await expect(page.getByRole("button", { name: "Проверить План", exact: true })).toBeVisible();
  let unavailable = true;
  await page.route("**/api/reminders", async (route) => {
    if (unavailable && route.request().method() === "GET") return route.fulfill({ status: 503, json: { error: "Temporary failure" } });
    await route.fallback();
  });
  await page.getByRole("button", { name: "Проверить План", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Показываем последнюю загруженную версию");
  await checkRecoveryActionViewports(page, "Загрузить план", (name) => testInfo.outputPath(name));
  await expect(page.getByRole("button", { name: /Проверка после таймаута/ })).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Загрузить план", exact: true }).click();
  await expect(page.getByRole("button", { name: /Проверка после таймаута/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders")).toHaveLength(1);
});

test("topic polling transitions to unknown and stops without a new send", async ({ page }) => {
  const state = createState(); state.topicConnectionState = "sending";
  await installTelegramAndApi(page, state);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Не повторять сообщение");
  await page.getByText("Подключить тему", { exact: true }).click();
  await page.getByLabel("Ссылка на тему", { exact: true }).fill("https://t.me/c/1234567890/62");
  await page.getByLabel("Название темы", { exact: true }).fill("Тренировки");
  await page.getByRole("button", { name: "Проверить и подключить" }).click();
  await expect(page.getByRole("button", { name: "Создать поручение" })).toBeDisabled();
  state.topicConnectionState = "unknown";
  await page.clock.fastForward(1501);
  await expect(page.getByText(/Результат отправки неизвестен/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Создать поручение" })).toBeEnabled();
  await expect(page.getByLabel("Куда отправлять")).toHaveValue("");
  const readCount = state.requests.filter((item) => item.method === "GET" && item.path.startsWith("/api/topic-connections/")).length;
  expect(readCount).toBe(1);
  await page.clock.fastForward(60_000);
  expect(state.requests.filter((item) => item.method === "GET" && item.path.startsWith("/api/topic-connections/")).length).toBe(readCount);
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/topic-connections")).toHaveLength(1);
});

test("a confirmed save clears its draft even if refreshing the Plan fails", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await page.getByLabel("Что нужно сделать").fill("Подтверждённое сохранение");
  let unavailable = true;
  await page.route("**/api/reminders", async (route) => {
    if (unavailable && route.request().method() === "GET") return route.fulfill({ status: 503, json: { error: "Temporary failure" } });
    await route.fallback();
  });
  await page.getByRole("button", { name: "Создать поручение" }).click();
  await expect(page.getByRole("heading", { name: "План", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("zvenfit.reminder-draft.")).length)).toBe(0);
  unavailable = false;
  await page.reload();
  await expect(page.getByRole("button", { name: "Продолжить черновик" })).toHaveCount(0);
  await page.getByRole("button", { name: "План", exact: true }).click();
  await expect(page.getByRole("button", { name: /Подтверждённое сохранение/ })).toBeVisible();
  expect(state.requests.filter((item) => item.method === "POST" && item.path === "/api/reminders")).toHaveLength(1);
});
