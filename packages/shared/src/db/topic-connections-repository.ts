import { createHash } from "node:crypto";
import { z } from "zod";
import { telegramThreadIdSchema } from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { registerTopicInTransaction, TopicRegistrationForbiddenError } from "./topics-repository.js";
import { withSerializableTransaction, type SerializableTransaction } from "./transaction.js";
import { getField, mapResultRows, optionalTimestamp, optionalUtf8, parseYdbTimestamp, parseYdbTimestampRequired, timestampValue } from "./ydb-utils.js";

export type TopicConnectionState = "pending" | "sending" | "succeeded" | "failed" | "unknown";
export interface TopicConnection {
  connectionId: string;
  workspaceId: string;
  actorUserId: number;
  clientRequestId: string;
  telegramChatId: number;
  messageThreadId: number;
  link: string;
  name: string;
  state: TopicConnectionState;
  errorCode?: string;
  expiresAt: Date;
  sendDeadline: Date;
  verificationStartedAt?: Date | null;
}
export const topicConnectionInputSchema = z.object({
  clientRequestId: z.uuid().transform((value) => value.toLowerCase()), link: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(128),
}).strict();
export class TopicConnectionConflictError extends Error {}

// Actor and workspace form part of the idempotency namespace. The opaque ID
// also fits Telegram's 64-byte callback_data limit with its action prefix.
export function topicConnectionId(workspaceId: string, actorUserId: number, clientRequestId: string): string {
  return createHash("sha256").update(JSON.stringify([workspaceId, actorUserId, clientRequestId])).digest("hex").slice(0, 32);
}

export function effectiveTopicConnection(connection: TopicConnection, now: Date): TopicConnection {
  if (connection.state === "sending" && connection.sendDeadline <= now) {
    return { ...connection, state: "unknown", errorCode: connection.expiresAt <= now ? "expired" : "delivery_unknown" };
  }
  if (connection.state === "unknown" && connection.expiresAt <= now) {
    return { ...connection, errorCode: "expired" };
  }
  if (connection.state === "pending" && connection.expiresAt <= now) {
    return { ...connection, state: "failed", errorCode: "expired" };
  }
  return connection;
}

function mapConnection(row: Record<string, unknown>): TopicConnection {
  const field = (name: string) => getField(row, name);
  const errorCode = field("error_code");
  return {
    connectionId: String(field("connection_id")), workspaceId: String(field("workspace_id")),
    actorUserId: Number(field("actor_user_id")), clientRequestId: String(field("client_request_id")),
    telegramChatId: Number(field("telegram_chat_id")), messageThreadId: Number(field("message_thread_id")),
    link: String(field("link")), name: String(field("name")), state: String(field("state")) as TopicConnectionState,
    errorCode: typeof errorCode === "string" && errorCode && errorCode !== "[object Object]" ? errorCode : undefined,
    expiresAt: parseYdbTimestampRequired(field("expires_at"), "expires_at"),
    sendDeadline: parseYdbTimestampRequired(field("send_deadline"), "send_deadline"),
    verificationStartedAt: parseYdbTimestamp(field("verification_started_at")),
  };
}
async function read(transaction: SerializableTransaction, connectionId: string): Promise<TopicConnection | null> {
  const result = await transaction.executeQuery(`
    DECLARE $connection_id AS Utf8;
    SELECT * FROM topic_connection_requests WHERE connection_id = $connection_id;
  `, { $connection_id: TypedValues.utf8(connectionId) });
  const row = mapResultRows(result.resultSets[0])[0];
  return row ? mapConnection(row) : null;
}
async function assertManager(transaction: SerializableTransaction, connection: Pick<TopicConnection, "workspaceId" | "actorUserId" | "telegramChatId">): Promise<void> {
  const result = await transaction.executeQuery(`
    DECLARE $workspace_id AS Utf8;
    DECLARE $actor_user_id AS Int64;
    DECLARE $telegram_chat_id AS Int64;
    SELECT member.role AS role FROM workspace_members AS member
    INNER JOIN workspaces AS workspace ON workspace.workspace_id = member.workspace_id
    WHERE member.workspace_id = $workspace_id AND member.user_id = $actor_user_id
      AND member.status = 'active' AND workspace.status = 'active'
      AND workspace.telegram_chat_id = $telegram_chat_id;
  `, {
    $workspace_id: TypedValues.utf8(connection.workspaceId),
    $actor_user_id: TypedValues.int64(connection.actorUserId),
    $telegram_chat_id: TypedValues.int64(connection.telegramChatId),
  });
  const role = getField(mapResultRows(result.resultSets[0])[0] ?? {}, "role");
  if (role !== "owner" && role !== "organizer") throw new TopicRegistrationForbiddenError();
}
async function writeState(transaction: SerializableTransaction, connection: TopicConnection, now: Date): Promise<void> {
  await transaction.executeQuery(`
    DECLARE $connection_id AS Utf8;
    DECLARE $state AS Utf8;
    DECLARE $error_code AS Utf8?;
    DECLARE $send_deadline AS Timestamp;
    DECLARE $verification_started_at AS Timestamp?;
    DECLARE $updated_at AS Timestamp;
    UPDATE topic_connection_requests SET state = $state, error_code = $error_code,
      send_deadline = $send_deadline, verification_started_at = $verification_started_at,
      updated_at = $updated_at WHERE connection_id = $connection_id;
  `, {
    $connection_id: TypedValues.utf8(connection.connectionId), $state: TypedValues.utf8(connection.state),
    $error_code: optionalUtf8(connection.errorCode), $send_deadline: timestampValue(connection.sendDeadline),
    $verification_started_at: optionalTimestamp(connection.verificationStartedAt),
    $updated_at: timestampValue(now),
  });
}

