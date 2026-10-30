import { z } from "zod";
import { telegramThreadIdSchema, type TopicUnavailableReason, type WorkspaceTopic } from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction, type SerializableTransaction } from "./transaction.js";
import { getField, mapResultRows, optionalUtf8, parseYdbTimestamp, timestampValue } from "./ydb-utils.js";

const observationSchema = z.object({
  messageThreadId: telegramThreadIdSchema,
  name: z.string().trim().min(1).max(128).optional(),
  fallbackName: z.string().trim().min(1).max(128).optional(),
  isClosed: z.boolean().optional(),
  messageDate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updateId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type TopicObservation = z.infer<typeof observationSchema>;
const unavailableReasonSchema = z.enum(["topic_closed", "topic_deleted"]);

export class TopicRegistrationForbiddenError extends Error {}

export class TopicUnavailableError extends Error {
  constructor() {
    super("Choose an open topic registered in this workspace");
    this.name = "TopicUnavailableError";
  }
}

export async function assertTopicAvailable(
  transaction: SerializableTransaction,
  workspaceId: string,
  messageThreadId: number | null,
): Promise<void> {
  if (messageThreadId == null) return;
  const { resultSets } = await transaction.executeQuery(`
    DECLARE $workspace_id AS Utf8;
    DECLARE $message_thread_id AS Int64;
    SELECT is_closed, unavailable_reason FROM workspace_topics
    WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id
    LIMIT 1;
  `, {
    $workspace_id: TypedValues.utf8(workspaceId),
    $message_thread_id: TypedValues.int64(messageThreadId),
  });
  const row = mapResultRows(resultSets[0])[0];
  if (!row || Boolean(getField(row, "is_closed")) || getField(row, "unavailable_reason") != null) {
    throw new TopicUnavailableError();
  }
}

// Call only after verifying the Telegram destination. Keeping the catalog write
// in the caller's transaction lets a connection operation finish atomically.
export async function registerTopicInTransaction(
  transaction: SerializableTransaction,
  workspaceId: string,
  actorUserId: number,
  telegramChatId: number,
  input: { messageThreadId: number; name: string },
  now: Date,
  verificationStartedAt: Date | null = now,
): Promise<WorkspaceTopic> {
  const topic = z.object({
    messageThreadId: telegramThreadIdSchema,
    name: z.string().trim().min(1).max(128),
  }).strict().parse(input);
  const parameters = {
    $workspace_id: TypedValues.utf8(workspaceId),
    $message_thread_id: TypedValues.int64(topic.messageThreadId),
  };
  const access = await transaction.executeQuery(`
    DECLARE $workspace_id AS Utf8;
    DECLARE $actor_user_id AS Int64;
    DECLARE $telegram_chat_id AS Int64;
    SELECT member.role AS role FROM workspace_members AS member
    INNER JOIN workspaces AS workspace ON workspace.workspace_id = member.workspace_id
    WHERE member.workspace_id = $workspace_id AND member.user_id = $actor_user_id
      AND member.status = 'active' AND workspace.status = 'active'
      AND workspace.telegram_chat_id = $telegram_chat_id;
  `, {
    $workspace_id: parameters.$workspace_id,
    $actor_user_id: TypedValues.int64(actorUserId),
    $telegram_chat_id: TypedValues.int64(telegramChatId),
  });
  const role = getField(mapResultRows(access.resultSets[0])[0] ?? {}, "role");
  if (role !== "owner" && role !== "organizer") throw new TopicRegistrationForbiddenError();
  const { resultSets } = await transaction.executeQuery(`
    DECLARE $workspace_id AS Utf8;
    DECLARE $message_thread_id AS Int64;
    SELECT name, is_closed, unavailable_reason, updated_at FROM workspace_topics
    WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id;
  `, parameters);
  const previous = mapResultRows(resultSets[0])[0];
  if (previous) {
    if (Boolean(getField(previous, "is_closed"))) throw new TopicUnavailableError();
    const previousEvidence = parseYdbTimestamp(getField(previous, "updated_at"));
    if (getField(previous, "unavailable_reason") != null &&
      (!verificationStartedAt || !previousEvidence || verificationStartedAt <= previousEvidence)) {
      throw new TopicUnavailableError();
    }
    // A delayed response/callback must neither clear newer failure evidence nor
    // hide a newer send's failure that arrives after this transaction commits.
    const updatedAt = new Date(Math.max(verificationStartedAt?.getTime() ?? 0, previousEvidence?.getTime() ?? 0));
    await transaction.executeQuery(`
      DECLARE $workspace_id AS Utf8;
      DECLARE $message_thread_id AS Int64;
      DECLARE $name AS Utf8;
      DECLARE $updated_at AS Timestamp;
      UPDATE workspace_topics SET name = $name, unavailable_reason = NULL, updated_at = $updated_at
      WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id;
    `, { ...parameters, $name: TypedValues.utf8(topic.name), $updated_at: timestampValue(updatedAt) });
    return { ...topic, isClosed: false, unavailableReason: null };
  }
  // The probe proves the destination, but does not replace Telegram metadata.
  // Delayed create/rename/close events still need to supply their own fields.
  await transaction.executeQuery(`
    DECLARE $workspace_id AS Utf8;
    DECLARE $message_thread_id AS Int64;
    DECLARE $name AS Utf8;
    DECLARE $updated_at AS Timestamp;
    INSERT INTO workspace_topics (
      workspace_id, message_thread_id, name, is_closed,
      name_update_id, name_message_date, status_update_id, status_message_date, updated_at
    ) VALUES ($workspace_id, $message_thread_id, $name, false, 0, 0, 0, 0, $updated_at);
  `, { ...parameters, $name: TypedValues.utf8(topic.name), $updated_at: timestampValue(verificationStartedAt ?? new Date(0)) });
  return { ...topic, isClosed: false, unavailableReason: null };
}

export class TopicsRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async list(workspaceId: string): Promise<WorkspaceTopic[]> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(`
        DECLARE $workspace_id AS Utf8;
        SELECT message_thread_id, name, is_closed, unavailable_reason FROM workspace_topics
        WHERE workspace_id = $workspace_id ORDER BY name, message_thread_id;
      `, { $workspace_id: TypedValues.utf8(workspaceId) });
      return mapResultRows(resultSets[0]).map((row) => ({
        messageThreadId: Number(getField(row, "message_thread_id")),
        name: String(getField(row, "name")),
        isClosed: Boolean(getField(row, "is_closed")),
        unavailableReason: unavailableReasonSchema.nullable().parse(getField(row, "unavailable_reason") ?? null),
      }));
    });
  }

  async register(workspaceId: string, actorUserId: number, telegramChatId: number,
    input: { messageThreadId: number; name: string }, now = new Date()): Promise<WorkspaceTopic> {
    return this.runSession((session) => withSerializableTransaction(session, (transaction) =>
      registerTopicInTransaction(transaction, workspaceId, actorUserId, telegramChatId, input, now),
    ));
  }

  async markUnavailable(
    workspaceId: string,
    messageThreadId: number,
    reason: TopicUnavailableReason,
    now = new Date(),
  ): Promise<void> {
    const threadId = telegramThreadIdSchema.parse(messageThreadId);
    const parsedReason = unavailableReasonSchema.parse(reason);
    // The caller passes the send's reservation time, not the eventual response
    // time. A newer topic observation or verification wins over that failure.
    await this.runSession(async (session) => {
      await session.executeQuery(`
        DECLARE $workspace_id AS Utf8;
        DECLARE $message_thread_id AS Int64;
        DECLARE $unavailable_reason AS Utf8;
        DECLARE $failure_observed_at AS Timestamp;
        UPDATE workspace_topics SET
          unavailable_reason = $unavailable_reason, updated_at = $failure_observed_at
        WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id
          AND updated_at <= $failure_observed_at;
      `, {
        $workspace_id: TypedValues.utf8(workspaceId),
        $message_thread_id: TypedValues.int64(threadId),
        $unavailable_reason: TypedValues.utf8(parsedReason),
        $failure_observed_at: timestampValue(now),
      });
    });
  }

  async observe(workspaceId: string, input: TopicObservation, now = new Date()): Promise<void> {
    const observation = observationSchema.parse(input);
    await this.runSession((session) => withSerializableTransaction(session, (transaction) =>
      this.observeInTransaction(transaction, workspaceId, observation, now),
    ));
  }

  async observeForManager(workspaceId: string, actorUserId: number, telegramChatId: number,
    input: TopicObservation, now = new Date()): Promise<void> {
    const observation = observationSchema.parse(input);
    await this.runSession((session) => withSerializableTransaction(session, async (transaction) => {
      const access = await transaction.executeQuery(`
        DECLARE $workspace_id AS Utf8;
        DECLARE $actor_user_id AS Int64;
        DECLARE $telegram_chat_id AS Int64;
        SELECT member.role AS role FROM workspace_members AS member
        INNER JOIN workspaces AS workspace ON workspace.workspace_id = member.workspace_id
        WHERE member.workspace_id = $workspace_id AND member.user_id = $actor_user_id
          AND member.status = 'active' AND workspace.status = 'active'
          AND workspace.telegram_chat_id = $telegram_chat_id;
      `, {
        $workspace_id: TypedValues.utf8(workspaceId),
        $actor_user_id: TypedValues.int64(actorUserId),
        $telegram_chat_id: TypedValues.int64(telegramChatId),
      });
      const role = getField(mapResultRows(access.resultSets[0])[0] ?? {}, "role");
      if (role !== "owner" && role !== "organizer") throw new TopicRegistrationForbiddenError();
      await this.observeInTransaction(transaction, workspaceId, observation, now);
    }));
  }

  private async observeInTransaction(transaction: SerializableTransaction, workspaceId: string,
    observation: TopicObservation, now: Date): Promise<void> {
      const parameters = {
        $workspace_id: TypedValues.utf8(workspaceId),
        $message_thread_id: TypedValues.int64(observation.messageThreadId),
      };
      const { resultSets } = await transaction.executeQuery(`
        DECLARE $workspace_id AS Utf8;
        DECLARE $message_thread_id AS Int64;
        SELECT name, is_closed, unavailable_reason, updated_at, name_update_id, name_message_date,
          status_update_id, status_message_date FROM workspace_topics
        WHERE workspace_id = $workspace_id AND message_thread_id = $message_thread_id
        LIMIT 1;
      `, parameters);
      const previous = mapResultRows(resultSets[0])[0];
      // Telegram may randomize update IDs after a week without updates.
      // Compare message time first, using the update ID only within one second.
      const isNewer = (field: "name" | "status") => {
        if (!previous) return true;
        const previousDate = Number(getField(previous, `${field}_message_date`) ?? 0);
        const previousUpdateId = Number(getField(previous, `${field}_update_id`) ?? 0);
        return observation.messageDate > previousDate ||
          (observation.messageDate === previousDate && observation.updateId > previousUpdateId);
      };
      // Name changes and close/reopen events carry different partial fields.
      // An out-of-order update may still be the newest event for its own field.
      const updateName = observation.name != null && isNewer("name");
      const updateStatus = observation.isClosed != null && isNewer("status");
      if (previous && !updateName && !updateStatus) return;
      const name = updateName ? observation.name! : (previous ? String(getField(previous, "name"))
        : observation.fallbackName ?? `Тема №${observation.messageThreadId}`);
      const isClosed = updateStatus ? observation.isClosed!
        : (previous ? Boolean(getField(previous, "is_closed")) : false);
      const unavailableReason = updateStatus && observation.isClosed === false
        ? null : getField(previous ?? {}, "unavailable_reason") ?? null;
      const updatedAt = new Date(Math.max(now.getTime(), parseYdbTimestamp(getField(previous ?? {}, "updated_at"))?.getTime() ?? 0));
      await transaction.executeQuery(`
        DECLARE $workspace_id AS Utf8;
        DECLARE $message_thread_id AS Int64;
        DECLARE $name AS Utf8;
        DECLARE $is_closed AS Bool;
        DECLARE $unavailable_reason AS Utf8?;
        DECLARE $name_update_id AS Uint64;
        DECLARE $name_message_date AS Uint64;
        DECLARE $status_update_id AS Uint64;
        DECLARE $status_message_date AS Uint64;
        DECLARE $updated_at AS Timestamp;
        UPSERT INTO workspace_topics (
          workspace_id, message_thread_id, name, is_closed, unavailable_reason,
          name_update_id, name_message_date, status_update_id, status_message_date, updated_at
        ) VALUES (
          $workspace_id, $message_thread_id, $name, $is_closed, $unavailable_reason,
          $name_update_id, $name_message_date, $status_update_id, $status_message_date, $updated_at
        );
      `, {
        ...parameters,
        $name: TypedValues.utf8(name),
        $is_closed: TypedValues.bool(isClosed),
        $unavailable_reason: optionalUtf8(unavailableReason == null ? null : String(unavailableReason)),
        $name_update_id: TypedValues.uint64(updateName ? observation.updateId : Number(getField(previous ?? {}, "name_update_id") ?? 0)),
        $name_message_date: TypedValues.uint64(updateName ? observation.messageDate : Number(getField(previous ?? {}, "name_message_date") ?? 0)),
        $status_update_id: TypedValues.uint64(updateStatus ? observation.updateId : Number(getField(previous ?? {}, "status_update_id") ?? 0)),
        $status_message_date: TypedValues.uint64(updateStatus ? observation.messageDate : Number(getField(previous ?? {}, "status_message_date") ?? 0)),
        $updated_at: timestampValue(updatedAt),
      });
  }
}
