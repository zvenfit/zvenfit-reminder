import { expect, test, type Page, type Request } from "@playwright/test";

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
  title: string;
  description: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: "group" | "private";
  assignment: { mode: "person"; responsibleUserId: number } | { mode: "anyone" };
  status: "pending" | "overdue" | "completed" | "cancelled";
  timezone: string;
  nextNotificationAt: string | null;
  undoUntil: string | null;
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
  createFailuresRemaining?: number;
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
    title,
    description: null,
    amountMinor: null,
    currency: null,
    visibility: "group",
    assignment: { mode: "person", responsibleUserId: 10 },
    status: "pending",
    timezone: "Europe/Moscow",
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
    if (!selected || !state.members[selected]) {
      return fulfill({ error: "Workspace not found", code: "not_found" }, 404);
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
      if ((state.historyFailuresRemaining ?? 0) > 0) {
        state.historyFailuresRemaining = (state.historyFailuresRemaining ?? 1) - 1;
        return fulfill({ error: "History query failed", code: "history_unavailable" }, 500);
      }
      return fulfill({ occurrences: state.occurrences[selected].filter((item) => item.status === "completed" || item.status === "cancelled") });
    }
    if (method === "POST" && path === "/api/reminders") {
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
        item.status = "completed";
        item.undoUntil ??= new Date(Date.now() + 10 * 60 * 1000).toISOString();
        item.completedBy = 10;
        item.completedByDisplayName = "Анна";
        item.completedAt = new Date().toISOString();
      }
      if (actionMatch[2] === "undo-completion" && state.undoErrorCode) {
        return fulfill({ error: "Undo window expired", code: state.undoErrorCode }, 409);
      }
      if (actionMatch[2] === "undo-completion") {
        item.status = "pending";
        item.undoUntil = null;
      }
      if (actionMatch[2] === "snooze") item.nextNotificationAt = "2026-08-14T10:00:00.000Z";
      return fulfill({ occurrence: item });
    }
    const occurrenceUpdateMatch = path.match(/^\/api\/occurrences\/([^/]+)$/);
    if (method === "PATCH" && occurrenceUpdateMatch) {
      const item = state.occurrences[selected].find((candidate) => candidate.occurrenceId === occurrenceUpdateMatch[1]);
      if (!item) return fulfill({ error: "Not found" }, 404);
      Object.assign(item, body, { updatedAt: new Date().toISOString() });
      return fulfill({ occurrence: item });
    }
    return fulfill({ error: `Unhandled E2E route: ${method} ${path}` }, 501);
  });
}

