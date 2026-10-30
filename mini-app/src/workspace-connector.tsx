import { useEffect, useRef, useState } from "react";
import { ApiError, createGroupConnection, getGroupConnection, retryGroupConnection, type GroupConnection } from "./api";

interface Attempt { clientRequestId: string; launchMode: "native" | "private_chat"; operation?: GroupConnection; }
const storageKey = (actorId: number) => `zvenfit.group-connection.v1:${actorId}`;
function readAttempt(actorId: number): Attempt | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(actorId)) ?? "null") as Attempt | null;
    if (!value || typeof value.clientRequestId !== "string" || value.clientRequestId.length > 100 || !["native", "private_chat"].includes(value.launchMode)) return null;
    if (value.operation && (typeof value.operation.connectionId !== "string" || !["pending", "validating", "connected", "rejected", "expired"].includes(value.operation.state) || typeof value.operation.expiresAt !== "string")) return { clientRequestId: value.clientRequestId, launchMode: value.launchMode };
    return value;
  } catch { return null; }
}
function persist(actorId: number, attempt: Attempt | null) {
  try {
    if (attempt) window.localStorage.setItem(storageKey(actorId), JSON.stringify(attempt));
    else window.localStorage.removeItem(storageKey(actorId));
  } catch { /* The current session remains usable without local storage. */ }
}
function supportsNativeChat() {
  const app = window.Telegram?.WebApp;
  return Boolean(app?.requestChat && (!app.isVersionAtLeast || app.isVersionAtLeast("9.6")));
}