export class TopicConnectionsRepository {
  private readonly runSession: SessionRunner;
  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }
  async get(connectionId: string): Promise<TopicConnection | null> {
    return this.runSession((session) => read(session, connectionId));
  }
  async create(workspaceId: string, actorUserId: number, telegramChatId: number,
    input: z.infer<typeof topicConnectionInputSchema> & { messageThreadId: number }, now = new Date()): Promise<TopicConnection> {
    const { messageThreadId, ...payload } = input;
    telegramThreadIdSchema.parse(messageThreadId);
    const normalized = topicConnectionInputSchema.parse(payload);
    const connectionId = topicConnectionId(workspaceId, actorUserId, normalized.clientRequestId);
    return this.runSession((session) => withSerializableTransaction(session, async (transaction) => {
      await assertManager(transaction, { workspaceId, actorUserId, telegramChatId });
      const previous = await read(transaction, connectionId);
      if (previous) {
        if (previous.workspaceId !== workspaceId || previous.actorUserId !== actorUserId ||
          previous.telegramChatId !== telegramChatId || previous.messageThreadId !== messageThreadId ||
          previous.link !== normalized.link || previous.name !== normalized.name) throw new TopicConnectionConflictError();
        return effectiveTopicConnection(previous, now);
      }
      const connection: TopicConnection = { ...normalized, connectionId, workspaceId, actorUserId, telegramChatId,
        messageThreadId, state: "pending", expiresAt: new Date(now.getTime() + 15 * 60_000), sendDeadline: now };
      await transaction.executeQuery(`
        DECLARE $connection_id AS Utf8;
        DECLARE $workspace_id AS Utf8;
        DECLARE $actor_user_id AS Int64;
        DECLARE $client_request_id AS Utf8;
        DECLARE $telegram_chat_id AS Int64;
        DECLARE $message_thread_id AS Int64;
        DECLARE $link AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $expires_at AS Timestamp;
        DECLARE $now AS Timestamp;
        INSERT INTO topic_connection_requests
          (connection_id, workspace_id, actor_user_id, client_request_id, telegram_chat_id,
           message_thread_id, link, name, state, error_code, expires_at, send_deadline, verification_started_at, updated_at)
        VALUES ($connection_id, $workspace_id, $actor_user_id, $client_request_id, $telegram_chat_id,
           $message_thread_id, $link, $name, 'pending', NULL, $expires_at, $now, NULL, $now);
      `, {
        $connection_id: TypedValues.utf8(connectionId), $workspace_id: TypedValues.utf8(workspaceId),
        $actor_user_id: TypedValues.int64(actorUserId), $client_request_id: TypedValues.utf8(normalized.clientRequestId),
        $telegram_chat_id: TypedValues.int64(telegramChatId), $message_thread_id: TypedValues.int64(messageThreadId),
        $link: TypedValues.utf8(normalized.link), $name: TypedValues.utf8(normalized.name),
        $expires_at: timestampValue(connection.expiresAt), $now: timestampValue(now),
      });
      return connection;
    }));
  }
  async claim(connectionId: string, now = new Date()): Promise<TopicConnection | null> {
    return this.runSession((session) => withSerializableTransaction(session, async (transaction) => {
      const connection = await read(transaction, connectionId);
      if (!connection || connection.state !== "pending" || connection.expiresAt <= now) return null;
      await assertManager(transaction, connection);
      const claimed = { ...connection, state: "sending" as const, sendDeadline: new Date(now.getTime() + 60_000), verificationStartedAt: now };
      await writeState(transaction, claimed, now);
      return claimed;
    }));
  }
  async finish(connectionId: string, outcome: "succeeded" | "failed" | "unknown", errorCode?: string,
    now = new Date()): Promise<TopicConnection | null> {
    return this.runSession((session) => withSerializableTransaction(session, async (transaction) => {
      const connection = await read(transaction, connectionId);
      if (!connection) return null;
      if (outcome === "succeeded") await assertManager(transaction, connection);
      // A callback may have completed the operation before the HTTP response.
      if (connection.state === "succeeded" || connection.state === "failed") return effectiveTopicConnection(connection, now);
      if (outcome === "succeeded") {
        if (!["sending", "unknown"].includes(connection.state) || connection.expiresAt <= now) return effectiveTopicConnection(connection, now);
        await registerTopicInTransaction(transaction, connection.workspaceId, connection.actorUserId,
          connection.telegramChatId, { messageThreadId: connection.messageThreadId, name: connection.name }, now,
          connection.verificationStartedAt ?? null);
      }
      const updated = { ...connection, state: outcome, errorCode };
      await writeState(transaction, updated, now);
      return updated;
    }));
  }
}
