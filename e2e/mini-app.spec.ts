import { expect, test, type Page, type Request } from "@playwright/test";

type Role = "owner" | "organizer" | "member";

interface ApiMember {
  workspaceId: string;
  userId: number;
  role: Role;
  status: "active";
  username: string | null;
  displayName: string;
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
  dueAt: string;
  title: string;
  description: string | null;
  amountMinor: number | null;
  currency: string | null;
  visibility: "group" | "private";
  assignment: { mode: "person"; responsibleUserId: number } | { mode: "anyone" };
  status: "pending" | "overdue" | "completed";
  timezone: string;
  nextNotificationAt: string | null;
  undoUntil: string | null;
}

interface ApiState {
  workspaces: ApiWorkspace[];
  members: Record<string, ApiMember[]>;
  reminders: Record<string, ApiReminder[]>;
  occurrences: Record<string, ApiOccurrence[]>;
  requests: Array<{ method: string; path: string; workspaceId: string | null; body: unknown }>;
  undoErrorCode?: "undo_expired" | "not_actionable";
}

const now = "2026-08-14T09:00:00.000Z";
const onceSchedule = {
  version: 1,
  frequency: "once",
  date: "2026-08-15",
  timing: { kind: "timed", timeLocal: "09:00" },
};
const policy = {
  leadMinutes: 0,
  repeatIntervalMinutes: 360,
  ignoreQuietHours: false,
  escalation: { enabled: false },
};

function reminder(
  workspaceId: string,
  reminderId: string,
  title: string,
  overrides: Partial<ApiReminder> = {},
): ApiReminder {
  return {
    workspaceId,
    reminderId,
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
        { workspaceId: "team", userId: 10, role: "owner", status: "active", username: "anna", displayName: "Анна", privateChatAvailable: true },
        { workspaceId: "team", userId: 20, role: "member", status: "active", username: "ivan", displayName: "Иван", privateChatAvailable: true },
        { workspaceId: "team", userId: 30, role: "member", status: "active", username: null, displayName: "Маша", privateChatAvailable: false },
      ],
      home: [
        { workspaceId: "home", userId: 10, role: "member", status: "active", username: "anna", displayName: "Анна", privateChatAvailable: true },
        { workspaceId: "home", userId: 40, role: "owner", status: "active", username: "max", displayName: "Максим", privateChatAvailable: true },
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
        occurrence("internet", "Оплатить интернет"),
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
    state.requests.push({ method, path, workspaceId: selected, body });

    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (method === "GET" && path === "/api/workspaces") {
      return fulfill({ workspaces: state.workspaces });
    }
    if (!selected || !state.members[selected]) {
      return fulfill({ error: "Workspace not found", code: "not_found" }, 404);
    }
    if (method === "GET" && path === "/api/members") {
      return fulfill({ members: state.members[selected] });
    }
    if (method === "POST" && path === "/api/members/sync") {
      return fulfill({ members: state.members[selected], synced: state.members[selected].length });
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
      return fulfill({ occurrences: state.occurrences[selected].filter((item) => item.status !== "completed") });
    }
    if (method === "POST" && path === "/api/reminders") {
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
    return fulfill({ error: `Unhandled E2E route: ${method} ${path}` }, 501);
  });
}

async function installTelegram(page: Page): Promise<void> {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: {
        WebApp: {
          initData: "e2e-init-data",
          initDataUnsafe: { user: { id: 10 } },
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

  await expect(page.getByText("Передать показания")).toBeVisible();
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await expect(page.getByText("Полить цветы")).toBeVisible();
  await expect(page.getByText("Передать показания")).toHaveCount(0);
  expect(state.requests.filter((item) => item.path !== "/api/workspaces").at(-1)?.workspaceId)
    .toBe("home");
});

test("lets a member create only a personal reminder for themselves", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();

  await expect(page.getByRole("button", { name: /Групповое/ })).toBeDisabled();
  await expect(page.locator(".choice-card.is-selected")).toContainText("Личное");
  await expect(page.getByRole("combobox", { name: "Ответственный" })).toHaveValue("10");

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

  await card.getByRole("button", { name: "+1 час" }).click();
  await expect(page.getByText("Следующий сигнал — через час")).toBeVisible();
  await card.getByRole("button", { name: "✓ Выполнено" }).click();
  await expect(page.getByText("Можно отменить в течение 10 минут")).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByText("Оплатить интернет")).toBeVisible();
});