export function WorkspaceConnector({ actorId, onConnected }: { actorId: number; onConnected(workspaceId: string, stillActive: () => boolean): Promise<void> }) {
  const [attempt, setAttempt] = useState<Attempt | null>(() => readAttempt(actorId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const mounted = useRef(true);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const handled = useRef<string | null>(null);
  const operation = attempt?.operation;
  const awaiting = operation?.state === "pending" || operation?.state === "validating";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function update(next: Attempt | null) {
    persist(actorId, next);
    if (mounted.current) setAttempt(next);
  }

  async function accept(next: Attempt) {
    update(next);
    const result = next.operation;
    if (result?.state === "connected" && result.workspaceId && handled.current !== result.connectionId) {
      handled.current = result.connectionId;
      try {
        await onConnectedRef.current(result.workspaceId, () => mounted.current && handled.current === result.connectionId);
        persist(actorId, null);
      } catch {
        handled.current = null;
        if (mounted.current) setError("Группа подключена, но список ещё не обновился. Проверьте результат ещё раз.");
      }
    }
  }

  function launch(result: GroupConnection, viaChat = false) {
    setCancelled(false);
    if (!viaChat && !nativeFailed && result.preparedButtonId && supportsNativeChat()) {
      try {
        window.Telegram!.WebApp!.requestChat!(result.preparedButtonId, (sent) => {
          if (mounted.current && !sent) setCancelled(true);
        });
        return;
      } catch { setNativeFailed(true); }
    }
    if (result.fallbackUrl) {
      let link: URL;
      try { link = new URL(result.fallbackUrl); } catch { setError("Ссылка выбора группы недоступна. Повторите проверку результата."); return; }
      if (link.protocol !== "https:" || link.hostname !== "t.me") { setError("Не удалось открыть выбор группы. Проверьте результат и повторите попытку."); return; }
      try {
        if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(link.toString());
        else window.open(link.toString(), "_blank", "noopener,noreferrer");
      } catch { setError("Не удалось открыть Telegram. Повторите выбор через личный чат."); }
    } else setError("Выбор группы сейчас недоступен. Проверьте результат и повторите попытку.");
  }

  function startNew() {
    update(null); setError(null); setCancelled(false); setNativeFailed(false); handled.current = null;
  }

  useEffect(() => {
    if (!operation?.connectionId || !awaiting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await getGroupConnection(operation.connectionId);
        if (!active) return;
        await accept({ ...attempt!, operation: response });
        if (response.state === "pending" || response.state === "validating") timer = setTimeout(poll, 2000);
      } catch {
        if (active) setError("Не удалось проверить подключение. Нажмите «Проверить результат».");
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [operation?.connectionId, awaiting]);

  async function begin() {
    if (busy) return;
    setBusy(true); setError(null); setCancelled(false);
    const next = attempt ?? { clientRequestId: crypto.randomUUID(), launchMode: supportsNativeChat() ? "native" : "private_chat" };
    update(next);
    try {
      const result = await createGroupConnection({ clientRequestId: next.clientRequestId, launchMode: next.launchMode });
      if (!mounted.current) { persist(actorId, { ...next, operation: result }); return; }
      await accept({ ...next, operation: result });
      if (result.state === "pending") launch(result);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError ? failure.message : "Ответ не получен. Повторная проверка продолжит ту же попытку.");
    } finally { if (mounted.current) setBusy(false); }
  }

  async function check(retry = false) {
    if (busy || !attempt?.operation) return;
    setBusy(true); setError(null);
    try {
      const result = retry ? await retryGroupConnection(attempt.operation.connectionId) : await getGroupConnection(attempt.operation.connectionId);
      if (mounted.current) {
        await accept({ ...attempt, operation: result });
        if (retry && result.state === "pending") launch(result);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError ? failure.message : "Не удалось проверить подключение. Повторите проверку этой попытки.");
    } finally { if (mounted.current) setBusy(false); }
  }

  return <section className="workspace-connector" aria-labelledby="connect-workspace-title" aria-busy={busy}>
    <h2 id="connect-workspace-title">Подключить группу</h2>
    <p>Выберите Telegram-группу, которой вы управляете. Telegram покажет необходимые права бота. Уже подключённая группа откроется без повторного создания.</p>
    <div className="workspace-connector__actions">
      {!operation ? <button type="button" className="primary-action" disabled={busy} onClick={() => void begin()}>{busy ? "Готовим выбор…" : attempt ? "Продолжить подключение" : "Выбрать группу"}</button> : null}
      {operation?.state === "pending" ? <button type="button" className="primary-action" disabled={busy} onClick={() => launch(operation)}>{attempt?.launchMode === "private_chat" || nativeFailed || !operation.preparedButtonId ? "Открыть выбор в Telegram" : "Выбрать группу"}</button> : null}
      {operation?.state === "pending" && operation.fallbackUrl && operation.preparedButtonId && !nativeFailed ? <button type="button" className="sync-button" disabled={busy} onClick={() => launch(operation, true)}>Выбрать через личный чат</button> : null}
      {operation ? <button type="button" className="sync-button" disabled={busy} onClick={() => void check()}>{busy ? "Проверяем…" : "Проверить результат"}</button> : null}
      {operation?.state === "rejected" || operation?.state === "validating" ? <button type="button" className="sync-button" disabled={busy} onClick={() => void check(true)}>{operation.state === "validating" ? "Повторить проверку" : "Повторить подключение"}</button> : null}
      {operation?.state === "rejected" || operation?.state === "expired" ? <button type="button" className="sync-button" disabled={busy} onClick={startNew}>{operation.state === "expired" ? "Начать новое подключение" : "Выбрать другую группу"}</button> : null}
    </div>
    {attempt?.launchMode === "private_chat" || nativeFailed || operation?.errorCode === "native_unavailable" ? <small>В личном чате нажмите кнопку выбора группы, затем вернитесь сюда. Печатать команду не нужно.</small> : null}
    <p role="status" className={error || operation?.state === "rejected" ? "field-error" : "form-panel__hint"}>{error ?? (cancelled ? "Выбор отменён. Можно выбрать группу позже." : operation?.message ?? (operation?.state === "validating" ? "Проверяем права и подключаем группу…" : awaiting ? "Выберите группу в Telegram. Здесь появится результат подключения." : operation?.state === "expired" ? "Время выбора истекло. Повторите подключение." : ""))}</p>
  </section>;
}
