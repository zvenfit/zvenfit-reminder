import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRule,
  deleteRule,
  listMembers,
  listRules,
  syncMembers,
  updateRule,
  type GroupMember,
  type Rule,
} from "./api";
import "./styles.css";

type View = "list" | "create" | "edit";

interface RuleFormState {
  title: string;
  amountRub: string;
  ruleType: "recurring" | "oneoff";
  dayOfMonth: string;
  dueAt: string;
  timeLocal: string;
  mentionIds: number[];
  status: Rule["status"];
}

const emptyForm = (): RuleFormState => ({
  title: "",
  amountRub: "",
  ruleType: "recurring",
  dayOfMonth: "1",
  dueAt: "",
  timeLocal: "09:00",
  mentionIds: [],
  status: "active",
});

function ruleToForm(rule: Rule): RuleFormState {
  return {
    title: rule.title,
    amountRub: rule.amount != null ? String(rule.amount / 100) : "",
    ruleType: rule.ruleType,
    dayOfMonth: rule.dayOfMonth != null ? String(rule.dayOfMonth) : "1",
    dueAt: rule.dueAt ? rule.dueAt.slice(0, 16) : "",
    timeLocal: rule.timeLocal,
    mentionIds: rule.mentionIds,
    status: rule.status,
  };
}

function App() {
  const [view, setView] = useState<View>("list");
  const [rules, setRules] = useState<Rule[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [membersSyncing, setMembersSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRules = useMemo(() => rules.filter((r) => r.status === "active"), [rules]);
  const pausedRules = useMemo(() => rules.filter((r) => r.status === "paused"), [rules]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [rulesResponse, membersResponse] = await Promise.all([listRules(), listMembers()]);
      setRules(rulesResponse.rules);
      setMembers(membersResponse.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    void refresh();
  }, []);

  async function syncMembersFromChat() {
    setMembersSyncing(true);
    setError(null);
    try {
      const response = await syncMembers();
      setMembers(response.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setMembersSyncing(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setView("create");
  }

  function openEdit(rule: Rule) {
    setEditingId(rule.id);
    setForm(ruleToForm(rule));
    setView("edit");
  }

  function toggleMention(userId: number) {
    setForm((prev) => ({
      ...prev,
      mentionIds: prev.mentionIds.includes(userId)
        ? prev.mentionIds.filter((id) => id !== userId)
        : [...prev.mentionIds, userId],
    }));
  }

  async function submitForm() {
    setError(null);
    const payload = {
      title: form.title.trim(),
      amount: form.amountRub ? Math.round(Number(form.amountRub) * 100) : null,
      ruleType: form.ruleType,
      dayOfMonth: form.ruleType === "recurring" ? Number(form.dayOfMonth) : null,
      dueAt: form.ruleType === "oneoff" && form.dueAt ? new Date(form.dueAt).toISOString() : null,
      timeLocal: form.timeLocal,
      mentionIds: form.mentionIds,
      status: form.status,
    };

    try {
      if (view === "edit" && editingId) {
        await updateRule(editingId, payload);
      } else {
        await createRule(payload);
      }
      setView("list");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function archiveRule(rule: Rule) {
    try {
      await deleteRule(rule.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  if (view !== "list") {
    return (
      <main className="app">
        <header className="header">
          <button className="link" onClick={() => setView("list")}>
            ← Назад
          </button>
          <h1>{view === "create" ? "Новое правило" : "Редактирование"}</h1>
        </header>

        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm();
          }}
        >
          <label>
            Название
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          </label>

          <label>
            Сумма (₽)
            <input
              type="number"
              min="0"
              step="1"
              value={form.amountRub}
              onChange={(e) => setForm({ ...form, amountRub: e.target.value })}
            />
          </label>

          <label>
            Тип
            <select
              value={form.ruleType}
              onChange={(e) => setForm({ ...form, ruleType: e.target.value as RuleFormState["ruleType"] })}
            >
              <option value="recurring">Ежемесячно</option>
              <option value="oneoff">Разово</option>
            </select>
          </label>

          {form.ruleType === "recurring" ? (
            <>
              <label>
                День месяца
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={form.dayOfMonth}
                  onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })}
                  required
                />
              </label>
              <label>
                Время
                <input
                  type="time"
                  value={form.timeLocal}
                  onChange={(e) => setForm({ ...form, timeLocal: e.target.value })}
                  required
                />
              </label>
            </>
          ) : (
            <label>
              Дата и время
              <input
                type="datetime-local"
                value={form.dueAt}
                onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
                required
              />
            </label>
          )}

          <fieldset className="mentions-fieldset">
            <legend className="mentions-legend">
              <span>Кого упомянуть</span>
              <button
                type="button"
                className="icon-button"
                title="Синхронизировать участников из чата"
                aria-label="Синхронизировать участников из чата"
                disabled={membersSyncing}
                onClick={() => void syncMembersFromChat()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </legend>
            {members.length === 0 ? (
              <p className="muted mentions-empty">Никого нет</p>
            ) : (
              <div className="member-list">
                {members.map((member) => (
                  <label key={member.userId} className="member-row">
                    <input
                      type="checkbox"
                      checked={form.mentionIds.includes(member.userId)}
                      onChange={() => toggleMention(member.userId)}
                    />
                    <span className="member-name">
                      <span>{member.displayName}</span>
                      {member.username ? <span className="member-username">@{member.username}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {view === "edit" && (
            <label>
              Статус
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as Rule["status"] })}
              >
                <option value="active">Активно</option>
                <option value="paused">Пауза</option>
                <option value="archived">Архив</option>
              </select>
            </label>
          )}

          {error && <p className="error">{error}</p>}

          <button type="submit" className="primary">
            Сохранить
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Платежи</h1>
        <button className="primary" onClick={openCreate}>
          + Правило
        </button>
      </header>

      {loading && <p className="muted">Загрузка...</p>}
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Активные</h2>
        {activeRules.length === 0 ? (
          <p className="muted">Нет активных правил</p>
        ) : (
          activeRules.map((rule) => (
            <article key={rule.id} className="card">
              <div>
                <strong>{rule.title}</strong>
                <p className="muted">
                  {rule.ruleType === "recurring"
                    ? `${rule.dayOfMonth}-е число в ${rule.timeLocal}`
                    : rule.dueAt?.slice(0, 16)}
                  {rule.amount != null ? ` · ${rule.amount / 100} ₽` : ""}
                </p>
              </div>
              <div className="actions">
                <button onClick={() => openEdit(rule)}>Edit</button>
                <button onClick={() => void archiveRule(rule)}>Archive</button>
              </div>
            </article>
          ))
        )}
      </section>

      {pausedRules.length > 0 && (
        <section>
          <h2>На паузе</h2>
          {pausedRules.map((rule) => (
            <article key={rule.id} className="card">
              <div>
                <strong>{rule.title}</strong>
              </div>
              <button onClick={() => openEdit(rule)}>Edit</button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