test("hides Undo when its completion window expires", async ({ page }) => {
  const state = createState();
  const item = state.occurrences.team.find((candidate) => candidate.occurrenceId === "internet")!;
  item.undoUntil = new Date(Date.now() + 800).toISOString();
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "✓ Выполнено" }).click();
  await expect(page.getByRole("button", { name: "Отменить" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отменить" })).toHaveCount(0, { timeout: 3000 });
});

test("dismisses stale Undo after the server rejects it", async ({ page }) => {
  const state = createState();
  state.undoErrorCode = "undo_expired";
  await openApp(page, state);
  const card = page.getByRole("article").filter({ hasText: "Оплатить интернет" });

  await card.getByRole("button", { name: "✓ Выполнено" }).click();
  await page.getByRole("button", { name: "Отменить" }).click();

  await expect(page.getByRole("button", { name: "Отменить" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Undo window expired");
});

test("reassigns a paused reminder and manages organizer access", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("tab", { name: "Вся группа" }).click();

  const paused = page.getByRole("article").filter({ hasText: "Заказать воду" });
  await paused.getByRole("combobox", { name: /Новый ответственный/ }).selectOption("20");
  await paused.getByRole("button", { name: "Переназначить" }).click();
  await expect(page.getByText("Ответственный изменён, напоминание снова активно")).toBeVisible();
  await expect(paused.getByText("Ответственный вышел")).toHaveCount(0);

  await page.getByText("Доступы", { exact: true }).click();
  await page.getByRole("combobox", { name: "Роль: Иван" }).selectOption("organizer");
  await expect(page.getByText("Доступ организатора выдан")).toBeVisible();
});

test("pauses, resumes, and archives a reminder series", async ({ page }) => {
  const state = createState();
  await openApp(page, state);
  await page.getByRole("tab", { name: "Вся группа" }).click();
  const row = page.getByRole("article").filter({ hasText: "Передать показания" });

  await row.getByRole("button", { name: "Пауза" }).click();
  await expect(page.getByText("Серия приостановлена")).toBeVisible();
  await row.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByText("Серия продолжена")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Завершить" }).click();
  await expect(page.getByText("Серия завершена")).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("edits the current and future definition of a reminder series", async ({ page }) => {
  const state = createState();
  const target = state.reminders.team.find((item) => item.reminderId === "meters")!;
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
  await page.getByRole("tab", { name: "Вся группа" }).click();
  const row = page.getByRole("article").filter({ hasText: "Передать показания" });

  await row.getByRole("button", { name: "Изменить" }).click();
  await expect(page.getByRole("heading", { name: "Что изменить?" })).toBeVisible();
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Передать новые показания");
  await page.getByRole("button", { name: "Сохранить" }).click();

  await expect(page.getByText("Передать новые показания")).toBeVisible();
  expect(state.requests.find((item) =>
    item.method === "PATCH" && item.path === "/api/reminders/meters"))
    .toMatchObject({
      workspaceId: "team",
      body: {
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
  await expect(card.getByRole("button", { name: "✓ Выполнено" })).toBeVisible();
  await expect(card.getByRole("button", { name: "+1 час" })).toBeVisible();
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

  await expect(card.getByRole("button", { name: "✓ Выполнено" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "+1 час" })).toHaveCount(0);
});

test("updates group rhythm and confirms ownership transfer", async ({ page }) => {
  const state = createState();
  await openApp(page, state);

  await page.getByRole("button", { name: /Ритм группы/ }).click();
  await expect(page.getByRole("heading", { name: "Когда можно звенеть" })).toBeVisible();
  await page.getByLabel("Начало тишины").fill("23:00");
  await page.getByLabel("Конец тишины").fill("07:30");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.getByText("Ритм группы обновлён")).toBeVisible();
  expect(state.workspaces[0]).toMatchObject({ quietHoursStart: "23:00", quietHoursEnd: "07:30" });

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
  await page.getByRole("button", { name: /Личное/ }).click();
  await page.getByRole("combobox", { name: "Ответственный" }).selectOption("30");
  await expect(page.getByText(/Маша сначала отправил боту \/start/)).toBeVisible();
});

test("keeps a reminder created in the built-in preview mode", async ({ page }) => {
  await installTelegram(page);
  await page.goto("/?mock=1");
  await page.getByRole("combobox", { name: "Выбранная группа" }).selectOption("home");
  await page.getByRole("button", { name: "Новое напоминание" }).click();
  await expect(page.getByRole("combobox", { name: "Ответственный" })).toHaveValue("10");
  await page.getByRole("textbox", { name: "Что нужно сделать" }).fill("Купить корм");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page.getByText("Купить корм")).toBeVisible();
});