async function installTelegram(page: Page): Promise<void> {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: {
        WebApp: {
          initData: "e2e-init-data",
          initDataUnsafe: { user: { id: 10, first_name: "Анна" } },
          ready() {},
          expand() {},
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
  // Vite's StrictMode runs the initial effect twice in E2E development mode.
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
  await retryAction.click();

  await expect(page.getByText("Забрать паспорт")).toBeVisible();
  await expect(requestAlert).toHaveCount(0);
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

test("recovers from an empty workspace response without leaving disabled controls", async ({ page }) => {
  const state = createState();
  const teamWorkspace = state.workspaces[0]!;
  state.workspaces = [];
  await installTelegramAndApi(page, state);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Обновите список групп" })).toBeVisible();
  await expect(page.getByText("Для аккаунта Анна")).toBeVisible();
  await expect(page.getByRole("button", { name: "Новое напоминание" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Обновить" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1))
    .toBe(true);
  const initialWorkspaceRequests = state.requests.filter((request) =>
    request.path === "/api/workspaces").length;

  state.workspaces.push(teamWorkspace);
  await page.getByRole("button", { name: "Обновить" }).click();

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
  await openApp(page, state);
  await page.getByRole("button", { name: /Участники/ }).click();

  await page.getByRole("button", { name: "Переименовать Я" }).click();
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

test("creates a payment with payment-specific fields and semantics", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await page.getByRole("radio", { name: /Платёж/ }).click();
  await expect(page.getByRole("textbox", { name: "Что нужно оплатить" })).toBeVisible();
  await page.getByText("Дополнительные настройки", { exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /Сумма/ })).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Пока не оплачено" })).toBeVisible();

  await page.getByRole("textbox", { name: "Что нужно оплатить" }).fill("Домашний интернет");
  await page.getByRole("spinbutton", { name: /Сумма/ }).fill("890.50");
  await page.getByRole("textbox", { name: /Ссылка на оплату/ }).fill("https://example.com/pay");
  await page.getByRole("button", { name: "Создать платёж" }).click();

  expect(state.requests.find((item) =>
    item.method === "POST" && item.path === "/api/reminders"))
    .toMatchObject({
      body: {
        kind: "payment",
        amountMinor: 89_050,
        currency: "RUB",
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
  await expect(page.getByRole("option").first()).toBeFocused();
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
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "Напомнить через час" }).click();
  await expect(page.getByText("Следующий сигнал — через час")).toBeVisible();
  await card.getByRole("button", { name: "Отметить оплату" }).click();
  await expect(page.getByText("Можно отменить в течение 10 минут")).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByText("Оплатить интернет")).toBeVisible();
});

test("opens one calm detail screen with deadline, next signal, and actions", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  await page.getByRole("tab", { name: "Вся группа" }).click();
  await page.getByRole("button", { name: /Забрать паспорт/ }).click();

  await expect(page.getByRole("heading", { name: "Забрать паспорт" })).toBeVisible();
  await expect(page.getByText(/Просрочено на/).first()).toBeVisible();
  await expect(page.getByText("Следующий сигнал", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отметить выполнение" })).toBeVisible();
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
  item.title = "Передать показания сейчас";
  await openApp(page, state);

  await page.getByRole("button", { name: /Передать показания сейчас/ }).click();
  await page.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByRole("radio", { name: /Только этот срок/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { name: "Когда он должен быть выполнен" })).toBeVisible();
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Передать показания сегодня");
  await page.getByRole("button", { name: "Сохранить этот срок" }).click();

  expect(state.requests.find((request) =>
    request.method === "PATCH" && request.path === "/api/occurrences/internet"))
    .toMatchObject({ body: { title: "Передать показания сегодня", dueLocalDate: expect.any(String) } });
  expect(state.reminders.team.find((reminder) => reminder.reminderId === "meters")?.title)
    .toBe("Передать показания");
});

test("keeps completed and cancelled facts in an auditable history", async ({ page }) => {
  const state = createState();
  state.occurrences.team.push(occurrence("meters-july", "Передать показания", {
    reminderId: "meters",
    status: "completed",
    completedBy: 20,
    completedByDisplayName: "Иван",
    completedAt: "2026-08-12T10:30:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-12T10:30:00.000Z",
  }));
  await openApp(page, state);

  await page.getByRole("button", { name: "История", exact: true }).click();
  const history = page.getByRole("button", { name: /Передать показания.*Выполнено.*Иван/ });
  await expect(history).toBeVisible();
  await history.click();
  await expect(page.getByText("История этого повтора", { exact: true })).toBeVisible();
  await expect(page.getByText(/Выполнение отметил/)).toBeVisible();
  await expect(page.getByText(/Иван/).last()).toBeVisible();
});

test("hides Undo when its completion window expires", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.undoUntil = new Date(Date.now() + 800).toISOString();
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "Отметить оплату" }).click();
  await expect(page.getByRole("button", { name: "Отменить" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить" })).toHaveCount(0, { timeout: 3000 });
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
  await expect(card.getByRole("button", { name: "Напомнить через час" })).toBeVisible();
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
  await expect(card.getByRole("button", { name: "Напомнить через час" })).toHaveCount(0);
});

test("updates group rhythm and confirms ownership transfer", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  await page.getByRole("button", { name: /Ритм группы/ }).click();
  await expect(page.getByRole("heading", { name: "Когда можно звенеть" })).toBeVisible();
  const timezonePreview = page.locator(".timezone-preview");
  await expect(timezonePreview).toContainText("Москва");
  await expect(timezonePreview).toContainText("UTC+3");
  await page.getByLabel("Город или часовой пояс").fill("Asia/Yekaterinburg");
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
