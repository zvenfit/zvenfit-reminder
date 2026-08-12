import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ApiError,
  createReminder,
  listMembers,
  listReminders,
  loadDashboard,
  syncMembers,
  type CreateReminderBody,
  type DeadlineTiming,
  type Reminder,
  type ReminderOccurrence,
  type ScheduleSpec,
  type WorkspaceMember,
} from "./api";
import "./styles.css";

type View = "home" | "create";
type Scope = "mine" | "group";
type Frequency = ScheduleSpec["frequency"];

interface ReminderFormState {
  title: string;
  description: string;
  amountRub: string;
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

const WEEKDAYS = [
  { value: 1, label: "Пн" },
  { value: 2, label: "Вт" },
  { value: 3, label: "Ср" },
  { value: 4, label: "Чт" },
  { value: 5, label: "Пт" },
  { value: 6, label: "Сб" },
  { value: 7, label: "Вс" },
];

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
    title: "",
    description: "",
    amountRub: "",
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

function memberName(member: WorkspaceMember | undefined): string {
  return member?.displayName ?? "Участник";
}

function formatAmount(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor == null || !currency) return null;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function formatDue(occurrence: ReminderOccurrence): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: occurrence.timezone,
  }).format(new Date(occurrence.dueAt));
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
  if (error instanceof ApiError && error.code === "private_chat_required") {
    return "Ответственный ещё не открыл личный чат с ботом. Попросите его отправить боту /start.";
  }
  if (error instanceof ApiError && error.code === "workspace_not_initialized") {
    return "Workspace ещё не настроен. Администратору нужно выполнить /setup в группе.";
  }
  return error instanceof Error ? error.message : "Что-то пошло не так";
}

