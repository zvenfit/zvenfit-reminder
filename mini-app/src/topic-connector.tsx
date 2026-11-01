import { useEffect, useRef, useState } from "react";
import { ApiError, createTopicConnection, getTopicConnection, type TopicConnection, type WorkspaceTopic } from "./api";
import { emptyTopicDraft, type TopicDraft } from "./reminder-draft-storage";

export function TopicConnector({ workspaceId, disabled, draft, onDraftChange, onConnected, onBusyChange }: {
  workspaceId: string;
  disabled: boolean;
  draft: TopicDraft;
  onDraftChange(draft: TopicDraft): void;
  onConnected(topic: WorkspaceTopic): void;
  onBusyChange(busy: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(Boolean(draft.clientRequestId));
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<"link" | "name" | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const latest = useRef({ draft, onDraftChange, onConnected });
  latest.current = { draft, onDraftChange, onConnected };
  const state = draft.operation?.state;
  const awaiting = state === "pending" || state === "sending";
  const locked = Boolean(draft.clientRequestId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    onBusyChange(busy || awaiting);
    return () => onBusyChange(false);
  }, [busy, awaiting, onBusyChange]);

  function accept(operation: TopicConnection) {
    if (!mounted.current) return;
    const current = latest.current;
    current.onDraftChange({ ...current.draft, operation });
    if (operation.state === "succeeded" && operation.messageThreadId) {
      current.onConnected({ messageThreadId: operation.messageThreadId, name: operation.name ?? current.draft.name, isClosed: false });
      current.onDraftChange(emptyTopicDraft());
      setOpen(false);
      if (details.current) details.current.open = false;
      document.getElementById("reminder-topic")?.focus();
    }
  }

  useEffect(() => {
    if (!draft.operation?.connectionId || !awaiting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await getTopicConnection(workspaceId, draft.operation!.connectionId);
        if (!active) return;
        accept(response);
        if (response.state === "pending" || response.state === "sending") timer = setTimeout(poll, 2000);
      } catch {
        if (active) setError("Не удалось получить результат. Проверьте статус — новое сообщение отправлено не будет.");
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [workspaceId, draft.operation?.connectionId, awaiting]);

  async function connect() {
    if (busy || disabled) return;
    if (!draft.link.trim() || !draft.name.trim()) {
      const field = !draft.link.trim() ? "link" : "name";
      setInvalidField(field);
      setError(field === "link" ? "Вставьте ссылку на тему." : "Укажите название для списка.");
      (field === "link" ? linkInput : nameInput).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setInvalidField(null);
    const request = { ...draft, link: draft.link.trim(), name: draft.name.trim(), clientRequestId: draft.clientRequestId ?? crypto.randomUUID() };
    onDraftChange(request);
    try {
      const response = request.operation
        ? await getTopicConnection(workspaceId, request.operation.connectionId)
        : await createTopicConnection(workspaceId, { clientRequestId: request.clientRequestId, link: request.link, name: request.name });
      accept(response);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError ? failure.message : "Ответ не получен. Проверьте результат этой попытки перед новой отправкой.");
    } finally { if (mounted.current) setBusy(false); }
  }

  const status = error ?? draft.operation?.message ?? (awaiting ? "Проверяем тему. Дождитесь подтверждения." : state === "unknown"
    ? "Результат отправки неизвестен. Служебное сообщение могло появиться в теме." : state === "failed" ? "Не удалось подключить тему." : "");
  return <details className="additional-fields" ref={details} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Подключить тему</summary>
    <div className="additional-fields__body field" onKeyDown={(event) => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        void connect();
      }
    }}>
      <p className="form-panel__hint" id="topic-connect-help">Откройте нужную тему в Telegram и скопируйте её ссылку. Вернитесь в приложение и вставьте ссылку сюда. Черновик напоминания сохранится на этом устройстве.</p>
      <div className="field">
        <label htmlFor="topic-link">Ссылка на тему</label>
        <input ref={linkInput} id="topic-link" type="text" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false}
          placeholder="https://t.me/c/…/…" value={draft.link} maxLength={2048} disabled={busy || disabled || locked}
          aria-describedby="topic-connect-help topic-connect-status" aria-invalid={invalidField === "link" || undefined}
          onChange={(event) => { onDraftChange({ ...draft, link: event.target.value }); setError(null); setInvalidField(null); }} />
      </div>
      <div className="field">
        <label htmlFor="topic-name">Название темы</label>
        <input ref={nameInput} id="topic-name" placeholder="Например, Оплаты" value={draft.name} maxLength={128} disabled={busy || disabled || locked}
          aria-describedby="topic-name-help topic-connect-status" aria-invalid={invalidField === "name" || undefined}
          onChange={(event) => { onDraftChange({ ...draft, name: event.target.value }); setError(null); setInvalidField(null); }} />
        <small id="topic-name-help">Название в списке напоминаний. Название темы в Telegram не изменится.</small>
      </div>
      <p className="inline-note">Для проверки бот отправит в тему одно служебное сообщение без упоминаний участников.</p>
      <span className={error || state === "failed" ? "field-error" : undefined} id="topic-connect-status" role="status">{status}</span>
      <button className="sync-button" type="button" disabled={busy || disabled || (awaiting && !error)} onClick={() => { void connect(); }}>
        {busy ? "Проверяем…" : locked ? "Проверить результат" : "Проверить и подключить"}
      </button>
      {locked && !awaiting ? <button className="sync-button" type="button" disabled={busy || disabled} onClick={() => {
        onDraftChange({ link: draft.link, name: draft.name }); setError(null); setOpen(true);
      }}>Начать новую проверку</button> : null}
      {locked && !awaiting ? <small>Новая проверка может отправить ещё одно служебное сообщение. Текущее место доставки не изменено.</small> : null}
      <small>Запасной способ: отправьте в нужной теме /topic Название и обновите список.</small>
    </div>
  </details>;
}
