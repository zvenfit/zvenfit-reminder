import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ApiError,
  completeOccurrence,
  createReminder,
  changeReminderLifecycle,
  getInitData,
  listWorkspaces,
  listMembers,
  listReminders,
  loadDashboard,
  loadHistory,
  publishMemberEnrollment,
  reassignReminder,
  snoozeOccurrence,
  transferWorkspaceOwnership,
  undoOccurrenceCompletion,
  updateOccurrence,
  updateReminder,
  updateMemberDisplayName,
  updateMemberRole,
  updateWorkspaceSettings,
  selectWorkspace,
  type CreateReminderBody,
  type DeadlineTiming,
  type Reminder,
  type ReminderKind,
  type ReminderOccurrence,
  type ScheduleSpec,
  type UpdateOccurrenceBody,
  type WorkspaceMember,
  type Workspace,
} from "./api";
import { formatScheduleDate, upcomingScheduleDates } from "./schedule-preview";
import {
  buildTimezoneOptions,
  describeTimezone,
  detectDeviceTimezone,
  DEFAULT_TIMEZONE,
} from "./timezones";
import { isLocalTime24, Time24Field } from "./time-24-field";
import { MemberAvatar, PersonSelect } from "./person-select";
import { UiIcon } from "./ui-icon";
import "@fontsource-variable/onest/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";

type MainView = "home" | "plan" | "history";
type View = MainView | "detail" | "create" | "settings" | "members";
type Scope = "mine" | "group";
type Frequency = ScheduleSpec["frequency"];
type DetailTarget = { kind: "occurrence" | "reminder"; id: string };

interface ReminderFormState {
  kind: ReminderKind;
  title: string;
  description: string;
  actionUrl: string;
  amountRub: string;
  currency: string;
  visibility: "group" | "private";
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
  leadMinutes: string;
  repeatIntervalMinutes: string;
  ignoreQuietHours: boolean;
}

interface SettingsFormState {
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultAllDayReminderTime: string;
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timePosition(value: string): string {
  if (!isLocalTime24(value)) return "0%";
  const [hour, minute] = value.split(":").map(Number);
  return `${(hour * 60 + minute) / 14.4}%`;
}

const WEEKDAYS = [
  { value: 1, label: "Пн" },
  { value: 2, label: "Вт" },
  { value: 3, label: "Ср" },
  { value: 4, label: "Чт" },
  { value: 5, label: "Пт" },
  { value: 6, label: "Сб" },
  { value: 7, label: "Вс" },
];

function handleRovingControlKey(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='radio'], button[role='tab']"),
  ).filter((control) => !control.disabled);
  const current = (event.target as HTMLElement).closest<HTMLButtonElement>("button[role='radio'], button[role='tab']");
  const index = current ? controls.indexOf(current) : -1;
  if (index < 0 || controls.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? controls.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
  controls[nextIndex]?.focus();
  controls[nextIndex]?.click();
}

function localDate(daysFromToday = 0): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + daysFromToday);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function emptyForm(responsibleUserId?: number): ReminderFormState {
  return {
    kind: "task",
    title: "",
    description: "",
    actionUrl: "",
    amountRub: "",
    currency: "RUB",
    visibility: "group",
    assignmentMode: "person",
    responsibleUserId: responsibleUserId ? String(responsibleUserId) : "",
    watcherUserIds: [],
    frequency: "once",
    date: localDate(1),
    startDate: localDate(),
    timeLocal: "09:00",
    allDay: false,
    interval: "1",
    weekdays: [new Date().getDay() || 7],
    monthlyDay: String(new Date().getDate()),
    monthlyLastDay: false,
    yearlyMonth: String(new Date().getMonth() + 1),
    yearlyDay: String(new Date().getDate()),
    leadMinutes: "0",
    repeatIntervalMinutes: "360",
    ignoreQuietHours: false,
  };
}

function reminderForm(reminder: Reminder): ReminderFormState {
  const form = emptyForm(
    reminder.assignment.mode === "person" ? reminder.assignment.responsibleUserId : undefined,
  );
  form.kind = reminder.kind;
  form.title = reminder.title;
  form.description = reminder.description ?? "";
  form.actionUrl = reminder.actionUrl ?? "";
  form.amountRub = reminder.amountMinor == null ? "" : String(reminder.amountMinor / 100);
  form.currency = reminder.currency ?? "RUB";
  form.visibility = reminder.visibility;
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
  form.leadMinutes = String(reminder.notificationPolicy.leadMinutes);
  form.repeatIntervalMinutes = String(reminder.notificationPolicy.repeatIntervalMinutes);
  form.ignoreQuietHours = reminder.notificationPolicy.ignoreQuietHours;
  return form;
}

function workspaceSettings(workspace: Workspace): SettingsFormState {
  return {
    timezone: workspace.timezone,
    quietHoursStart: workspace.quietHoursStart,
    quietHoursEnd: workspace.quietHoursEnd,
    defaultAllDayReminderTime: workspace.defaultAllDayReminderTime,
  };
}

function memberName(member: WorkspaceMember | undefined): string {
  return member?.displayName ?? "Участник";
}

function memberTelegramIdentity(member: WorkspaceMember): string {
  if (member.displayNameOverride) {
    return `Telegram: ${member.telegramDisplayName}${member.username ? ` · @${member.username}` : ""}`;
  }
  return member.username ? `@${member.username}` : "Имя из Telegram";
}

function memberRoleLabel(role: WorkspaceMember["role"]): string {
  if (role === "owner") return "Владелец";
  if (role === "organizer") return "Организатор";
  return "Участник";
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="back-button" type="button" aria-label="Назад" onClick={onClick}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M15 18 9 12l6-6" />
      </svg>
    </button>
  );
}

function formatAmount(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor == null || !currency) return null;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function normalizeRussianDateLabel(value: string): string {
  return value.replace(/\s+г\./gu, "").replace(/,\s*/gu, " · ");
}

function formatDue(occurrence: ReminderOccurrence): string {
  return normalizeRussianDateLabel(new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: occurrence.timezone,
  }).format(new Date(occurrence.dueAt)));
}

function formatMoment(value: string, timezone: string, withYear = false): string {
  return normalizeRussianDateLabel(new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value)));
}