function App() {
  const [view, setView] = useState<View>("home");
  const [scope, setScope] = useState<Scope>("mine");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [occurrences, setOccurrences] = useState<ReminderOccurrence[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [form, setForm] = useState<ReminderFormState>(() => emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actorId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  const memberMap = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const actor = actorId ? memberMap.get(actorId) : undefined;

  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter((occurrence) => {
        if (scope === "group" || !actorId) return true;
        return (
          occurrence.assignment.mode === "anyone" ||
          occurrence.assignment.responsibleUserId === actorId
        );
      }),
    [actorId, occurrences, scope],
  );

  const visibleReminders = useMemo(
    () =>
      reminders.filter((reminder) => {
        if (scope === "group" || !actorId) return true;
        return (
          reminder.creatorUserId === actorId ||
          reminder.assignment.mode === "anyone" ||
          reminder.assignment.responsibleUserId === actorId
        );
      }),
    [actorId, reminders, scope],
  );

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [dashboardResponse, remindersResponse, membersResponse] = await Promise.all([
        loadDashboard(),
        listReminders(),
        listMembers(),
      ]);
      setOccurrences(dashboardResponse.occurrences);
      setReminders(remindersResponse.reminders);
      setMembers(membersResponse.members);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    void refresh();
  }, []);

  function openCreate() {
    const defaultResponsible = actorId ?? members[0]?.userId;
    setForm(emptyForm(defaultResponsible));
    setError(null);
    setView("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function syncWorkspaceMembers() {
    setSyncing(true);
    setError(null);
    try {
      await syncMembers();
      const response = await listMembers();
      setMembers(response.members);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSyncing(false);
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
      setError("Выберите ответственного.");
      return;
    }
    if (form.frequency === "weekly" && form.weekdays.length === 0) {
      setError("Выберите хотя бы один день недели.");
      return;
    }
    setSaving(true);
    setError(null);
    const amount = form.amountRub.trim() ? Math.round(Number(form.amountRub) * 100) : null;
    const responsibleUserId = Number(form.responsibleUserId);
    const payload: CreateReminderBody = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      actionUrl: null,
      amountMinor: amount,
      currency: amount == null ? null : "RUB",
      visibility: form.visibility,
      assignment:
        form.assignmentMode === "anyone"
          ? { mode: "anyone" }
          : { mode: "person", responsibleUserId },
      watcherUserIds: form.watcherUserIds.filter((id) => id !== responsibleUserId),
      schedule: buildSchedule(form),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow",
      notificationPolicy: {
        leadMinutes: Number(form.leadMinutes),
        repeatIntervalMinutes: Number(form.repeatIntervalMinutes),
        ignoreQuietHours: form.ignoreQuietHours,
        escalation: { enabled: true, delayMinutes: 1440, repeatMinutes: 1440 },
      },
    };

    try {
      await createReminder(payload);
      setView("home");
      await refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  if (view === "create") {
    const selectedResponsible = memberMap.get(Number(form.responsibleUserId));
    const canAssignGroup = actor?.role === "owner" || actor?.role === "organizer";
    return (
      <main className="app app--form">
        <header className="topbar">
          <button className="back-button" type="button" onClick={() => setView("home")}>
            <span aria-hidden="true">←</span> Назад
          </button>
          <span className="utility-label">Новое</span>
        </header>

        <section className="form-intro">
          <p className="eyebrow">Обязательство</p>
          <h1>О чём не дать забыть?</h1>
          <p>Бот будет возвращать напоминание, пока ответственный не отметит выполнение.</p>
        </section>

        <form
          className="reminder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReminder();
          }}
        >
          <section className="form-panel form-panel--primary">
            <label className="field field--hero">
              <span>Что нужно сделать</span>
              <input
                autoFocus
                maxLength={200}
                placeholder="Например, передать показания"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Детали <small>необязательно</small></span>
              <textarea
                rows={3}
                maxLength={2000}
                placeholder="Ссылка, инструкция или контекст"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label className="field field--amount">
              <span>Сумма <small>если это платёж</small></span>
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
                <b>₽</b>
              </span>
            </label>
          </section>

          <section className="form-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Видимость и ответственность</p>
                <h2>Кто отвечает</h2>
              </div>
              <button
                className="sync-button"
                type="button"
                disabled={syncing}
                onClick={() => void syncWorkspaceMembers()}
              >
                {syncing ? "Обновляю…" : "Обновить людей"}
              </button>
            </div>

            <div className="choice-grid choice-grid--visibility" role="radiogroup" aria-label="Видимость">
              <button
                className={form.visibility === "group" ? "choice-card is-selected" : "choice-card"}
                type="button"
                onClick={() => setForm({ ...form, visibility: "group" })}
              >
                <span className="choice-icon">◎</span>
                <span><b>Групповое</b><small>Видно всей группе</small></span>
              </button>
              <button
                className={form.visibility === "private" ? "choice-card is-selected" : "choice-card"}
                type="button"
                onClick={() =>
                  setForm({ ...form, visibility: "private", assignmentMode: "person", watcherUserIds: [] })
                }
              >
                <span className="choice-icon">◐</span>
                <span><b>Личное</b><small>Только участникам</small></span>
              </button>
            </div>

            {form.visibility === "group" && !canAssignGroup ? (
              <p className="inline-note">Групповые поручения создают организаторы. Личное себе доступно всем.</p>
            ) : null}

            <label className="field">
              <span>Ответственный</span>
              <select
                value={form.assignmentMode === "anyone" ? "anyone" : form.responsibleUserId}
                onChange={(event) =>
                  setForm({
                    ...form,
                    assignmentMode: event.target.value === "anyone" ? "anyone" : "person",
                    responsibleUserId: event.target.value === "anyone" ? "" : event.target.value,
                  })
                }
              >
                {form.visibility === "group" ? <option value="anyone">Может выполнить любой</option> : null}
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}{member.userId === actorId ? " · вы" : ""}
                  </option>
                ))}
              </select>
              {form.visibility === "private" && selectedResponsible && !selectedResponsible.privateChatAvailable ? (
                <small className="field-warning">Нужно, чтобы {selectedResponsible.displayName} сначала отправил боту /start.</small>
              ) : null}
            </label>

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

          <section className="form-panel">
            <p className="eyebrow">Ритм</p>
            <h2>Когда напоминать</h2>
            <div className="frequency-strip" role="radiogroup" aria-label="Повторение">
              {([
                ["once", "Один раз"],
                ["daily", "Ежедневно"],
                ["weekly", "По неделям"],
                ["monthly", "По месяцам"],
                ["yearly", "По годам"],
              ] as Array<[Frequency, string]>).map(([value, label]) => (
                <button
                  className={form.frequency === value ? "frequency-chip is-selected" : "frequency-chip"}
                  key={value}
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
                  <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
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
                  <input type="time" value={form.timeLocal} onChange={(event) => setForm({ ...form, timeLocal: event.target.value })} required />
                </label>
              ) : null}
            </div>
          </section>

          <section className="form-panel">
            <p className="eyebrow">Повторные сигналы</p>
            <h2>Пока не выполнено</h2>
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

          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          <div className="form-submit-bar">
            <div>
              <small>{form.visibility === "group" ? "Увидит группа" : "Личное"}</small>
              <b>{form.assignmentMode === "anyone" ? "Выполнит любой" : memberName(selectedResponsible)}</b>
            </div>
            <button className="primary-action" type="submit" disabled={saving}>
              {saving ? "Создаю…" : "Создать"}
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
  }).format(new Date());

  return (
    <main className="app app--home">
      <header className="home-header">
        <div className="brand-mark" aria-label="Звенит"><span /><b>звенит</b></div>
        <span className="utility-label">{dateCaption}</span>
      </header>

      <section className="home-intro">
        <p className="eyebrow">Линия внимания</p>
        <h1>Что требует<br />действия</h1>
        <div className="scope-switch" role="tablist" aria-label="Область напоминаний">
          <button className={scope === "mine" ? "is-selected" : ""} onClick={() => setScope("mine")} role="tab">Мои</button>
          <button className={scope === "group" ? "is-selected" : ""} onClick={() => setScope("group")} role="tab">Вся группа</button>
        </div>
      </section>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <section className="attention-section" aria-busy={loading}>
        <div className="section-heading">
          <h2>Сейчас</h2>
          <span>{visibleOccurrences.length}</span>
        </div>
        {loading ? (
          <div className="rail skeleton-rail"><i /><i /><i /></div>
        ) : visibleOccurrences.length === 0 ? (
          <div className="quiet-state">
            <span className="quiet-pulse">✓</span>
            <div><b>Сейчас тихо</b><p>Ничего не ждёт немедленного действия.</p></div>
          </div>
        ) : (
          <div className="rail">
            {visibleOccurrences.map((occurrence) => {
              const responsible = occurrence.assignment.mode === "person"
                ? memberMap.get(occurrence.assignment.responsibleUserId)
                : undefined;
              const amount = formatAmount(occurrence.amountMinor, occurrence.currency);
              return (
                <article className={`rail-item rail-item--${occurrence.status}`} key={occurrence.occurrenceId}>
                  <span className="rail-node" />
                  <div className="rail-time">
                    <b>{occurrence.status === "overdue" ? "просрочено" : formatDue(occurrence)}</b>
                    {occurrence.status === "overdue" ? <small>{formatDue(occurrence)}</small> : null}
                  </div>
                  <div className="rail-card">
                    <div className="rail-card__top">
                      <span className="visibility-badge">{occurrence.visibility === "private" ? "личное" : "группа"}</span>
                      {amount ? <b className="amount-label">{amount}</b> : null}
                    </div>
                    <h3>{occurrence.title}</h3>
                    <p>{occurrence.assignment.mode === "anyone" ? "Может выполнить любой" : `Ответственный · ${memberName(responsible)}`}</p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="plans-section">
        <div className="section-heading">
          <h2>Дальше по плану</h2>
          <span>{visibleReminders.length}</span>
        </div>
        {!loading && visibleReminders.length === 0 ? (
          <button className="empty-plan" onClick={openCreate}>
            <b>Добавить первое напоминание</b>
            <span>Разовое или повторяющееся — бот проследит за выполнением.</span>
          </button>
        ) : (
          <div className="plan-list">
            {visibleReminders.map((reminder) => {
              const responsible = reminder.assignment.mode === "person"
                ? memberMap.get(reminder.assignment.responsibleUserId)
                : undefined;
              return (
                <article className="plan-row" key={reminder.reminderId}>
                  <div className="plan-date" aria-hidden="true">
                    <span>{reminder.schedule.frequency === "once" ? "→" : "↻"}</span>
                  </div>
                  <div className="plan-copy">
                    <h3>{reminder.title}</h3>
                    <p>{scheduleLabel(reminder.schedule)}</p>
                    <small>{reminder.assignment.mode === "anyone" ? "Любой участник" : memberName(responsible)}</small>
                  </div>
                  <span className={`status-dot status-dot--${reminder.status}`} />
                </article>
              );
            })}
          </div>
        )}
      </section>

      <button className="floating-create" onClick={openCreate}>
        <span aria-hidden="true">＋</span> Новое напоминание
      </button>
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
