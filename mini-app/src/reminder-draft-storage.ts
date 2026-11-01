import type { TopicConnection } from "./api";
import type { EditScope, ReminderFormState } from "./reminder-form-state";

export interface TopicDraft {
  link: string;
  name: string;
  clientRequestId?: string;
  operation?: TopicConnection;
}

export const emptyTopicDraft = (): TopicDraft => ({ link: "", name: "" });
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = "zvenfit.reminder-draft.v1:";

export interface ReminderDraft {
  version: 1;
  savedAt: number;
  actorId: number;
  workspaceId: string;
  entityKey: string;
  editingReminderId: string | null;
  editingOccurrenceId: string | null;
  editScope: EditScope;
  form: ReminderFormState;
  scopedForms: Record<EditScope, ReminderFormState> | null;
  occurrenceDate: string;
  occurrenceTime: string;
  occurrenceAllDay: boolean;
  rawFields: Record<string, string>;
  topicDrafts: Record<EditScope, TopicDraft>;
  sourceVersion?: number;
  sourceUpdatedAt?: string;
  submissionUncertain?: boolean;
}

const keyFor = (draft: Pick<ReminderDraft, "actorId" | "workspaceId" | "entityKey">) =>
  `${PREFIX}${draft.actorId}:${encodeURIComponent(draft.workspaceId)}:${encodeURIComponent(draft.entityKey)}`;

function isForm(value: unknown): value is ReminderFormState {
  if (!value || typeof value !== "object") return false;
  const form = value as Record<string, unknown>;
  const strings = ["kind", "title", "description", "actionUrl", "amountMajor", "currency", "visibility", "messageThreadId", "assignmentMode", "responsibleUserId", "frequency", "date", "startDate", "timeLocal", "interval", "monthlyDay", "yearlyMonth", "yearlyDay", "leadAmount", "leadUnit", "repeatIntervalMinutes"];
  return strings.every((key) => typeof form[key] === "string" && (form[key] as string).length <= 10000) &&
    ["allDay", "monthlyLastDay", "ignoreQuietHours"].every((key) => typeof form[key] === "boolean") &&
    ["weekdays", "watcherUserIds"].every((key) => Array.isArray(form[key]) && (form[key] as unknown[]).every((id) => typeof id === "number" && Number.isSafeInteger(id))) &&
    ["task", "payment"].includes(String(form.kind)) && ["group", "private"].includes(String(form.visibility)) &&
    ["person", "anyone"].includes(String(form.assignmentMode)) &&
    ["once", "daily", "weekly", "monthly", "yearly"].includes(String(form.frequency)) &&
    ["hours", "days"].includes(String(form.leadUnit));
}

function isTopicDraft(value: unknown): value is TopicDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as TopicDraft;
  if (typeof draft.link !== "string" || draft.link.length > 4096 || typeof draft.name !== "string" || draft.name.length > 1000 ||
    (draft.clientRequestId !== undefined && (typeof draft.clientRequestId !== "string" || draft.clientRequestId.length > 100))) return false;
  const operation = draft.operation;
  return operation === undefined || Boolean(operation && typeof operation === "object" && draft.clientRequestId &&
    typeof operation.connectionId === "string" && operation.connectionId.length > 0 && operation.connectionId.length <= 100 &&
    ["pending", "sending", "succeeded", "failed", "unknown"].includes(operation.state) &&
    typeof operation.expiresAt === "string" && Number.isFinite(Date.parse(operation.expiresAt)) &&
    (operation.messageThreadId === undefined || (Number.isSafeInteger(operation.messageThreadId) && operation.messageThreadId > 0)) &&
    (operation.state !== "succeeded" || operation.messageThreadId !== undefined) &&
    [operation.name, operation.errorCode, operation.message].every((entry) => entry === undefined || (typeof entry === "string" && entry.length <= 10000)));
}

export function parseReminderDraft(raw: string, actorId: number, workspaceId: string, now = Date.now()): ReminderDraft | null {
  try {
    const value = JSON.parse(raw) as ReminderDraft;
    if (!value || value.version !== 1 || value.actorId !== actorId || value.workspaceId !== workspaceId ||
      !Number.isFinite(value.savedAt) || value.savedAt > now + 60000 || now - value.savedAt > DRAFT_TTL_MS ||
      typeof value.entityKey !== "string" || !["series", "occurrence"].includes(value.editScope) || !isForm(value.form) ||
      (value.editingReminderId !== null && typeof value.editingReminderId !== "string") ||
      (value.editingOccurrenceId !== null && typeof value.editingOccurrenceId !== "string") ||
      typeof value.occurrenceDate !== "string" || typeof value.occurrenceTime !== "string" || typeof value.occurrenceAllDay !== "boolean" ||
      !value.rawFields || typeof value.rawFields !== "object" || Array.isArray(value.rawFields) || !Object.values(value.rawFields).every((entry) => typeof entry === "string" && entry.length <= 100) ||
      (value.scopedForms !== null && (!isForm(value.scopedForms.series) || !isForm(value.scopedForms.occurrence))) ||
      !value.topicDrafts || ![value.topicDrafts.series, value.topicDrafts.occurrence].every(isTopicDraft)) return null;
    return value;
  } catch { return null; }
}

export function readReminderDraft(identity: Pick<ReminderDraft, "actorId" | "workspaceId" | "entityKey">, storage?: Storage): ReminderDraft | null {
  try { return parseReminderDraft((storage ?? window.localStorage).getItem(keyFor(identity)) ?? "", identity.actorId, identity.workspaceId); } catch { return null; }
}

export function saveReminderDraft(draft: ReminderDraft, storage?: Storage): boolean {
  try { (storage ?? window.localStorage).setItem(keyFor(draft), JSON.stringify(draft)); return true; } catch { return false; }
}

export function removeReminderDraft(draft: Pick<ReminderDraft, "actorId" | "workspaceId" | "entityKey">, storage?: Storage): void {
  try { (storage ?? window.localStorage).removeItem(keyFor(draft)); } catch { /* Storage may be unavailable in this WebView. */ }
}

export function latestReminderDraft(actorId: number, workspaceId: string, storage?: Storage): ReminderDraft | null {
  try {
    storage ??= window.localStorage;
    const prefix = `${PREFIX}${actorId}:${encodeURIComponent(workspaceId)}:`;
    const candidates: ReminderDraft[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const draft = parseReminderDraft(storage.getItem(key) ?? "", actorId, workspaceId);
      if (draft) candidates.push(draft);
    }
    return candidates.sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  } catch { return null; }
}