function occurrenceLocalDeadline(occurrence: ReminderOccurrence): { date: string; time: string } {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: occurrence.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(occurrence.dueAt)).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function relativeDuration(value: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round(Math.abs(new Date(value).getTime() - now) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.round(hours / 24);
  return `${days} дн`;
}

function occurrenceStatusLabel(occurrence: ReminderOccurrence): string {
  if (occurrence.status === "completed") return occurrence.kind === "payment" ? "Оплачено" : "Выполнено";
  if (occurrence.status === "cancelled") return "Отменено";
  if (occurrence.status === "overdue") return `Просрочено на ${relativeDuration(occurrence.dueAt)}`;
  if (occurrence.status === "scheduled") return "Запланировано";
  return "Ожидает выполнения";
}

function WorkspaceSelect({
  workspaces,
  value,
  onChange,
  compact = false,
}: {
  workspaces: Workspace[];
  value: string;
  onChange: (workspaceId: string) => void;
  compact?: boolean;
}) {
  return (
    <span className={`workspace-select workspace-select--${compact ? "compact" : "home"}`}>
      <select
        aria-label="Выбранная группа"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {workspaces.map((workspace) => (
          <option value={workspace.workspaceId} key={workspace.workspaceId}>
            {workspace.displayName}
          </option>
        ))}
      </select>
      <UiIcon name="chevron-down" />
    </span>
  );
}

function InitialDashboardSkeleton() {
  return (
    <main className="app app--home app--initial-loading" aria-busy="true">
      <span className="sr-only" role="status">
        Загружаем рабочее пространство
      </span>
      <header className="home-header">
        <div className="brand-mark" aria-label="ZvenFit">
          <span />
          <b>ZvenFit</b>
        </div>
        <i className="initial-skeleton__date" aria-hidden="true" />
      </header>

      <div className="workspace-switcher" aria-hidden="true">
        <span className="workspace-switcher__signal" />
        <span className="initial-skeleton__workspace-copy"><i /><i /></span>
      </div>

      <div className="workspace-tools initial-skeleton__tools" aria-hidden="true">
        {[0, 1].map((item) => (
          <div className="workspace-settings-link" key={item}>
            <i className="initial-skeleton__tool-icon" />
            <span>
              <i />
              <i />
            </span>
          </div>
        ))}
      </div>

      <section className="home-intro">
        <h1>Требует внимания</h1>
        <div className="scope-switch initial-skeleton__scope" aria-hidden="true">
          <i />
          <i />
        </div>
      </section>

      <section className="attention-section" aria-hidden="true">
        <div className="section-heading">
          <h2>Сейчас</h2>
          <span />
        </div>
        <div className="rail skeleton-rail skeleton-rail--initial">
          <i />
          <i />
        </div>
      </section>

      <nav className="bottom-navigation initial-skeleton__navigation" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </nav>
    </main>
  );
}

function BottomNavigation({
  view,
  onChange,
  onCreate,
  createDisabled = false,
}: {
  view: MainView;
  onChange: (view: MainView) => void;
  onCreate: () => void;
  createDisabled?: boolean;
}) {
  const items: Array<{ view: MainView; label: string; icon: "target" | "calendar" | "history" }> = [
    { view: "home", label: "Задачи", icon: "target" },
    { view: "plan", label: "План", icon: "calendar" },
    { view: "history", label: "История", icon: "history" },
  ];
  return (
    <nav className="bottom-navigation" aria-label="Основные разделы">
      {items.map((item) => (
        <button
          className={view === item.view ? "is-selected" : ""}
          type="button"
          aria-current={view === item.view ? "page" : undefined}
          onClick={() => onChange(item.view)}
          key={item.view}
        >
          <UiIcon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
      <button
        className="bottom-navigation__create"
        type="button"
        aria-label="Новое напоминание"
        disabled={createDisabled}
        onClick={onCreate}
      >
        <UiIcon name="plus" />
        <span>Новое</span>
      </button>
    </nav>
  );
}

function scheduleLabel(schedule: ScheduleSpec): string {
  const time = schedule.timing.kind === "allDay" ? "весь день" : schedule.timing.timeLocal;
  switch (schedule.frequency) {
    case "once":
      return `${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(
        new Date(`${schedule.date}T12:00:00`),
      )} · ${time}`;
    case "daily":
      return schedule.interval === 1 ? `Каждый день · ${time}` : `Каждые ${schedule.interval} дн. · ${time}`;
    case "weekly": {
      const labels = WEEKDAYS.filter((day) => schedule.weekdays.includes(day.value))
        .map((day) => day.label.toLowerCase())
        .join(", ");
      return `${schedule.interval === 1 ? "Еженедельно" : `Каждые ${schedule.interval} нед.`} · ${labels} · ${time}`;
    }
    case "monthly":
      return `${schedule.interval === 1 ? "Ежемесячно" : `Каждые ${schedule.interval} мес.`} · ${
        schedule.day.type === "lastDay" ? "последний день" : `${schedule.day.value}-е число`
      } · ${time}`;
    case "yearly":
      return `Ежегодно · ${schedule.day}.${String(schedule.month).padStart(2, "0")} · ${time}`;
  }
}

function formSchedulePreview(form: ReminderFormState): string {
  try {
    return scheduleLabel(buildSchedule(form));
  } catch {
    return "Заполните дату и время";
  }
}

function formUpcomingDates(form: ReminderFormState, timezone: string): string[] {
  try {
    return upcomingScheduleDates(buildSchedule(form), timezone, 3);
  } catch {
    return [];
  }
}

function repeatPreviewLabel(minutes: string): string {
  const labels: Record<string, string> = {
    "60": "каждый час",
    "180": "каждые 3 часа",
    "360": "каждые 6 часов",
    "720": "каждые 12 часов",
    "1440": "раз в день",
  };
  return labels[minutes] ?? "по выбранному ритму";
}

function buildSchedule(form: ReminderFormState): ScheduleSpec {
  const timing: DeadlineTiming = form.allDay
    ? { kind: "allDay" }
    : { kind: "timed", timeLocal: form.timeLocal };
  const interval = Math.max(1, Number(form.interval));
  switch (form.frequency) {
    case "once":
      return { version: 1, frequency: "once", date: form.date, timing };
    case "daily":
      return { version: 1, frequency: "daily", startDate: form.startDate, timing, interval };
    case "weekly":
      return {
        version: 1,
        frequency: "weekly",
        startDate: form.startDate,
        timing,
        interval,
        weekdays: [...form.weekdays].sort(),
      };
    case "monthly":
      return {
        version: 1,
        frequency: "monthly",
        startDate: form.startDate,
        timing,
        interval,
        day: form.monthlyLastDay
          ? { type: "lastDay" }
          : { type: "dayOfMonth", value: Number(form.monthlyDay), overflow: "lastDay" },
      };
    case "yearly":
      return {
        version: 1,
        frequency: "yearly",
        startDate: form.startDate,
        timing,
        interval,
        month: Number(form.yearlyMonth),
        day: Number(form.yearlyDay),
        overflow: "lastDay",
      };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "undo_expired") {
    return "Отменить выполнение уже нельзя: прошло 10 минут.";
  }
  if (error instanceof ApiError && error.code === "private_chat_required") {
    return "Ответственный ещё не открыл личный чат с ботом. Попросите его отправить боту /start.";
  }
  if (error instanceof ApiError && error.code === "workspace_required") {
    return "Выберите группу.";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "Сессия Telegram устарела. Закройте панель и откройте её снова кнопкой в чате с ботом.";
  }
  if (error instanceof ApiError && error.code === "telegram_unavailable") {
    return "Не удалось опубликовать кнопку в группе. Попробуйте ещё раз через минуту.";
  }
  if (error instanceof ApiError && error.status === 429) {
    return "Слишком много запросов. Подождите немного и попробуйте ещё раз.";
  }
  if (error instanceof ApiError && error.status >= 500) {
    return "Сервис временно не отвечает. Попробуйте ещё раз.";
  }
  if (error instanceof TypeError) {
    return "Не удалось связаться с сервисом. Проверьте интернет и попробуйте ещё раз.";
  }
  return error instanceof Error ? error.message : "Что-то пошло не так";
}

interface ErrorRecovery {
  label: string;
  onRetry: () => void;
}

type DashboardResource = "tasks" | "plan" | "members";

function dashboardFailureMessage(resources: DashboardResource[]): string {
  if (resources.length > 1) {
    return "Часть данных временно не загрузилась. Остальные разделы доступны.";
  }
  if (resources[0] === "tasks") {
    return "Задачи временно не загрузились. План и участники доступны.";
  }
  if (resources[0] === "plan") {
    return "План временно не загрузился. Задачи и участники доступны.";
  }
  return "Участники временно не загрузились. Задачи и план доступны.";
}

function RequestErrorBanner({
  message,
  recovery,
}: {
  message: string;
  recovery?: ErrorRecovery | null;
}) {
  return (
    <div
      className={`error-banner${recovery ? " error-banner--actionable" : ""}`}
      role="alert"
    >
      <span>{message}</span>
      {recovery ? (
        <button className="error-banner__action" type="button" onClick={recovery.onRetry}>
          <UiIcon name="refresh" />
          <span>{recovery.label}</span>
        </button>
      ) : null}
    </div>
  );
}

function App() {
  const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");
  const botUsername = import.meta.env.VITE_BOT_USERNAME ?? "zvenfit_reminder_bot";
  const botUrl = `https://t.me/${botUsername}?start=panel`;
  const [telegramAuthMissing] = useState(() => !previewMode && !getInitData());
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [view, setView] = useState<View>("home");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("group");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [occurrences, setOccurrences] = useState<ReminderOccurrence[]>([]);
  const [historyOccurrences, setHistoryOccurrences] = useState<ReminderOccurrence[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [dashboardLoadError, setDashboardLoadError] = useState<string | null>(null);
  const [loadedDashboardResources, setLoadedDashboardResources] = useState<DashboardResource[]>([]);
  const [failedDashboardResources, setFailedDashboardResources] = useState<DashboardResource[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [detailReturnView, setDetailReturnView] = useState<MainView>("home");
  const [archiveTarget, setArchiveTarget] = useState<Reminder | null>(null);
  const [form, setForm] = useState<ReminderFormState>(() => emptyForm());
  const [settingsForm, setSettingsForm] = useState<SettingsFormState>({
    timezone: DEFAULT_TIMEZONE,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    defaultAllDayReminderTime: "09:00",
  });
  const [loading, setLoading] = useState(true);
  const [hasLoadedDashboard, setHasLoadedDashboard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [membersReturnView, setMembersReturnView] = useState<"home" | "create">("home");
  const [refreshingMembers, setRefreshingMembers] = useState(false);
  const [publishingEnrollment, setPublishingEnrollment] = useState(false);
  const [confirmingEnrollment, setConfirmingEnrollment] = useState(false);
  const [ownershipTarget, setOwnershipTarget] = useState("");
  const [confirmingOwnership, setConfirmingOwnership] = useState(false);
  const [transferringOwnership, setTransferringOwnership] = useState(false);
  const [actingOccurrenceId, setActingOccurrenceId] = useState<string | null>(null);
  const [updatingRoleUserId, setUpdatingRoleUserId] = useState<number | null>(null);
  const [editingMemberUserId, setEditingMemberUserId] = useState<number | null>(null);
  const [memberDisplayNameDraft, setMemberDisplayNameDraft] = useState("");
  const [updatingDisplayNameUserId, setUpdatingDisplayNameUserId] = useState<number | null>(null);
  const [reassigningReminderId, setReassigningReminderId] = useState<string | null>(null);
  const [managingReminderId, setManagingReminderId] = useState<string | null>(null);
  const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
  const [editingOccurrenceId, setEditingOccurrenceId] = useState<string | null>(null);
  const [editScope, setEditScope] = useState<"occurrence" | "series">("series");
  const [occurrenceDate, setOccurrenceDate] = useState(localDate());
  const [occurrenceTime, setOccurrenceTime] = useState("09:00");
  const [occurrenceAllDay, setOccurrenceAllDay] = useState(false);
  const [reassignment, setReassignment] = useState<Record<string, string>>({});
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const historyRefreshGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [errorRecovery, setErrorRecovery] = useState<ErrorRecovery | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoableOccurrence, setUndoableOccurrence] = useState<ReminderOccurrence | null>(null);
  const timezoneReference = useMemo(() => new Date(), []);
  const timezoneOptions = useMemo(
    () => view === "settings" ? buildTimezoneOptions(timezoneReference) : [],
    [timezoneReference, view],
  );
  const deviceTimezone = useMemo(() => detectDeviceTimezone(), []);
  const selectedTimezone = describeTimezone(settingsForm.timezone, timezoneReference);
  const deviceTimezonePresentation = describeTimezone(deviceTimezone, timezoneReference);

  useEffect(() => {
    if (!undoableOccurrence?.undoUntil) return;
    const remaining = new Date(undoableOccurrence.undoUntil).getTime() - Date.now();
    if (remaining <= 0) {
      setUndoableOccurrence(null);
      return;
    }
    const timeout = window.setTimeout(() => setUndoableOccurrence(null), remaining);
    return () => window.clearTimeout(timeout);
  }, [undoableOccurrence]);

  const actorId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ??
    (previewMode ? members[0]?.userId : undefined);
  const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const telegramAccountLabel = telegramUser
    ? [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ") ||
      (telegramUser.username ? `@${telegramUser.username}` : `ID ${telegramUser.id ?? "—"}`)
    : "текущего Telegram-аккаунта";
  const memberMap = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLocaleLowerCase("ru-RU");
    if (!query) return members;
    return members.filter((member) =>
      member.displayName.toLocaleLowerCase("ru-RU").includes(query) ||
      member.telegramDisplayName.toLocaleLowerCase("ru-RU").includes(query) ||
      member.username?.toLocaleLowerCase("ru-RU").includes(query));
  }, [memberSearch, members]);
  const reminderMap = useMemo(
    () => new Map(reminders.map((reminder) => [reminder.reminderId, reminder])),
    [reminders],
  );
  const actor = actorId ? memberMap.get(actorId) : undefined;

  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter((occurrence) => {
        if (scope === "group" || !actorId) return true;
        return (
          occurrence.assignment.mode === "anyone" ||
          occurrence.assignment.responsibleUserId === actorId ||
          reminderMap.get(occurrence.reminderId)?.creatorUserId === actorId
        );
      }),
    [actorId, occurrences, reminderMap, scope],
  );

  const visibleReminders = useMemo(
    () =>
      reminders.filter((reminder) => {
        if (reminder.status === "archived") return false;
        if (scope === "group" || !actorId) return true;
        return (
          reminder.creatorUserId === actorId ||
          reminder.assignment.mode === "anyone" ||
          reminder.assignment.responsibleUserId === actorId
        );
      }),
    [actorId, reminders, scope],
  );

  const visibleHistory = useMemo(
    () => historyOccurrences.filter((occurrence) => {
      if (scope === "group" || !actorId) return true;
      return (
        occurrence.assignment.mode === "anyone" ||
        occurrence.assignment.responsibleUserId === actorId ||
        reminderMap.get(occurrence.reminderId)?.creatorUserId === actorId
      );
    }),
    [actorId, historyOccurrences, reminderMap, scope],
  );

  const planDates = useMemo(() => new Map(visibleReminders.map((reminder) => [
    reminder.reminderId,
    upcomingScheduleDates(reminder.schedule, reminder.timezone, 3),
  ])), [visibleReminders]);

  function clearError() {
    setError(null);
    setErrorRecovery(null);
  }

  function showError(value: unknown, recovery: ErrorRecovery | null = null) {
    setError(typeof value === "string" ? value : errorMessage(value));
    setErrorRecovery(recovery);
  }

  function switchMainView(nextView: MainView) {
    setView(nextView);
    clearError();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openOccurrenceDetail(occurrenceId: string, returnView: MainView = "home") {
    setDetailTarget({ kind: "occurrence", id: occurrenceId });
    setDetailReturnView(returnView);
    clearError();
    setView("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openReminderDetail(reminderId: string, returnView: MainView = "plan") {
    setDetailTarget({ kind: "reminder", id: reminderId });
    setDetailReturnView(returnView);
    clearError();
    setView("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refresh(selectedId = workspaceId) {
    if (!selectedId) {
      setLoading(false);
      return;
    }
    if (activeWorkspaceIdRef.current !== selectedId) {
      return;
    }
    const generation = ++refreshGenerationRef.current;
    const historyGeneration = ++historyRefreshGenerationRef.current;
    setHistoryLoading(false);
    selectWorkspace(selectedId);
    setLoading(true);
    clearError();
    setHistoryError(null);
    setDashboardLoadError(null);
    try {
      const [dashboardResult, remindersResult, membersResult, historyResult] = await Promise.allSettled([
        loadDashboard(),
        listReminders(),
        listMembers(),
        loadHistory(),
      ]);
      if (
        generation !== refreshGenerationRef.current ||
        activeWorkspaceIdRef.current !== selectedId
      ) {
        return;
      }

      const loadedResources: DashboardResource[] = [];
      const failedResources: DashboardResource[] = [];
      if (dashboardResult.status === "fulfilled") {
        setOccurrences(dashboardResult.value.occurrences);
        loadedResources.push("tasks");
      } else {
        failedResources.push("tasks");
      }
      if (remindersResult.status === "fulfilled") {
        setReminders(remindersResult.value.reminders);
        loadedResources.push("plan");
      } else {
        failedResources.push("plan");
      }
      if (membersResult.status === "fulfilled") {
        setMembers(membersResult.value.members);
        loadedResources.push("members");
      } else {
        failedResources.push("members");
      }
      setLoadedDashboardResources((current) => [
        ...new Set([...current, ...loadedResources]),
      ]);
      setFailedDashboardResources(failedResources);
      const unavailableResources = failedResources.filter(
        (resource) => !loadedDashboardResources.includes(resource),
      );
      setDashboardLoadError(failedResources.length === 0
        ? null
        : unavailableResources.length === 0
          ? "Не удалось обновить данные. Показываем последнюю загруженную версию."
          : dashboardFailureMessage(unavailableResources));
      setHasLoadedDashboard(true);
      if (historyGeneration === historyRefreshGenerationRef.current) {
        if (historyResult.status === "fulfilled") {
          setHistoryOccurrences(historyResult.value.occurrences);
        } else {
          setHistoryOccurrences([]);
          setHistoryError("История временно недоступна. Остальные данные загружены.");
        }
      }
    } catch (requestError) {
      if (
        generation === refreshGenerationRef.current &&
        activeWorkspaceIdRef.current === selectedId
      ) {
        setFailedDashboardResources(["tasks", "plan", "members"]);
        setDashboardLoadError(errorMessage(requestError));
        setHasLoadedDashboard(true);
      }
    } finally {
      if (
        generation === refreshGenerationRef.current &&
        activeWorkspaceIdRef.current === selectedId
      ) {
        setLoading(false);
      }
    }
  }

  async function refreshHistory(selectedId = workspaceId) {
    if (!selectedId || activeWorkspaceIdRef.current !== selectedId) return;
    const generation = ++historyRefreshGenerationRef.current;
    selectWorkspace(selectedId);
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await loadHistory();
      if (
        generation === historyRefreshGenerationRef.current &&
        activeWorkspaceIdRef.current === selectedId
      ) {
        setHistoryOccurrences(response.occurrences);
      }
    } catch {
      if (
        generation === historyRefreshGenerationRef.current &&
        activeWorkspaceIdRef.current === selectedId
      ) {
        setHistoryError("История временно недоступна. Остальные данные загружены.");
      }
    } finally {
      if (
        generation === historyRefreshGenerationRef.current &&
        activeWorkspaceIdRef.current === selectedId
      ) {
        setHistoryLoading(false);
      }
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    if (telegramAuthMissing) {
      setLoading(false);
      return;
    }
    void (async () => {
      setLoading(true);
      clearError();
      try {
        const response = await listWorkspaces();
        setWorkspaces(response.workspaces);
        const storedWorkspaceId = window.localStorage.getItem("zvenfit.workspaceId");
        const initial = response.workspaces.find((workspace) =>
          workspace.workspaceId === storedWorkspaceId) ?? response.workspaces[0];
        if (!initial) {
          activeWorkspaceIdRef.current = null;
          setWorkspaceId(null);
          setDashboardLoadError(null);
          setLoadedDashboardResources([]);
          setFailedDashboardResources([]);
          setOccurrences([]);
          setHistoryOccurrences([]);
          setReminders([]);
          setMembers([]);
          setLoading(false);
          return;
        }
        activeWorkspaceIdRef.current = initial.workspaceId;
        setWorkspaceId(initial.workspaceId);
        await refresh(initial.workspaceId);
      } catch (requestError) {
        showError(requestError);
        setLoading(false);
      }
    })();
  }, [telegramAuthMissing, workspaceLoadAttempt]);

  function retryWorkspaceLoad() {
    clearError();
    setDashboardLoadError(null);
    setLoadedDashboardResources([]);
    setFailedDashboardResources([]);
    setHasLoadedDashboard(false);
    setWorkspaceLoadAttempt((attempt) => attempt + 1);
  }

  async function changeWorkspace(nextWorkspaceId: string) {
    historyRefreshGenerationRef.current += 1;
    setHistoryLoading(false);
    activeWorkspaceIdRef.current = nextWorkspaceId;
    setWorkspaceId(nextWorkspaceId);
    window.localStorage.setItem("zvenfit.workspaceId", nextWorkspaceId);
    setView("home");
    setDetailTarget(null);
    setArchiveTarget(null);
    setUndoableOccurrence(null);
    setActingOccurrenceId(null);
    setReassigningReminderId(null);
    setManagingReminderId(null);
    setUpdatingRoleUserId(null);
    setEditingMemberUserId(null);
    setUpdatingDisplayNameUserId(null);
    setMemberSearch("");
    setConfirmingEnrollment(false);
    setNotice(null);
    clearError();
    setHistoryError(null);
    setDashboardLoadError(null);
    setLoadedDashboardResources([]);
    setFailedDashboardResources([]);
    setHasLoadedDashboard(false);
    setOccurrences([]);
    setHistoryOccurrences([]);
    setReminders([]);
    setMembers([]);
    await refresh(nextWorkspaceId);
  }

  function openCreate() {
    if (!workspaceId) {
      showError("Сначала подключите группу командой /setup.");
      return;
    }
    const defaultResponsible = actorId ?? members[0]?.userId;
    const nextForm = emptyForm(defaultResponsible);
    if (actor?.role !== "owner" && actor?.role !== "organizer") {
      nextForm.visibility = "private";
      nextForm.assignmentMode = "person";
      nextForm.responsibleUserId = actorId ? String(actorId) : "";
    }
    setForm(nextForm);
    setEditingReminderId(null);
    setEditingOccurrenceId(null);
    setEditScope("series");
    clearError();
    setView("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openEdit(reminder: Reminder, occurrence?: ReminderOccurrence) {
    setForm(reminderForm(reminder));
    setEditingReminderId(reminder.reminderId);
    setEditingOccurrenceId(occurrence?.occurrenceId ?? null);
    setEditScope(occurrence ? "occurrence" : "series");
    if (occurrence) {
      const localDeadline = occurrenceLocalDeadline(occurrence);
      setOccurrenceDate(localDeadline.date);
      setOccurrenceTime(localDeadline.time);
      setOccurrenceAllDay(false);
    }
    clearError();
    setView("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSettings() {
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace || (workspace.role !== "owner" && workspace.role !== "organizer")) return;
    setSettingsForm(workspaceSettings(workspace));
    setOwnershipTarget("");
    setConfirmingOwnership(false);
    clearError();
    setView("settings");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openMembers(returnView: "home" | "create") {
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace || (workspace.role !== "owner" && workspace.role !== "organizer")) return;
    setMembersReturnView(returnView);
    setMemberSearch("");
    setEditingMemberUserId(null);
    setMemberDisplayNameDraft("");
    setConfirmingEnrollment(false);
    clearError();
    setNotice(null);
    setView("members");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshMemberRoster() {
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    const knownUserIds = new Set(members.map((member) => member.userId));
    setRefreshingMembers(true);
    clearError();
    try {
      const response = await listMembers();
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setMembers(response.members);
      const added = response.members.filter((member) => !knownUserIds.has(member.userId)).length;
      setNotice(added > 0 ? `Новых участников: ${added}` : "Список уже актуален");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError, {
          label: "Обновить список",
          onRetry: () => void refreshMemberRoster(),
        });
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setRefreshingMembers(false);
      }
    }
  }

  async function publishEnrollment() {
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setPublishingEnrollment(true);
    clearError();
    try {
      await publishMemberEnrollment();
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setConfirmingEnrollment(false);
      setNotice("Приглашение отправлено в группу");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 3200);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setPublishingEnrollment(false);
      }
    }
  }

  async function saveWorkspaceSettings() {
    setSettingsSaving(true);
    clearError();
    try {
      const { workspace } = await updateWorkspaceSettings(settingsForm);
      setWorkspaces((current) => current.map((item) =>
        item.workspaceId === workspace.workspaceId ? workspace : item));
      setSettingsForm(workspaceSettings(workspace));
      setNotice("Ритм группы обновлён");
      window.setTimeout(() => setNotice(null), 2600);
    } catch (requestError) {
      showError(requestError);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function confirmOwnershipTransfer() {
    const targetUserId = Number(ownershipTarget);
    if (!targetUserId) {
      showError("Выберите нового владельца.");
      return;
    }
    setTransferringOwnership(true);
    clearError();
    try {
      const { workspace } = await transferWorkspaceOwnership(targetUserId);
      setWorkspaces((current) => current.map((item) =>
        item.workspaceId === workspace.workspaceId ? workspace : item));
      setMembers((current) => current.map((member) => {
        if (member.userId === targetUserId) return { ...member, role: "owner" };
        if (member.userId === actorId && member.role === "owner") {
          return { ...member, role: "organizer" };
        }
        return member;
      }));
      setConfirmingOwnership(false);
      setOwnershipTarget("");
      setView("home");
      setNotice("Владелец группы изменён");
      window.setTimeout(() => setNotice(null), 2600);
    } catch (requestError) {
      showError(requestError);
    } finally {
      setTransferringOwnership(false);
    }
  }

  function toggleWatcher(userId: number) {
    setForm((current) => ({
      ...current,
      watcherUserIds: current.watcherUserIds.includes(userId)
        ? current.watcherUserIds.filter((id) => id !== userId)
        : [...current.watcherUserIds, userId],
    }));
  }

  function toggleWeekday(weekday: number) {
    setForm((current) => ({
      ...current,
      weekdays: current.weekdays.includes(weekday)
        ? current.weekdays.filter((day) => day !== weekday)
        : [...current.weekdays, weekday],
    }));
  }

  async function submitReminder() {
    if (!form.title.trim()) return;
    if (form.assignmentMode === "person" && !form.responsibleUserId) {
      showError("Выберите ответственного.");
      return;
    }
    if (form.frequency === "weekly" && form.weekdays.length === 0) {
      showError("Выберите хотя бы один день недели.");
      return;
    }
    setSaving(true);
    clearError();
    const amount = form.amountRub.trim() ? Math.round(Number(form.amountRub) * 100) : null;
    const responsibleUserId = Number(form.responsibleUserId);
    const editingReminder = reminders.find((reminder) =>
      reminder.reminderId === editingReminderId);
    const payload: CreateReminderBody = {
      kind: form.kind,
      title: form.title.trim(),
      description: form.description.trim() || null,
      actionUrl: form.actionUrl.trim() || null,
      amountMinor: form.kind === "payment" ? amount : null,
      currency: form.kind === "payment" && amount != null
        ? form.currency
        : null,
      visibility: form.visibility,
      assignment:
        form.assignmentMode === "anyone"
          ? { mode: "anyone" }
          : { mode: "person", responsibleUserId },
      watcherUserIds: form.watcherUserIds.filter((id) => id !== responsibleUserId),
      schedule: buildSchedule(form),
      timezone: editingReminder?.timezone ?? selectedWorkspace?.timezone ?? "Europe/Moscow",
      notificationPolicy: {
        leadMinutes: Number(form.leadMinutes),
        repeatIntervalMinutes: Number(form.repeatIntervalMinutes),
        ignoreQuietHours: form.ignoreQuietHours,
        escalation: editingReminder?.notificationPolicy.escalation ?? {
          enabled: true,
          delayMinutes: 1440,
          repeatMinutes: 1440,
        },
      },
    };

    try {
      if (editingReminderId && editingOccurrenceId && editScope === "occurrence") {
        const occurrencePayload: UpdateOccurrenceBody = {
          kind: payload.kind,
          title: payload.title,
          description: payload.description,
          actionUrl: payload.actionUrl,
          amountMinor: payload.amountMinor,
          currency: payload.currency,
          visibility: payload.visibility,
          assignment: payload.assignment,
          watcherUserIds: payload.watcherUserIds,
          timezone: payload.timezone,
          notificationPolicy: payload.notificationPolicy,
          dueLocalDate: occurrenceDate,
          timing: occurrenceAllDay ? { kind: "allDay" } : { kind: "timed", timeLocal: occurrenceTime },
        };
        await updateOccurrence(editingOccurrenceId, occurrencePayload);
        setNotice("Изменён только этот срок");
        setDetailTarget({ kind: "occurrence", id: editingOccurrenceId });
        setDetailReturnView("home");
        window.setTimeout(() => setNotice(null), 2600);
      } else if (editingReminderId) {
        await updateReminder(editingReminderId, payload);
        setNotice("Изменения сохранены для текущего и следующих повторов");
        window.setTimeout(() => setNotice(null), 2600);
      } else {
        await createReminder(payload);
      }
      setEditingReminderId(null);
      setEditingOccurrenceId(null);
      setEditScope("series");
      setView(editingOccurrenceId && editScope === "occurrence" ? "detail" : "plan");
      await refresh();
    } catch (requestError) {
      showError(requestError);
    } finally {
      setSaving(false);
    }
  }

  async function actOnOccurrence(
    occurrenceId: string,
    action: "complete" | "snooze",
    snoozeMinutes = 60,
  ) {
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setActingOccurrenceId(occurrenceId);
    clearError();
    try {
      if (action === "complete") {
        const { occurrence } = await completeOccurrence(occurrenceId);
        if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
        setOccurrences((current) =>
          current.filter((occurrence) => occurrence.occurrenceId !== occurrenceId),
        );
        setHistoryOccurrences((current) => [
          occurrence,
          ...current.filter((item) => item.occurrenceId !== occurrenceId),
        ]);
        setUndoableOccurrence(occurrence);
      } else {
        const { occurrence } = await snoozeOccurrence(occurrenceId, snoozeMinutes);
        if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
        setOccurrences((current) =>
          current.map((item) => (item.occurrenceId === occurrenceId ? occurrence : item)),
        );
        setNotice(snoozeMinutes === 60
          ? "Следующий сигнал — через час"
          : snoozeMinutes === 360
            ? "Следующий сигнал — вечером"
            : snoozeMinutes === 1440
              ? "Следующий сигнал — завтра"
              : `Следующий сигнал — через ${relativeDuration(occurrence.nextNotificationAt ?? occurrence.dueAt)}`);
      }
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setActingOccurrenceId(null);
      }
    }
  }

  async function undoLastCompletion() {
    if (!undoableOccurrence) return;
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setActingOccurrenceId(undoableOccurrence.occurrenceId);
    clearError();
    try {
      const { occurrence } = await undoOccurrenceCompletion(
        undoableOccurrence.occurrenceId,
      );
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setOccurrences((current) =>
        [...current, occurrence].sort(
          (left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime(),
        ),
      );
      setHistoryOccurrences((current) =>
        current.filter((item) => item.occurrenceId !== occurrence.occurrenceId),
      );
      setUndoableOccurrence(null);
      setNotice("Выполнение отменено");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        if (
          requestError instanceof ApiError &&
          (requestError.code === "undo_expired" || requestError.code === "not_actionable")
        ) {
          setUndoableOccurrence(null);
        }
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setActingOccurrenceId(null);
      }
    }
  }

  async function changeMemberRole(
    userId: number,
    role: "organizer" | "member",
  ) {
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setUpdatingRoleUserId(userId);
    clearError();
    try {
      const { member } = await updateMemberRole(userId, role);
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setMembers((current) =>
        current.map((item) => (item.userId === userId ? { ...item, role: member.role } : item)),
      );
      setNotice(role === "organizer" ? "Доступ организатора выдан" : "Доступ организатора отозван");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setUpdatingRoleUserId(null);
      }
    }
  }

  function editMemberDisplayName(member: WorkspaceMember) {
    setEditingMemberUserId(member.userId);
    setMemberDisplayNameDraft(member.displayName);
    clearError();
  }

  async function saveMemberDisplayName(
    member: WorkspaceMember,
    nextDisplayName: string | null,
  ) {
    const normalized = nextDisplayName?.trim() ?? null;
    if (normalized !== null && normalized.length === 0) {
      showError("Введите имя или верните имя из Telegram.");
      return;
    }
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setUpdatingDisplayNameUserId(member.userId);
    clearError();
    try {
      const { member: updated } = await updateMemberDisplayName(member.userId, normalized);
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setMembers((current) => current.map((item) =>
        item.userId === member.userId ? updated : item));
      setEditingMemberUserId(null);
      setMemberDisplayNameDraft("");
      setNotice(normalized === null ? "Имя из Telegram восстановлено" : "Имя участника обновлено");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setUpdatingDisplayNameUserId(null);
      }
    }
  }

  async function submitReassignment(reminderId: string) {
    const responsibleUserId = Number(reassignment[reminderId]);
    if (!responsibleUserId) {
      showError("Выберите нового ответственного.");
      return;
    }
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setReassigningReminderId(reminderId);
    clearError();
    try {
      const { reminder } = await reassignReminder(reminderId, responsibleUserId);
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setReminders((current) => current.map((item) => item.reminderId === reminderId ? reminder : item));
      setNotice(reminder.status === "active"
        ? "Ответственный изменён, напоминание снова активно"
        : "Ответственный изменён");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
      void refresh(actionWorkspaceId);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setReassigningReminderId(null);
      }
    }
  }

  async function manageReminder(
    reminder: Reminder,
    action: "pause" | "resume" | "archive",
  ) {
    const actionWorkspaceId = activeWorkspaceIdRef.current;
    if (!actionWorkspaceId) return;
    setManagingReminderId(reminder.reminderId);
    clearError();
    try {
      const { reminder: updated } = await changeReminderLifecycle(reminder.reminderId, action);
      if (activeWorkspaceIdRef.current !== actionWorkspaceId) return;
      setReminders((current) => current.map((item) => item.reminderId === reminder.reminderId ? updated : item));
      setNotice(action === "pause" ? "Серия приостановлена" : action === "resume" ? "Серия продолжена" : "Серия завершена");
      window.setTimeout(() => {
        if (activeWorkspaceIdRef.current === actionWorkspaceId) setNotice(null);
      }, 2600);
      void refresh(actionWorkspaceId);
    } catch (requestError) {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        showError(requestError);
      }
    } finally {
      if (activeWorkspaceIdRef.current === actionWorkspaceId) {
        setManagingReminderId(null);
      }
    }
  }

  const selectedWorkspace = workspaces.find((workspace) =>
    workspace.workspaceId === workspaceId);
  const resourceUnavailable = (resource: DashboardResource) =>
    failedDashboardResources.includes(resource) &&
    !loadedDashboardResources.includes(resource);
  const tasksUnavailable = resourceUnavailable("tasks");
  const planUnavailable = resourceUnavailable("plan");
  const membersUnavailable = resourceUnavailable("members");
  const selectedWorkspaceTimezone = selectedWorkspace
    ? describeTimezone(selectedWorkspace.timezone, timezoneReference)
    : null;
  const archiveDialog = archiveTarget ? (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) setArchiveTarget(null);
    }}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setArchiveTarget(null);
            return;
          }
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
          const nextIndex = event.shiftKey
            ? (currentIndex - 1 + controls.length) % controls.length
            : (currentIndex + 1) % controls.length;
          event.preventDefault();
          controls[nextIndex]?.focus();
        }}
      >
        <p className="eyebrow">Завершить серию</p>
        <h2 id="archive-dialog-title">Архивировать «{archiveTarget.title}»?</h2>
        <p>Новые уведомления больше не появятся. Выполненные и отменённые повторы останутся в истории.</p>
        <div className="confirm-dialog__actions">
          <button autoFocus type="button" onClick={() => setArchiveTarget(null)}>Оставить активной</button>
          <button
            className="danger-action"
            type="button"
            disabled={managingReminderId === archiveTarget.reminderId}
            onClick={() => void (async () => {
              await manageReminder(archiveTarget, "archive");
              setArchiveTarget(null);
              setView("plan");
            })()}
          >
            {managingReminderId === archiveTarget.reminderId ? "Архивирую…" : "Архивировать"}
          </button>
        </div>
      </section>
    </div>
  ) : null;

  if (telegramAuthMissing) {
    return (
      <main className="app app--launch-error">
        <header className="home-header">
          <div className="brand-mark" aria-label="ZvenFit"><span /><b>ZvenFit</b></div>
        </header>
        <section className="launch-error" role="alert">
          <div className="launch-error__status">
            <span className="launch-error__mark" aria-hidden="true"><UiIcon name="refresh" /></span>
            <p className="eyebrow">Панель не загрузилась</p>
          </div>
          <h1>Попробуйте обновить</h1>
          <p>
            Telegram не передал данные для входа. Обычно достаточно обновить панель.
          </p>
          <button className="recovery-action" type="button" onClick={() => window.location.reload()}>
            <span aria-hidden="true"><UiIcon name="refresh" /></span>
            Обновить
          </button>
          <a className="recovery-secondary" href={botUrl} target="_blank" rel="noreferrer">
            Открыть чат с ботом
            <UiIcon name="arrow-right" />
          </a>
          <small className="recovery-hint">
            В чате нажмите «Открыть панель» — Telegram передаст новую сессию автоматически.
          </small>
        </section>
      </main>
    );
  }

  if (loading && !hasLoadedDashboard) {
    return <InitialDashboardSkeleton />;
  }

  if (workspaces.length === 0) {
    return (
      <main className="app app--launch-error app--workspace-recovery">
        <header className="home-header">
          <div className="brand-mark" aria-label="ZvenFit"><span /><b>ZvenFit</b></div>
        </header>
        <section className="launch-error workspace-recovery" role="status" aria-busy={loading}>
          <div className="launch-error__status">
            <span className="launch-error__mark" aria-hidden="true">{loading ? "···" : <UiIcon name="refresh" />}</span>
            <p className="eyebrow">
              {loading ? "Проверяем доступ" : error ? "Не удалось загрузить" : "Группа не найдена"}
            </p>
          </div>
          <h1>
            {loading ? "Ищем ваши группы" : error ? "Попробуйте ещё раз" : "Обновите список групп"}
          </h1>
          <p>
            {loading
              ? `Проверяем группы для ${telegramAccountLabel}.`
              : error
                ? "Не получилось получить данные. Проверьте соединение и обновите панель."
                : <>Для аккаунта <b>{telegramAccountLabel}</b> группы не найдены. Если
                    команда <b>/setup</b> уже выполнена, обновите список.</>}
          </p>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          {!loading ? (
            <div className="workspace-recovery__actions">
              <button className="recovery-action" type="button" onClick={retryWorkspaceLoad}>
                <span aria-hidden="true"><UiIcon name="refresh" /></span>
                Обновить
              </button>
              <a className="recovery-secondary" href={botUrl} target="_blank" rel="noreferrer">
                Открыть чат с ботом
                <UiIcon name="arrow-right" />
              </a>
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  if (view === "members" && selectedWorkspace) {
    return (
      <main className="app app--members">
        <header className="topbar">
          <BackButton onClick={() => setView(membersReturnView)} />
          <span className="utility-label">{selectedWorkspace.displayName}</span>
        </header>

        <section className="members-intro">
          <div>
            <p className="eyebrow">Участники группы</p>
            <h1>Кто может отвечать</h1>
            <p>В списке только люди, которых бот уже встретил и связал с этой Telegram-группой.</p>
          </div>
          <div
            className="member-constellation"
            aria-label={membersUnavailable
              ? "Участники не загружены"
              : `Подтверждено участников: ${members.length}`}
          >
            <div className="member-constellation__avatars" aria-hidden="true">
              {members.slice(0, 4).map((member) => (
                <MemberAvatar member={member} size="regular" key={member.userId} />
              ))}
              {members.length > 4 ? <span>+{members.length - 4}</span> : null}
            </div>
            <span>
              <b>{membersUnavailable ? "—" : members.length}</b>
              <small>{membersUnavailable ? "не загружено" : "подтверждено"}</small>
            </span>
            <button type="button" disabled={refreshingMembers} onClick={() => void refreshMemberRoster()}>
              {refreshingMembers ? "Обновляю…" : "Обновить"}
            </button>
          </div>
        </section>

        {dashboardLoadError && membersUnavailable ? (
          <RequestErrorBanner
            message={dashboardLoadError}
            recovery={{ label: "Загрузить участников", onRetry: () => void refresh() }}
          />
        ) : null}

        <section className="member-roster-panel">
          <label className="member-search">
            <span aria-hidden="true"><UiIcon name="search" /></span>
            <input
              type="search"
              aria-label="Найти участника"
              placeholder="Имя, Telegram или @username"
              value={memberSearch}
              onChange={(event) => setMemberSearch(event.target.value)}
            />
          </label>

          <div className="member-roster" role="list" aria-label="Подтверждённые участники">
            {membersUnavailable ? (
              <div className="resource-unavailable" role="status">
                <b>Список пока не загружен</b>
                <span>После загрузки участники появятся здесь.</span>
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="member-roster__empty">
                <b>Никого не нашли</b>
                <span>Проверьте имя или username.</span>
              </div>
            ) : filteredMembers.map((member) => {
              const canEditDisplayName = actor?.userId === member.userId ||
                actor?.role === "owner" ||
                (actor?.role === "organizer" && member.role !== "owner");
              const editingDisplayName = editingMemberUserId === member.userId;
              const updatingDisplayName = updatingDisplayNameUserId === member.userId;
              return (
                <article className="member-roster__row" role="listitem" key={member.userId}>
                  <MemberAvatar member={member} />
                  <span className="member-roster__identity">
                    <span className="member-roster__identity-line">
                      <b>{member.displayName}{member.userId === actorId ? " · вы" : ""}</b>
                      {canEditDisplayName ? (
                        <button
                          className="member-name-edit"
                          type="button"
                          aria-label={`Переименовать ${member.displayName}`}
                          aria-expanded={editingDisplayName}
                          onClick={() => editingDisplayName
                            ? setEditingMemberUserId(null)
                            : editMemberDisplayName(member)}
                        >
                          <span aria-hidden="true"><UiIcon name="edit" /></span>
                        </button>
                      ) : null}
                    </span>
                    <small>{memberTelegramIdentity(member)}</small>
                  </span>
                  <span className={`member-chat-state${member.privateChatAvailable ? " is-ready" : ""}`}>
                    {member.privateChatAvailable ? "Личный чат подключён" : "Только группа"}
                  </span>
                  {actor?.role === "owner" && member.role !== "owner" ? (
                    <select
                      aria-label={`Роль: ${member.displayName}`}
                      disabled={updatingRoleUserId === member.userId}
                      value={member.role === "organizer" ? "organizer" : "member"}
                      onChange={(event) => void changeMemberRole(
                        member.userId,
                        event.target.value as "organizer" | "member",
                      )}
                    >
                      <option value="member">Участник</option>
                      <option value="organizer">Организатор</option>
                    </select>
                  ) : (
                    <span className={`member-role member-role--${member.role}`}>
                      {memberRoleLabel(member.role)}
                    </span>
                  )}
                  {editingDisplayName ? (
                    <form
                      className="member-name-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveMemberDisplayName(member, memberDisplayNameDraft);
                      }}
                    >
                      <label>
                        <span>Имя в этой группе</span>
                        <input
                          type="text"
                          autoFocus
                          maxLength={80}
                          value={memberDisplayNameDraft}
                          onChange={(event) => setMemberDisplayNameDraft(event.target.value)}
                        />
                      </label>
                      <small>Telegram-профиль останется «{member.telegramDisplayName}».</small>
                      <div>
                        {member.displayNameOverride ? (
                          <button
                            type="button"
                            disabled={updatingDisplayName}
                            onClick={() => void saveMemberDisplayName(member, null)}
                          >
                            Как в Telegram
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={updatingDisplayName}
                          onClick={() => setEditingMemberUserId(null)}
                        >
                          Отмена
                        </button>
                        <button
                          className="primary-action"
                          type="submit"
                          disabled={updatingDisplayName || memberDisplayNameDraft.trim().length === 0}
                        >
                          {updatingDisplayName ? "Сохраняю…" : "Сохранить"}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        <section className="member-enrollment-panel">
          <span className="member-enrollment-panel__signal" aria-hidden="true"><UiIcon name="plus" /></span>
          <div>
            <p className="eyebrow">Подключение</p>
            <h2>Позвать остальных</h2>
            <p>
              В группе появится сообщение с кнопкой. Каждый человек добавит только себя,
              а бот проверит его участие перед сохранением.
            </p>
          </div>
          {!confirmingEnrollment ? (
            <button
              className="primary-action member-enrollment-panel__action"
              type="button"
              onClick={() => setConfirmingEnrollment(true)}
            >
              Позвать
            </button>
          ) : (
            <div className="member-enrollment-confirm" role="alert">
              <b>Отправить сообщение в «{selectedWorkspace.displayName}»?</b>
              <small>Оно будет видно всем участникам группы.</small>
              <div>
                <button type="button" onClick={() => setConfirmingEnrollment(false)}>Отмена</button>
                <button
                  className="primary-action"
                  type="button"
                  disabled={publishingEnrollment}
                  onClick={() => void publishEnrollment()}
                >
                  {publishingEnrollment ? "Отправляю…" : "Да, позвать"}
                </button>
              </div>
            </div>
          )}
          <small className="member-enrollment-panel__hint">
            Новые вступления и действия в группе бот также обнаруживает автоматически.
          </small>
        </section>

        {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
        {notice ? <div className="notice-toast notice-toast--inline" role="status">{notice}</div> : null}
      </main>
    );
  }

  if (view === "settings" && selectedWorkspace) {
    const targetMember = members.find((member) => String(member.userId) === ownershipTarget);
    return (
      <main className="app app--form app--settings">
        <header className="topbar">
          <BackButton onClick={() => {
            if (editingOccurrenceId) {
              setDetailTarget({ kind: "occurrence", id: editingOccurrenceId });
              setView("detail");
            } else {
              setView("plan");
            }
          }} />
          <span className="utility-label">{selectedWorkspace.displayName}</span>
        </header>

        <section className="form-intro settings-intro">
          <p className="eyebrow">Ритм группы</p>
          <h1>Когда можно звенеть</h1>
          <p>Эти правила действуют для всей группы. Срочные напоминания могут обходить тихие часы.</p>
        </section>

        <form
          className="reminder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveWorkspaceSettings();
          }}
        >
          <section
            className="rhythm-map"
            aria-label="Карта ритма группы"
            style={{
              "--quiet-start": timePosition(settingsForm.quietHoursStart),
              "--quiet-end": timePosition(settingsForm.quietHoursEnd),
              "--all-day-time": timePosition(settingsForm.defaultAllDayReminderTime),
            } as CSSProperties}
          >
            <div className="rhythm-map__heading">
              <span><small>Тишина</small><b>{settingsForm.quietHoursStart} → {settingsForm.quietHoursEnd}</b></span>
              <span><small>Напоминания на весь день</small><b>{settingsForm.defaultAllDayReminderTime}</b></span>
            </div>
            <div className="rhythm-map__line" aria-hidden="true">
              <i className="rhythm-map__night" />
              <i className="rhythm-map__signal" />
            </div>
            <div className="rhythm-map__ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          </section>

          <section className="form-panel settings-panel">
            <p className="eyebrow">Часовой пояс</p>
            <h2>Местное время группы</h2>
            <label className="field timezone-field">
              <span>Город или часовой пояс</span>
              <span className="timezone-input-wrap">
                <span className="timezone-input-wrap__mark" aria-hidden="true"><UiIcon name="location" /></span>
                <input
                  list="timezone-options"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Например, Москва или Europe/Berlin"
                  value={settingsForm.timezone}
                  aria-describedby="timezone-help"
                  onChange={(event) => setSettingsForm({ ...settingsForm, timezone: event.target.value })}
                />
              </span>
              <datalist id="timezone-options">
                {timezoneOptions.map((timezone) => (
                  <option key={timezone.id} value={timezone.id} label={timezone.optionLabel} />
                ))}
              </datalist>
            </label>

            <div className={`timezone-preview${selectedTimezone ? "" : " timezone-preview--invalid"}`} aria-live="polite">
              <span className="timezone-preview__clock">
                <small>Сейчас</small>
                <b>{selectedTimezone?.localTime ?? "—:—"}</b>
              </span>
              <span className="timezone-preview__place">
                <b>{selectedTimezone?.city ?? "Выберите город"}</b>
                <small>{selectedTimezone ? `${selectedTimezone.region} · ${selectedTimezone.offset}` : "Нужна корректная IANA-зона"}</small>
                <code>{settingsForm.timezone || DEFAULT_TIMEZONE}</code>
              </span>
              {settingsForm.timezone === DEFAULT_TIMEZONE ? <span className="timezone-preview__default">По умолчанию</span> : null}
            </div>

            {deviceTimezonePresentation ? (
              <button
                className="timezone-device"
                type="button"
                aria-pressed={settingsForm.timezone === deviceTimezone}
                onClick={() => setSettingsForm({ ...settingsForm, timezone: deviceTimezone })}
              >
                <span className="timezone-device__icon" aria-hidden="true"><UiIcon name="target" /></span>
                <span>
                  <b>Время устройства</b>
                  <small>{deviceTimezonePresentation.city} · {deviceTimezonePresentation.offset}</small>
                </span>
                <strong>{settingsForm.timezone === deviceTimezone ? "Выбрано" : "Использовать"}</strong>
              </button>
            ) : null}

            <p className="timezone-help" id="timezone-help">
              Новые напоминания возьмут это местное время. Уже созданные сохранят свой график.
            </p>
          </section>

          <section className="form-panel settings-panel">
            <p className="eyebrow">Не беспокоить</p>
            <h2>Тихие часы</h2>
            <div className="schedule-grid">
              <label className="field">
                <span>Начало тишины</span>
                <Time24Field
                  label="Начало тишины"
                  required
                  value={settingsForm.quietHoursStart}
                  onChange={(quietHoursStart) => setSettingsForm({ ...settingsForm, quietHoursStart })}
                />
              </label>
              <label className="field">
                <span>Конец тишины</span>
                <Time24Field
                  label="Конец тишины"
                  required
                  value={settingsForm.quietHoursEnd}
                  onChange={(quietHoursEnd) => setSettingsForm({ ...settingsForm, quietHoursEnd })}
                />
              </label>
              <label className="field field--wide">
                <span>Напоминать о событиях «на весь день»</span>
                <Time24Field
                  label="Время напоминаний на весь день"
                  required
                  value={settingsForm.defaultAllDayReminderTime}
                  onChange={(defaultAllDayReminderTime) => setSettingsForm({
                    ...settingsForm,
                    defaultAllDayReminderTime,
                  })}
                />
              </label>
            </div>
          </section>

          {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
          {notice ? <div className="notice-toast notice-toast--inline" role="status">{notice}</div> : null}

          <button className="settings-save primary-action" type="submit" disabled={settingsSaving}>
            {settingsSaving ? "Сохраняю…" : "Сохранить настройки"}
          </button>
        </form>

        {selectedWorkspace.role === "owner" ? (
          <section className="ownership-panel">
            <p className="eyebrow">Владелец</p>
            <h2>Передача управления</h2>
            <p>Новый владелец сможет назначать организаторов и передавать эту роль дальше. Вы останетесь организатором.</p>
            {!confirmingOwnership ? (
              <div className="ownership-controls">
                <label className="field">
                  <span>Новый владелец</span>
                  <select value={ownershipTarget} onChange={(event) => setOwnershipTarget(event.target.value)}>
                    <option value="">Выберите участника</option>
                    {members.filter((member) => member.userId !== actorId).map((member) => (
                      <option key={member.userId} value={member.userId}>{member.displayName}</option>
                    ))}
                  </select>
                </label>
                <button className="danger-action" type="button" disabled={!ownershipTarget} onClick={() => setConfirmingOwnership(true)}>
                  Передать управление
                </button>
              </div>
            ) : (
              <div className="ownership-confirm" role="alert">
                <b>Передать управление участнику «{targetMember?.displayName}»?</b>
                <p>Это действие сразу изменит владельца группы.</p>
                <div>
                  <button type="button" onClick={() => setConfirmingOwnership(false)}>Отмена</button>
                  <button className="danger-action" type="button" disabled={transferringOwnership} onClick={() => void confirmOwnershipTransfer()}>
                    {transferringOwnership ? "Передаю…" : "Да, передать"}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : null}
      </main>
    );
  }

  if (view === "detail" && detailTarget) {
    const occurrence = detailTarget.kind === "occurrence"
      ? [...occurrences, ...historyOccurrences, ...(undoableOccurrence ? [undoableOccurrence] : [])]
        .find((item) => item.occurrenceId === detailTarget.id)
      : undefined;
    const reminder = detailTarget.kind === "reminder"
      ? reminderMap.get(detailTarget.id)
      : occurrence ? reminderMap.get(occurrence.reminderId) : undefined;
    const detailTimezone = occurrence?.timezone ?? reminder?.timezone ?? selectedWorkspace?.timezone ?? "Europe/Moscow";
    const responsibleUserId = occurrence?.assignment.mode === "person"
      ? occurrence.assignment.responsibleUserId
      : reminder?.assignment.mode === "person" ? reminder.assignment.responsibleUserId : undefined;
    const responsible = responsibleUserId ? memberMap.get(responsibleUserId) : undefined;
    const amount = formatAmount(
      occurrence?.amountMinor ?? reminder?.amountMinor ?? null,
      occurrence?.currency ?? reminder?.currency ?? null,
    );
    const isManager = actor?.role === "owner" || actor?.role === "organizer";
    const isResponsible = responsibleUserId === actorId;
    const isCreator = reminder?.creatorUserId === actorId;
    const canManageReminder = Boolean(reminder && (
      reminder.visibility === "group" ? isManager : isCreator || isResponsible
    ));
    const canAct = Boolean(occurrence && (
      occurrence.visibility === "private"
        ? isCreator || isResponsible
        : isCreator || isManager || isResponsible || occurrence.assignment.mode === "anyone"
    ));
    const canSnooze = Boolean(occurrence && (
      occurrence.visibility === "private" ? isCreator || isResponsible : isCreator || isManager || isResponsible
    ));
    const nextDates = reminder ? upcomingScheduleDates(reminder.schedule, reminder.timezone, 3) : [];
    const timeline = occurrence ? [
      occurrence.createdAt ? {
        label: "Напоминание создано",
        value: formatMoment(occurrence.createdAt, detailTimezone, true),
      } : null,
      occurrence.snoozedAt ? {
        label: "Сигнал отложен",
        value: `${formatMoment(occurrence.snoozedAt, detailTimezone, true)}${occurrence.snoozeUntil ? ` · до ${formatMoment(occurrence.snoozeUntil, detailTimezone)}` : ""}`,
      } : null,
      occurrence.completedAt ? {
        label: occurrence.kind === "payment" ? "Оплату отметил" : "Выполнение отметил",
        value: `${occurrence.completedByDisplayName ?? memberName(occurrence.completedBy ? memberMap.get(occurrence.completedBy) : undefined)} · ${formatMoment(occurrence.completedAt, detailTimezone, true)}`,
      } : null,
      occurrence.cancelledAt ? {
        label: "Повтор отменён",
        value: `${occurrence.cancelledBy ? memberName(memberMap.get(occurrence.cancelledBy)) : "Участник"} · ${formatMoment(occurrence.cancelledAt, detailTimezone, true)}`,
      } : null,
    ].filter((item): item is { label: string; value: string } => Boolean(item)) : [];

    if (!occurrence && !reminder) {
      return (
        <main className="app app--detail">
          <header className="topbar"><BackButton onClick={() => switchMainView(detailReturnView)} /><span className="utility-label">Детали</span></header>
          <section className="detail-empty"><h1>Напоминание уже недоступно</h1><p>Вернитесь к списку и обновите данные.</p></section>
        </main>
      );
    }

    return (
      <main className="app app--detail">
        <header className="topbar">
          <BackButton onClick={() => switchMainView(detailReturnView)} />
          <span className="utility-label">{selectedWorkspace?.displayName ?? "Детали"}</span>
        </header>

        <section className="detail-hero">
          <div className="detail-hero__status">
            <span className={`detail-state detail-state--${occurrence?.status ?? reminder?.status}`}>
              {occurrence ? occurrenceStatusLabel(occurrence) : reminder?.status === "paused" ? "На паузе" : "Серия активна"}
            </span>
            <span className="visibility-badge">{(occurrence?.visibility ?? reminder?.visibility) === "private" ? "личное" : "группа"}</span>
          </div>
          <h1>{occurrence?.title ?? reminder?.title}</h1>
          {(occurrence?.description ?? reminder?.description) ? <p>{occurrence?.description ?? reminder?.description}</p> : null}
          {amount ? <b className="detail-amount">{amount}</b> : null}
          {(occurrence?.actionUrl ?? reminder?.actionUrl) ? (
            <a className="detail-link" href={occurrence?.actionUrl ?? reminder?.actionUrl ?? undefined} target="_blank" rel="noreferrer">
              Открыть связанную страницу <UiIcon name="arrow-right" />
            </a>
          ) : null}
        </section>

        <section className="detail-facts" aria-label="Параметры напоминания">
          {occurrence ? (
            <div><span>Срок</span><b>{formatMoment(occurrence.dueAt, detailTimezone, true)}</b><small>{occurrence.status === "overdue" ? `Просрочено на ${relativeDuration(occurrence.dueAt)}` : occurrence.status === "pending" ? `Через ${relativeDuration(occurrence.dueAt)}` : occurrenceStatusLabel(occurrence)}</small></div>
          ) : null}
          {reminder ? <div><span>Ритм</span><b>{scheduleLabel(reminder.schedule)}</b><small>{reminder.status === "paused" ? "Новые сигналы приостановлены" : "Повторяется автоматически"}</small></div> : null}
          <div><span>Ответственный</span><b>{responsibleUserId ? memberName(responsible) : "Любой участник"}</b><small>{responsible?.username ? `@${responsible.username}` : responsibleUserId ? "Участник группы" : "Кто отметит первым"}</small></div>
          {occurrence?.nextNotificationAt && occurrence.status !== "completed" && occurrence.status !== "cancelled" ? (
            <div><span>Следующий сигнал</span><b>Через {relativeDuration(occurrence.nextNotificationAt)}</b><small>{formatMoment(occurrence.nextNotificationAt, detailTimezone, true)}</small></div>
          ) : reminder ? (
            <div><span>Повтор сигнала</span><b>Каждые {relativeDuration(new Date(Date.now() + reminder.notificationPolicy.repeatIntervalMinutes * 60_000).toISOString())}</b><small>{reminder.notificationPolicy.ignoreQuietHours ? "Даже в тихие часы" : "С учётом тихих часов"}</small></div>
          ) : null}
        </section>

        {occurrence && (occurrence.status === "pending" || occurrence.status === "overdue") && (canAct || canSnooze) ? (
          <section className="detail-actions" aria-label="Действия с напоминанием">
            {canAct ? <button className="primary-action" type="button" disabled={actingOccurrenceId === occurrence.occurrenceId} onClick={() => void actOnOccurrence(occurrence.occurrenceId, "complete")}>
              {occurrence.kind === "payment" ? "Отметить оплату" : "Отметить выполнение"}
            </button> : null}
            {canSnooze ? <div className="detail-snooze"><span>Напомнить позже</span><div>
              <button type="button" onClick={() => void actOnOccurrence(occurrence.occurrenceId, "snooze", 60)}>Через час</button>
              <button type="button" onClick={() => void actOnOccurrence(occurrence.occurrenceId, "snooze", 360)}>Вечером</button>
              <button type="button" onClick={() => void actOnOccurrence(occurrence.occurrenceId, "snooze", 1440)}>Завтра</button>
            </div></div> : null}
          </section>
        ) : null}

        {reminder && nextDates.length > 0 ? (
          <section className="detail-section">
            <p className="eyebrow">Ближайшие сроки</p>
            <div className="upcoming-dates upcoming-dates--large">
              {nextDates.map((date, index) => <span key={date}><small>{index === 0 ? "следующий" : `+${index}`}</small><b>{formatScheduleDate(date)}</b></span>)}
            </div>
          </section>
        ) : null}

        {timeline.length > 0 ? (
          <section className="detail-section">
            <p className="eyebrow">История этого повтора</p>
            <ol className="event-timeline">
              {timeline.map((event) => <li key={`${event.label}-${event.value}`}><span /><div><b>{event.label}</b><small>{event.value}</small></div></li>)}
            </ol>
            {occurrence?.cancellationReason ? <p className="cancellation-note">Причина: {occurrence.cancellationReason}</p> : null}
          </section>
        ) : null}

        {reminder && canManageReminder ? (
          <section className="detail-management">
            <button type="button" onClick={() => openEdit(reminder, occurrence)}>Изменить</button>
            {reminder.status !== "archived" ? <button type="button" disabled={managingReminderId === reminder.reminderId} onClick={() => void manageReminder(reminder, reminder.status === "paused" ? "resume" : "pause")}>{reminder.status === "paused" ? "Продолжить" : "Поставить на паузу"}</button> : null}
            {reminder.status !== "archived" ? <button className="danger-link" type="button" onClick={() => setArchiveTarget(reminder)}>Архивировать</button> : null}
          </section>
        ) : null}
        {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
        {notice ? <div className="notice-toast" role="status">{notice}</div> : null}
        {archiveDialog}
      </main>
    );
  }

  if (view === "plan") {
    return (
      <main className="app app--main-view app--plan">
        <header className="home-header"><div className="brand-mark" aria-label="ZvenFit"><span /><b>ZvenFit</b></div>{workspaces.length > 1 ? <WorkspaceSelect compact workspaces={workspaces} value={workspaceId ?? ""} onChange={(nextWorkspaceId) => void changeWorkspace(nextWorkspaceId)} /> : <span className="utility-label">{selectedWorkspace?.displayName}</span>}</header>
        <section className="main-view-intro">
          <div><p className="eyebrow">Будущие сроки</p><h1>План</h1><p>Серии и три ближайших повтора — без завершённых задач.</p></div>
          <div className="scope-switch" role="tablist" aria-label="Область плана" onKeyDown={handleRovingControlKey}>
            <button aria-selected={scope === "mine"} className={scope === "mine" ? "is-selected" : ""} onClick={() => setScope("mine")} role="tab" type="button">Моя лента</button>
            <button aria-selected={scope === "group"} className={scope === "group" ? "is-selected" : ""} onClick={() => setScope("group")} role="tab" type="button">Вся группа</button>
          </div>
        </section>
        {dashboardLoadError && planUnavailable ? (
          <RequestErrorBanner
            message={dashboardLoadError}
            recovery={{ label: "Загрузить план", onRetry: () => void refresh() }}
          />
        ) : null}
        {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
        {notice ? <div className="notice-toast" role="status">{notice}</div> : null}
        {planUnavailable ? (
          <div className="resource-unavailable" role="status">
            <b>План пока не загружен</b>
            <span>Серии и ближайшие сроки появятся после загрузки.</span>
          </div>
        ) : loading ? <div className="plan-list skeleton-list"><i /><i /><i /></div> : visibleReminders.length === 0 ? (
          <button className="empty-plan" onClick={openCreate}><b>План пока пуст</b><span>Добавьте разовый срок или повторяющуюся серию.</span></button>
        ) : (
          <section className="plan-list plan-list--primary" aria-label="Запланированные серии">
            {visibleReminders.map((reminder) => {
              const responsible = reminder.assignment.mode === "person" ? memberMap.get(reminder.assignment.responsibleUserId) : undefined;
              const missingResponsible = reminder.assignment.mode === "person" && !responsible;
              const dates = planDates.get(reminder.reminderId) ?? [];
              return (
                <article className={`plan-row plan-row--${reminder.status}`} key={reminder.reminderId}>
                  <button className="plan-row__open" type="button" onClick={() => openReminderDetail(reminder.reminderId)}>
                    <span className="plan-date" aria-hidden="true"><UiIcon name={reminder.schedule.frequency === "once" ? "once" : "repeat"} /></span>
                    <span className="plan-copy"><span className="plan-copy__title"><b>{reminder.title}</b><i className={`status-dot status-dot--${reminder.status}`} /></span><span>{scheduleLabel(reminder.schedule)}</span><small>{reminder.assignment.mode === "anyone" ? "Любой участник" : memberName(responsible)}</small></span>
                    <UiIcon name="arrow-right" />
                  </button>
                  {dates.length > 0 ? <div className="upcoming-dates" aria-label="Три ближайших срока">{dates.map((date, index) => <span key={date} className={index === 0 ? "is-next" : ""}>{formatScheduleDate(date, true)}</span>)}</div> : <p className="plan-ended">Будущих сроков нет</p>}
                  {reminder.status === "paused" && reminder.assignment.mode === "person" && missingResponsible && (actor?.role === "owner" || actor?.role === "organizer") ? (
                    <div className="reassign-row"><span>Ответственный вышел — выберите нового</span><select aria-label={`Новый ответственный: ${reminder.title}`} value={reassignment[reminder.reminderId] ?? ""} onChange={(event) => setReassignment((current) => ({ ...current, [reminder.reminderId]: event.target.value }))}><option value="">Выбрать участника</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select><button type="button" disabled={reassigningReminderId === reminder.reminderId} onClick={() => void submitReassignment(reminder.reminderId)}>{reassigningReminderId === reminder.reminderId ? "Сохраняю…" : "Переназначить"}</button></div>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}
        <BottomNavigation view="plan" onChange={switchMainView} onCreate={openCreate} createDisabled={!workspaceId} />
        {archiveDialog}
      </main>
    );
  }

  if (view === "history") {
    return (
      <main className="app app--main-view app--history">
        <header className="home-header"><div className="brand-mark" aria-label="ZvenFit"><span /><b>ZvenFit</b></div>{workspaces.length > 1 ? <WorkspaceSelect compact workspaces={workspaces} value={workspaceId ?? ""} onChange={(nextWorkspaceId) => void changeWorkspace(nextWorkspaceId)} /> : <span className="utility-label">{selectedWorkspace?.displayName}</span>}</header>
        <section className="main-view-intro">
          <div><p className="eyebrow">Журнал действий</p><h1>История</h1><p>Что завершили или отменили, кто это сделал и когда.</p></div>
          <div className="scope-switch" role="tablist" aria-label="Область истории" onKeyDown={handleRovingControlKey}>
            <button aria-selected={scope === "mine"} className={scope === "mine" ? "is-selected" : ""} onClick={() => setScope("mine")} role="tab" type="button">Моя лента</button>
            <button aria-selected={scope === "group"} className={scope === "group" ? "is-selected" : ""} onClick={() => setScope("group")} role="tab" type="button">Вся группа</button>
          </div>
        </section>
        {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
        {historyError ? (
          <RequestErrorBanner
            message={historyError}
            recovery={{ label: "Загрузить историю", onRetry: () => void refreshHistory() }}
          />
        ) : null}
        {notice ? <div className="notice-toast" role="status">{notice}</div> : null}
        {loading || historyLoading ? <div className="history-list skeleton-list"><i /><i /><i /></div> : visibleHistory.length === 0 ? (
          <div className="quiet-state"><span className="quiet-pulse"><UiIcon name="history" /></span><div><b>История пока пуста</b><p>Завершённые и отменённые напоминания появятся здесь.</p></div></div>
        ) : (
          <section className="history-list" aria-label="История напоминаний">
            {visibleHistory.map((occurrence) => {
              const responsible = occurrence.assignment.mode === "person" ? memberMap.get(occurrence.assignment.responsibleUserId) : undefined;
              const actorName = occurrence.status === "completed"
                ? occurrence.completedByDisplayName ?? (occurrence.completedBy ? memberName(memberMap.get(occurrence.completedBy)) : "Участник")
                : occurrence.cancelledBy ? memberName(memberMap.get(occurrence.cancelledBy)) : "Участник";
              const actionAt = occurrence.completedAt ?? occurrence.cancelledAt ?? occurrence.updatedAt ?? occurrence.dueAt;
              return (
                <button className="history-row" type="button" onClick={() => openOccurrenceDetail(occurrence.occurrenceId, "history")} key={occurrence.occurrenceId}>
                  <span className={`history-row__mark history-row__mark--${occurrence.status}`}><UiIcon name={occurrence.status === "completed" ? "check" : "history"} /></span>
                  <span className="history-row__copy"><b>{occurrence.title}</b><span>{occurrenceStatusLabel(occurrence)} · {actorName}</span><small>{formatMoment(actionAt, occurrence.timezone, true)} · {occurrence.assignment.mode === "anyone" ? "Любой участник" : memberName(responsible)}</small></span>
                  <UiIcon name="arrow-right" />
                </button>
              );
            })}
          </section>
        )}
        <BottomNavigation view="history" onChange={switchMainView} onCreate={openCreate} createDisabled={!workspaceId} />
      </main>
    );
  }

  if (view === "create") {
    const selectedResponsible = memberMap.get(Number(form.responsibleUserId));
    const canAssignGroup = actor?.role === "owner" || actor?.role === "organizer";
    const previewResponsible = form.assignmentMode === "anyone"
      ? "Может выполнить любой участник"
      : selectedResponsible ? `Ответственный — ${memberName(selectedResponsible)}` : "Выберите ответственного";
    const previewTimezone = reminders.find((reminder) => reminder.reminderId === editingReminderId)?.timezone ?? selectedWorkspace?.timezone ?? "Europe/Moscow";
    const previewDates = editingOccurrenceId && editScope === "occurrence"
      ? [occurrenceDate]
      : formUpcomingDates(form, previewTimezone);
    return (
      <main className="app app--form">
        <header className="topbar">
          <BackButton onClick={() => {
            if (editingOccurrenceId) {
              setDetailTarget({ kind: "occurrence", id: editingOccurrenceId });
              setView("detail");
            } else {
              setView("plan");
            }
          }} />
          <span className="utility-label">
            {editingReminderId ? "Редактирование" : selectedWorkspace?.displayName ?? "Новое"}
          </span>
        </header>

        <section className="form-intro">
          <p className="eyebrow">{editingReminderId
            ? editScope === "occurrence" ? "Один срок" : "Серия"
            : form.kind === "payment" ? "Платёж" : "Поручение"}</p>
          <h1>{editingReminderId ? "Что изменить?" : "О чём не дать забыть?"}</h1>
          <p>{editingReminderId
            ? editScope === "occurrence"
              ? "Изменится только открытый сейчас срок. Ритм серии и следующие повторы останутся прежними."
              : "Новые параметры применятся к текущему незавершённому напоминанию и следующим повторам. История не изменится."
            : form.kind === "payment"
              ? "Бот будет возвращать напоминание, пока ответственный не отметит оплату."
              : "Бот будет возвращать напоминание, пока ответственный не отметит выполнение."}</p>
        </section>

        {editingOccurrenceId ? (
          <section className="edit-scope" aria-labelledby="edit-scope-title">
            <div><p className="eyebrow">Область изменений</p><h2 id="edit-scope-title">Что именно изменить?</h2></div>
            <div className="edit-scope__options" role="radiogroup" aria-label="Область редактирования" onKeyDown={handleRovingControlKey}>
              <button className={editScope === "occurrence" ? "is-selected" : ""} type="button" role="radio" aria-checked={editScope === "occurrence"} onClick={() => setEditScope("occurrence")}><b>Только этот срок</b><small>{formatScheduleDate(occurrenceDate)}</small></button>
              <button className={editScope === "series" ? "is-selected" : ""} type="button" role="radio" aria-checked={editScope === "series"} onClick={() => setEditScope("series")}><b>Этот и следующие</b><small>Изменить ритм серии</small></button>
            </div>
          </section>
        ) : null}

        <form
          className="reminder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReminder();
          }}
        >
          <section className="form-panel form-panel--primary">
            <div className="kind-field">
              <span>Что создаём</span>
              <div className="kind-switch" role="radiogroup" aria-label="Тип напоминания" onKeyDown={handleRovingControlKey}>
                <button
                  aria-checked={form.kind === "task"}
                  className={form.kind === "task" ? "kind-option is-selected" : "kind-option"}
                  role="radio"
                  type="button"
                  onClick={() => setForm({ ...form, kind: "task" })}
                >
                  <span className="kind-option__mark" aria-hidden="true"><UiIcon name="check" /></span>
                  <span><b>Поручение</b><small>Сделать и отметить</small></span>
                </button>
                <button
                  aria-checked={form.kind === "payment"}
                  className={form.kind === "payment" ? "kind-option is-selected" : "kind-option"}
                  role="radio"
                  type="button"
                  onClick={() => setForm({ ...form, kind: "payment" })}
                >
                  <span className="kind-option__mark" aria-hidden="true"><UiIcon name="payment" /></span>
                  <span><b>Платёж</b><small>Оплатить к сроку</small></span>
                </button>
              </div>
            </div>
            <label className="field field--hero">
              <span>{form.kind === "payment" ? "Что нужно оплатить" : "Что нужно сделать"}</span>
              <input
                autoFocus
                maxLength={200}
                placeholder={form.kind === "payment"
                  ? "Например, домашний интернет"
                  : "Например, передать показания"}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>
            <details className="additional-fields">
              <summary>Дополнительные настройки</summary>
              <div className="additional-fields__body">
                {form.kind === "payment" ? (
                  <label className="field field--amount">
                    <span>Сумма <small>можно добавить позже</small></span>
                    <span className="amount-input">
                      <input
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        type="number"
                        placeholder="0"
                        value={form.amountRub}
                        onChange={(event) => setForm({ ...form, amountRub: event.target.value })}
                      />
                      <b>{form.currency === "RUB" ? "₽" : form.currency}</b>
                    </span>
                  </label>
                ) : null}
                <label className="field">
                  <span>{form.kind === "payment" ? "Получатель или детали" : "Детали"} <small>необязательно</small></span>
                  <textarea
                    rows={3}
                    maxLength={2000}
                    placeholder={form.kind === "payment"
                      ? "Реквизиты, назначение или комментарий"
                      : "Инструкция или контекст"}
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{form.kind === "payment" ? "Ссылка на оплату" : "Ссылка"} <small>необязательно</small></span>
                  <input
                    inputMode="url"
                    maxLength={2048}
                    placeholder={form.kind === "payment" ? "https://…" : "Материалы или страница с деталями"}
                    type="url"
                    value={form.actionUrl}
                    onChange={(event) => setForm({ ...form, actionUrl: event.target.value })}
                  />
                </label>
              </div>
            </details>
          </section>

          <section className="form-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Видимость и ответственность</p>
                <h2>Кто отвечает</h2>
              </div>
              {canAssignGroup ? (
                <button
                  className="sync-button"
                  type="button"
                  onClick={() => openMembers("create")}
                >
                  Участники группы
                </button>
              ) : null}
            </div>

            <div className="choice-grid choice-grid--visibility" role="radiogroup" aria-label="Видимость" onKeyDown={handleRovingControlKey}>
              <button
                aria-checked={form.visibility === "group"}
                className={form.visibility === "group" ? "choice-card is-selected" : "choice-card"}
                role="radio"
                type="button"
                disabled={!canAssignGroup}
                onClick={() => setForm({ ...form, visibility: "group" })}
              >
                <span className="choice-icon"><UiIcon name="group" /></span>
                <span><b>Групповое</b><small>Видно всей группе</small></span>
              </button>
              <button
                aria-checked={form.visibility === "private"}
                className={form.visibility === "private" ? "choice-card is-selected" : "choice-card"}
                role="radio"
                type="button"
                onClick={() =>
                  setForm({ ...form, visibility: "private", assignmentMode: "person", watcherUserIds: [] })
                }
              >
                <span className="choice-icon"><UiIcon name="private" /></span>
                <span><b>Личное</b><small>Только участникам</small></span>
              </button>
            </div>

            {form.visibility === "group" && !canAssignGroup ? (
              <p className="inline-note">Групповые поручения создают организаторы. Личное себе доступно всем.</p>
            ) : null}

            <div className="field">
              <span>Ответственный</span>
              <PersonSelect
                members={members.filter((member) => canAssignGroup || member.userId === actorId)}
                value={form.assignmentMode === "anyone" ? "anyone" : form.responsibleUserId}
                actorId={actorId}
                includeAnyone={form.visibility === "group"}
                onChange={(value) => setForm({
                  ...form,
                  assignmentMode: value === "anyone" ? "anyone" : "person",
                  responsibleUserId: value === "anyone" ? "" : value,
                })}
              />
              {form.visibility === "private" && selectedResponsible && !selectedResponsible.privateChatAvailable ? (
                <small className="field-warning">Нужно, чтобы {selectedResponsible.displayName} сначала отправил боту /start.</small>
              ) : null}
            </div>

            {form.visibility === "group" && form.assignmentMode === "person" ? (
              <details className="watchers">
                <summary>Добавить наблюдателей</summary>
                <p>Их позовём, если задача останется просроченной больше суток.</p>
                <div className="people-list">
                  {members
                    .filter((member) => String(member.userId) !== form.responsibleUserId)
                    .map((member) => (
                      <label className="person-check" key={member.userId}>
                        <input
                          type="checkbox"
                          checked={form.watcherUserIds.includes(member.userId)}
                          onChange={() => toggleWatcher(member.userId)}
                        />
                        <span className="avatar">{member.displayName.slice(0, 1).toUpperCase()}</span>
                        <span>{member.displayName}</span>
                      </label>
                    ))}
                </div>
              </details>
            ) : null}
          </section>

          {editingOccurrenceId && editScope === "occurrence" ? (
            <section className="form-panel">
              <p className="eyebrow">Срок этого повтора</p>
              <h2>Когда он должен быть выполнен</h2>
              <div className="schedule-grid">
                <label className="field"><span>Дата</span><input type="date" value={occurrenceDate} onChange={(event) => setOccurrenceDate(event.target.value)} required /></label>
                <label className="toggle-row field--wide"><span><b>Весь день</b><small>Без точного времени</small></span><input type="checkbox" checked={occurrenceAllDay} onChange={(event) => setOccurrenceAllDay(event.target.checked)} /></label>
                {!occurrenceAllDay ? <label className="field field--wide"><span>Время</span><Time24Field label="Время" required value={occurrenceTime} onChange={setOccurrenceTime} /></label> : null}
              </div>
            </section>
          ) : (
          <section className="form-panel">
            <p className="eyebrow">Ритм</p>
            <h2>Когда напоминать</h2>
            <div className="frequency-strip" role="radiogroup" aria-label="Повторение" onKeyDown={handleRovingControlKey}>
              {([
                ["once", "Один раз"],
                ["daily", "Ежедневно"],
                ["weekly", "По неделям"],
                ["monthly", "По месяцам"],
                ["yearly", "По годам"],
              ] as Array<[Frequency, string]>).map(([value, label]) => (
                <button
                  aria-checked={form.frequency === value}
                  className={form.frequency === value ? "frequency-chip is-selected" : "frequency-chip"}
                  key={value}
                  role="radio"
                  type="button"
                  onClick={() => setForm({ ...form, frequency: value })}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="schedule-grid">
              {form.frequency === "once" ? (
                <label className="field">
                  <span>Дата</span>
                  <input type="date" min={localDateInputValue()} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
                </label>
              ) : (
                <label className="field">
                  <span>Начать</span>
                  <input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} required />
                </label>
              )}

              {form.frequency !== "once" ? (
                <label className="field field--compact">
                  <span>Интервал</span>
                  <input min="1" max="120" type="number" value={form.interval} onChange={(event) => setForm({ ...form, interval: event.target.value })} />
                </label>
              ) : null}

              {form.frequency === "weekly" ? (
                <div className="field field--wide">
                  <span>Дни недели</span>
                  <div className="weekday-row">
                    {WEEKDAYS.map((weekday) => (
                      <button
                        aria-pressed={form.weekdays.includes(weekday.value)}
                        className={form.weekdays.includes(weekday.value) ? "weekday is-selected" : "weekday"}
                        key={weekday.value}
                        type="button"
                        onClick={() => toggleWeekday(weekday.value)}
                      >
                        {weekday.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {form.frequency === "monthly" ? (
                <div className="field field--wide">
                  <span>День месяца</span>
                  <div className="inline-fields">
                    <input
                      aria-label="День месяца"
                      disabled={form.monthlyLastDay}
                      min="1"
                      max="31"
                      type="number"
                      value={form.monthlyDay}
                      onChange={(event) => setForm({ ...form, monthlyDay: event.target.value })}
                    />
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={form.monthlyLastDay}
                        onChange={(event) => setForm({ ...form, monthlyLastDay: event.target.checked })}
                      />
                      Последний день
                    </label>
                  </div>
                </div>
              ) : null}

              {form.frequency === "yearly" ? (
                <div className="field field--wide">
                  <span>Дата каждый год</span>
                  <div className="inline-fields inline-fields--date">
                    <input aria-label="День" min="1" max="31" type="number" value={form.yearlyDay} onChange={(event) => setForm({ ...form, yearlyDay: event.target.value })} />
                    <select aria-label="Месяц" value={form.yearlyMonth} onChange={(event) => setForm({ ...form, yearlyMonth: event.target.value })}>
                      {Array.from({ length: 12 }, (_, index) => (
                        <option key={index + 1} value={index + 1}>
                          {new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(new Date(2026, index, 1))}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

              <label className="toggle-row field--wide">
                <span><b>Весь день</b><small>Без точного времени</small></span>
                <input type="checkbox" checked={form.allDay} onChange={(event) => setForm({ ...form, allDay: event.target.checked })} />
              </label>
              {!form.allDay ? (
                <label className="field field--wide">
                  <span>Время</span>
                  <Time24Field
                    label="Время"
                    required
                    value={form.timeLocal}
                    onChange={(timeLocal) => setForm({ ...form, timeLocal })}
                  />
                </label>
              ) : null}
            </div>
          </section>
          )}

          <section className="form-panel">
            <p className="eyebrow">Повторные сигналы</p>
            <h2>{form.kind === "payment" ? "Пока не оплачено" : "Пока не выполнено"}</h2>
            <div className="schedule-grid">
              <label className="field">
                <span>Первый сигнал</span>
                <select value={form.leadMinutes} onChange={(event) => setForm({ ...form, leadMinutes: event.target.value })}>
                  <option value="0">В срок</option>
                  <option value="60">За 1 час</option>
                  <option value="1440">За 1 день</option>
                  <option value="10080">За неделю</option>
                </select>
              </label>
              <label className="field">
                <span>Повторять</span>
                <select value={form.repeatIntervalMinutes} onChange={(event) => setForm({ ...form, repeatIntervalMinutes: event.target.value })}>
                  <option value="60">Каждый час</option>
                  <option value="180">Каждые 3 часа</option>
                  <option value="360">Каждые 6 часов</option>
                  <option value="720">Каждые 12 часов</option>
                  <option value="1440">Раз в день</option>
                </select>
              </label>
              <label className="toggle-row field--wide">
                <span><b>Срочно</b><small>Разрешить сигналы в тихие часы 22:00–08:00</small></span>
                <input type="checkbox" checked={form.ignoreQuietHours} onChange={(event) => setForm({ ...form, ignoreQuietHours: event.target.checked })} />
              </label>
            </div>
          </section>

          {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}

          <section className="form-preview" aria-label="Предпросмотр напоминания">
            <p className="eyebrow">Как это будет работать</p>
            <h2>{form.title.trim() || "Название напоминания"}</h2>
            <p>{previewResponsible}. {editingOccurrenceId && editScope === "occurrence" ? `${formatScheduleDate(occurrenceDate)} · ${occurrenceAllDay ? "весь день" : occurrenceTime}` : formSchedulePreview(form)}.</p>
            <small>Если не отметить {form.kind === "payment" ? "оплату" : "выполнение"}, бот напомнит {repeatPreviewLabel(form.repeatIntervalMinutes)}.</small>
            {previewDates.length > 0 ? <div className="form-preview__dates" aria-label="Ближайшие даты">{previewDates.map((date, index) => <span className={index === 0 ? "is-next" : ""} key={date}>{formatScheduleDate(date, true)}</span>)}</div> : null}
            {form.frequency === "monthly" && !form.monthlyLastDay && Number(form.monthlyDay) > 28 ? (
              <small className="form-preview__note">Если такого числа в месяце нет, срок переносится на последний день.</small>
            ) : null}
          </section>

          <div className="form-submit-bar">
            <div>
              <small>{form.visibility === "group" ? "Увидит группа" : "Личное"}</small>
              <b>{form.assignmentMode === "anyone"
                ? form.kind === "payment" ? "Оплатит любой" : "Выполнит любой"
                : memberName(selectedResponsible)}</b>
            </div>
            <button className="primary-action" type="submit" disabled={saving}>
              {saving
                ? "Сохраняю…"
                : editingReminderId
                  ? editScope === "occurrence" ? "Сохранить этот срок" : "Сохранить серию"
                  : form.kind === "payment" ? "Создать платёж" : "Создать поручение"}
            </button>
          </div>
        </form>
      </main>
    );
  }

  const dateCaption = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date()).replace(/,\s*/gu, " · ");
  return (
    <main className="app app--home">
      <header className="home-header">
        <div className="brand-mark" aria-label="ZvenFit"><span /><b>ZvenFit</b></div>
        <span className="utility-label">{dateCaption}</span>
      </header>

      <label className="workspace-switcher">
        <span className="workspace-switcher__signal" aria-hidden="true" />
        <span className="workspace-switcher__copy">
          <small>Группа</small>
          {workspaces.length > 1 ? (
            <WorkspaceSelect
              workspaces={workspaces}
              value={workspaceId ?? ""}
              onChange={(nextWorkspaceId) => void changeWorkspace(nextWorkspaceId)}
            />
          ) : <b>{selectedWorkspace?.displayName ?? "Группа не выбрана"}</b>}
        </span>
      </label>

      {selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "organizer" ? (
        <div className="workspace-tools">
          <button className="workspace-settings-link" type="button" onClick={openSettings}>
            <span className="workspace-tool-icon"><UiIcon name="clock" /></span>
            <span><b>Ритм группы</b><small>{selectedWorkspace.quietHoursStart}–{selectedWorkspace.quietHoursEnd}</small></span>
            <UiIcon name="arrow-right" />
          </button>
          <button
            className="workspace-settings-link workspace-members-link"
            type="button"
            onClick={() => openMembers("home")}
          >
            <span className="workspace-tool-icon"><UiIcon name="members" /></span>
            <span>
              <b>Участники</b>
              <small>
                {membersUnavailable
                  ? "Не загружено"
                  : `${members.length} ${members.length === 1 ? "участник" : "участника"}`}
              </small>
            </span>
            <UiIcon name="arrow-right" />
          </button>
        </div>
      ) : null}

      <section className="home-intro">
        <h1>Требует внимания</h1>
        <div className="scope-switch" role="tablist" aria-label="Область напоминаний" onKeyDown={handleRovingControlKey}>
          <button aria-selected={scope === "mine"} className={scope === "mine" ? "is-selected" : ""} onClick={() => setScope("mine")} role="tab" type="button">Моя лента</button>
          <button aria-selected={scope === "group"} className={scope === "group" ? "is-selected" : ""} onClick={() => setScope("group")} role="tab" type="button">Вся группа</button>
        </div>
      </section>

      {dashboardLoadError ? (
        <RequestErrorBanner
          message={dashboardLoadError}
          recovery={{ label: "Загрузить данные", onRetry: () => void refresh() }}
        />
      ) : null}
      {error ? <RequestErrorBanner message={error} recovery={errorRecovery} /> : null}
      {notice ? <div className="notice-toast" role="status">{notice}</div> : null}
      {undoableOccurrence ? (
        <div className="undo-banner" role="status">
          <span><b>{undoableOccurrence.kind === "payment" ? "Оплачено" : "Выполнено"}</b><small>Можно отменить в течение 10 минут</small></span>
          <button
            type="button"
            disabled={actingOccurrenceId === undoableOccurrence.occurrenceId}
            onClick={() => void undoLastCompletion()}
          >
            Отменить
          </button>
        </div>
      ) : null}

      <section className="attention-section" aria-busy={loading}>
        <div className="section-heading">
          <h2>Сейчас</h2>
          <span>{tasksUnavailable ? "—" : visibleOccurrences.length}</span>
        </div>
        {tasksUnavailable ? (
          <div className="resource-unavailable" role="status">
            <b>Задачи пока не загружены</b>
            <span>Срочные дела появятся здесь после загрузки.</span>
          </div>
        ) : loading ? (
          <div className="rail skeleton-rail"><i /><i /><i /></div>
        ) : visibleOccurrences.length === 0 ? (
          <div className="quiet-state">
            <span className="quiet-pulse"><UiIcon name="check" /></span>
            <div><b>Сейчас тихо</b><p>Ничего не ждёт немедленного действия.</p></div>
          </div>
        ) : (
          <div className="rail">
            {visibleOccurrences.map((occurrence) => {
              const definition = reminderMap.get(occurrence.reminderId);
              const responsible = occurrence.assignment.mode === "person"
                ? memberMap.get(occurrence.assignment.responsibleUserId)
                : undefined;
              const amount = formatAmount(occurrence.amountMinor, occurrence.currency);
              const isManager = actor?.role === "owner" || actor?.role === "organizer";
              const isResponsible = occurrence.assignment.mode === "person" &&
                occurrence.assignment.responsibleUserId === actorId;
              const isCreator = definition?.creatorUserId === actorId;
              const canComplete = occurrence.visibility === "private"
                ? isCreator || isResponsible
                : isCreator || isManager || isResponsible || occurrence.assignment.mode === "anyone";
              const canSnooze = occurrence.visibility === "private"
                ? isCreator || isResponsible
                : isCreator || isManager || isResponsible;
              return (
                <article className={`rail-item rail-item--${occurrence.status}`} key={occurrence.occurrenceId}>
                  <span className="rail-node" />
                  <div className="rail-time">
                    <b>{occurrence.status === "overdue" ? `−${relativeDuration(occurrence.dueAt)}` : formatDue(occurrence)}</b>
                    {occurrence.status === "overdue" ? <small>{formatDue(occurrence)}</small> : null}
                  </div>
                  <div className="rail-card">
                    <div className="rail-card__top">
                      <span className="visibility-badge">{occurrence.visibility === "private" ? "личное" : "группа"}</span>
                      {amount ? <b className="amount-label">{amount}</b> : null}
                    </div>
                    <button className="rail-card__title" type="button" onClick={() => openOccurrenceDetail(occurrence.occurrenceId)}>{occurrence.title}<UiIcon name="arrow-right" /></button>
                    <p>{occurrence.assignment.mode === "anyone" ? "Может выполнить любой" : `Ответственный · ${memberName(responsible)}`}</p>
                    {occurrence.nextNotificationAt ? <small className="rail-signal">Следующий сигнал через {relativeDuration(occurrence.nextNotificationAt)} · {formatMoment(occurrence.nextNotificationAt, occurrence.timezone)}</small> : null}
                    {canComplete || canSnooze ? <div className="rail-actions">
                      {canComplete ? <button
                        className="rail-action rail-action--complete"
                        type="button"
                        disabled={actingOccurrenceId === occurrence.occurrenceId}
                        onClick={() => void actOnOccurrence(occurrence.occurrenceId, "complete")}
                      >
                        {occurrence.kind === "payment" ? "Отметить оплату" : "Отметить выполнение"}
                      </button> : null}
                      {canSnooze ? <button
                        className="rail-action"
                        type="button"
                        disabled={actingOccurrenceId === occurrence.occurrenceId}
                        aria-label="Напомнить через час"
                        onClick={() => void actOnOccurrence(occurrence.occurrenceId, "snooze")}
                      >
                        Через час
                      </button> : null}
                    </div> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {!planUnavailable ? (
        <section className="home-plan-teaser">
          <button type="button" onClick={() => switchMainView("plan")}>
            <span><small>План</small><b>{visibleReminders.length > 0 ? `Серий в работе: ${visibleReminders.length}` : "Пока пусто"}</b></span>
            <span>{visibleReminders[0] ? `Ближайшее · ${(planDates.get(visibleReminders[0].reminderId) ?? []).map((date) => formatScheduleDate(date, true)).slice(0, 1).join("")}` : "Добавить напоминание"}</span>
            <UiIcon name="arrow-right" />
          </button>
        </section>
      ) : null}

      <BottomNavigation view="home" onChange={switchMainView} onCreate={openCreate} createDisabled={!workspaceId} />
    </main>
  );
}

declare global {
  interface Window {
    __zvenfitReminderRoot?: Root;
  }
}

const root = window.__zvenfitReminderRoot ?? createRoot(document.getElementById("root")!);
window.__zvenfitReminderRoot = root;
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
