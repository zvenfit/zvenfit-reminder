import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction, type SerializableTransaction } from "./transaction.js";
import { getField, mapResultRows, parseYdbTimestampRequired } from "./ydb-utils.js";
import { createWorkspaceInTransaction } from "./workspaces-repository.js";
import { observeWorkspaceMemberInTransaction } from "./workspace-members-repository.js";

export const groupConnectionInputSchema = z.object({
  clientRequestId: z.string().uuid(),
  launchMode: z.enum(["native", "private_chat"]),
}).strict();
export type GroupConnectionInput = z.infer<typeof groupConnectionInputSchema>;
const storedConnectionSchema = groupConnectionInputSchema.extend({
  connectionId: z.string().uuid(), actorUserId: z.number().int().positive().safe(),
  requestId: z.number().int().positive().max(2147483647),
  state: z.enum(["pending", "validating", "connected", "rejected", "expired"]),
  expiresAt: z.string().datetime(), version: z.number().int().nonnegative(),
  preparedButtonId: z.string().optional(), selectedChatId: z.number().int().safe().negative().optional(),
  workspaceId: z.string().uuid().optional(), errorCode: z.string().optional(),
  leaseUntil: z.string().datetime().optional(), validationToken: z.string().uuid().optional(),
  accessSnapshot: z.string().optional(),
});
export type GroupConnection = z.infer<typeof storedConnectionSchema>;
export class GroupConnectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GroupConnectionError"; }
}
export const GROUP_CONNECTION_TTL_MS = 15 * 60 * 1000;
const VALIDATION_LEASE_MS = 30_000;

// Stable actor-scoped idempotency key; launchMode remains checked against the first payload.
export function groupConnectionId(actorUserId: number, clientRequestId: string): string {
  const hex = createHash("sha256").update(`group-connection:${actorUserId}:${clientRequestId.toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function expired(connection: GroupConnection, now: Date): boolean {
  return connection.state !== "connected" && Date.parse(connection.expiresAt) <= now.getTime();
}
function rowConnection(row?: Record<string, unknown>): GroupConnection | null {
  return row ? storedConnectionSchema.parse(JSON.parse(String(getField(row, "payload")))) : null;
}
async function read(transaction: SerializableTransaction, connectionId: string): Promise<GroupConnection | null> {
  const result = await transaction.executeQuery(`
    DECLARE $connection_id AS Utf8;
    SELECT payload FROM group_connections WHERE connection_id = $connection_id LIMIT 1;
  `, { $connection_id: TypedValues.utf8(connectionId) });
  return rowConnection(mapResultRows(result.resultSets[0])[0]);
}
async function write(transaction: SerializableTransaction, connection: GroupConnection): Promise<void> {
  await transaction.executeQuery(`
    DECLARE $connection_id AS Utf8; DECLARE $payload AS Utf8;
    UPSERT INTO group_connections (connection_id, payload) VALUES ($connection_id, $payload);
  `, { $connection_id: TypedValues.utf8(connection.connectionId), $payload: TypedValues.utf8(JSON.stringify(connection)) });
}
function requireActor(connection: GroupConnection | null, actorUserId: number): GroupConnection {
  if (!connection || connection.actorUserId !== actorUserId) throw new GroupConnectionError("not_found");
  return connection;
}
async function accessSnapshot(transaction: SerializableTransaction, chatId: number, actorUserId: number) {
  const result = await transaction.executeQuery(`
    DECLARE $chat_id AS Int64; DECLARE $actor_id AS Int64;
    SELECT w.workspace_id AS workspace_id, w.status AS status, w.owner_user_id AS owner_user_id,
      w.updated_at AS updated_at
    FROM telegram_chat_workspaces AS mapping INNER JOIN workspaces AS w ON mapping.workspace_id = w.workspace_id
    WHERE mapping.telegram_chat_id = $chat_id LIMIT 1;
    SELECT m.status AS status, m.role AS role, m.updated_at AS updated_at
    FROM telegram_chat_workspaces AS mapping INNER JOIN workspace_members AS m ON mapping.workspace_id = m.workspace_id
    WHERE mapping.telegram_chat_id = $chat_id AND m.user_id = $actor_id LIMIT 1;
  `, { $chat_id: TypedValues.int64(chatId), $actor_id: TypedValues.int64(actorUserId) });
  const workspace = mapResultRows(result.resultSets[0])[0];
  const member = mapResultRows(result.resultSets[1])[0];
  const snapshot = JSON.stringify({
    workspace: workspace ? [getField(workspace, "workspace_id"), getField(workspace, "status"),
      getField(workspace, "owner_user_id"), parseYdbTimestampRequired(getField(workspace, "updated_at"), "updated_at").toISOString()] : null,
    member: member ? [getField(member, "status"), getField(member, "role"),
      parseYdbTimestampRequired(getField(member, "updated_at"), "updated_at").toISOString()] : null,
  });
  return { workspace, member, snapshot };
}

export class GroupConnectionsRepository {
  private readonly runSession: SessionRunner;
  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }
  async create(actorUserId: number, input: GroupConnectionInput, now = new Date()): Promise<GroupConnection> {
    z.number().int().positive().safe().parse(actorUserId);
    const parsed = groupConnectionInputSchema.parse(input);
    const connectionId = groupConnectionId(actorUserId, parsed.clientRequestId);
    return this.runSession((session) => withSerializableTransaction(session, async (tx) => {
      const existing = await read(tx, connectionId);
      if (existing) {
        requireActor(existing, actorUserId);
        if (existing.launchMode !== parsed.launchMode) throw new GroupConnectionError("idempotency_conflict");
        return expired(existing, now) ? { ...existing, state: "expired" } : existing;
      }
      const result = await tx.executeQuery(`
        DECLARE $actor_id AS Int64;
        SELECT next_request_id FROM group_connection_counters WHERE actor_user_id = $actor_id LIMIT 1;
      `, { $actor_id: TypedValues.int64(actorUserId) });
      const row = mapResultRows(result.resultSets[0])[0];
      const requestId = row ? Number(getField(row, "next_request_id")) : 1;
      if (requestId > 2147483647) throw new GroupConnectionError("request_ids_exhausted");
      const connection: GroupConnection = { ...parsed, connectionId, actorUserId, requestId,
        state: "pending", version: 0, expiresAt: new Date(now.getTime() + GROUP_CONNECTION_TTL_MS).toISOString() };
      await tx.executeQuery(`
        DECLARE $actor_id AS Int64; DECLARE $request_id AS Int64;
        DECLARE $next_request_id AS Int64; DECLARE $connection_id AS Utf8;
        UPSERT INTO group_connection_counters (actor_user_id, next_request_id) VALUES ($actor_id, $next_request_id);
        INSERT INTO group_connection_requests (actor_user_id, request_id, connection_id)
        VALUES ($actor_id, $request_id, $connection_id);
      `, { $actor_id: TypedValues.int64(actorUserId), $request_id: TypedValues.int64(requestId),
        $next_request_id: TypedValues.int64(requestId + 1), $connection_id: TypedValues.utf8(connectionId) });
      await write(tx, connection);
      return connection;
    }));
  }
  async get(actorUserId: number, connectionId: string, now = new Date()): Promise<GroupConnection> {
    return this.runSession(async (session) => {
      const connection = requireActor(await read(session, connectionId), actorUserId);
      return expired(connection, now) ? { ...connection, state: "expired" } : connection;
    });
  }
  async getByRequest(actorUserId: number, requestId: number): Promise<GroupConnection | null> {
    return this.runSession(async (session) => {
      const result = await session.executeQuery(`
        DECLARE $actor_id AS Int64; DECLARE $request_id AS Int64;
        SELECT connection_id FROM group_connection_requests
        WHERE actor_user_id = $actor_id AND request_id = $request_id LIMIT 1;
      `, { $actor_id: TypedValues.int64(actorUserId), $request_id: TypedValues.int64(requestId) });
      const row = mapResultRows(result.resultSets[0])[0];
      return row ? requireActor(await read(session, String(getField(row, "connection_id"))), actorUserId) : null;
    });
  }
  async savePreparedButton(actorUserId: number, connectionId: string, buttonId: string): Promise<GroupConnection> {
    return this.runSession((session) => withSerializableTransaction(session, async (tx) => {
      const connection = requireActor(await read(tx, connectionId), actorUserId);
      if (!connection.preparedButtonId && connection.state === "pending") {
        connection.preparedButtonId = buttonId;
        await write(tx, connection);
      }
      return connection;
    }));
  }
  /** Persists selection and takes the local authorization snapshot before Telegram calls. */
  async beginValidation(actorUserId: number, connectionId: string, selectedChatId?: number, now = new Date()): Promise<GroupConnection> {
    if (selectedChatId != null) z.number().int().safe().negative().parse(selectedChatId);
    return this.runSession((session) => withSerializableTransaction(session, async (tx) => {
      const connection = requireActor(await read(tx, connectionId), actorUserId);
      if (expired(connection, now)) return { ...connection, state: "expired" };
      if (connection.selectedChatId != null && selectedChatId != null && connection.selectedChatId !== selectedChatId)
        throw new GroupConnectionError("selection_conflict");
      if (connection.state === "connected") return connection;
      if (connection.state === "validating" && Date.parse(connection.leaseUntil ?? "") > now.getTime())
        throw new GroupConnectionError("validation_in_progress");
      const chatId = connection.selectedChatId ?? selectedChatId;
      if (chatId == null) throw new GroupConnectionError("selection_required");
      const access = await accessSnapshot(tx, chatId, actorUserId);
      const claimed: GroupConnection = { ...connection, selectedChatId: chatId, state: "validating",
        errorCode: undefined, version: connection.version + 1, validationToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + VALIDATION_LEASE_MS).toISOString(), accessSnapshot: access.snapshot };
      await write(tx, claimed);
      return claimed;
    }));
  }
  async reject(claim: GroupConnection, code: string): Promise<GroupConnection> {
    return this.runSession((session) => withSerializableTransaction(session, async (tx) => {
      const current = requireActor(await read(tx, claim.connectionId), claim.actorUserId);
      if (current.state !== "validating" || current.validationToken !== claim.validationToken) return current;
      const rejected: GroupConnection = { ...current, state: "rejected", errorCode: code,
        validationToken: undefined, leaseUntil: undefined, accessSnapshot: undefined };
      await write(tx, rejected);
      return rejected;
    }));
  }
  /** Completes membership and operation in one transaction, never taking over an existing owner. */
  async complete(claim: GroupConnection, metadata: { title: string; isForum: boolean; timezone: string }, now = new Date()): Promise<GroupConnection> {
    return this.runSession((session) => withSerializableTransaction(session, async (tx) => {
      const current = requireActor(await read(tx, claim.connectionId), claim.actorUserId);
      if (current.state !== "validating" || current.validationToken !== claim.validationToken) return current;
      if (expired(current, now)) return { ...current, state: "expired" };
      const chatId = current.selectedChatId!;
      const access = await accessSnapshot(tx, chatId, current.actorUserId);
      let errorCode: string | undefined;
      if (access.workspace && getField(access.workspace, "status") !== "active") errorCode = "workspace_closed";
      else if (access.snapshot !== current.accessSnapshot) errorCode = "membership_changed";
      if (errorCode) {
        const rejected: GroupConnection = { ...current, state: "rejected", errorCode,
          validationToken: undefined, leaseUntil: undefined, accessSnapshot: undefined };
        await write(tx, rejected);
        return rejected;
      }
      let workspaceId: string;
      if (access.workspace) {
        workspaceId = String(getField(access.workspace, "workspace_id"));
        await observeWorkspaceMemberInTransaction(tx, workspaceId, current.actorUserId, now);
        await tx.executeQuery(`
          DECLARE $workspace_id AS Utf8; DECLARE $is_forum AS Bool;
          UPDATE workspaces SET is_forum = $is_forum WHERE workspace_id = $workspace_id;
        `, { $workspace_id: TypedValues.utf8(workspaceId), $is_forum: TypedValues.bool(metadata.isForum) });
      } else {
        const workspace = await createWorkspaceInTransaction(tx, { telegramChatId: chatId,
          displayName: metadata.title, isForum: metadata.isForum, ownerUserId: current.actorUserId,
          timezone: metadata.timezone }, now);
        workspaceId = workspace.workspaceId;
      }
      const connected: GroupConnection = { ...current, state: "connected", workspaceId,
        errorCode: undefined, validationToken: undefined, leaseUntil: undefined, accessSnapshot: undefined };
      await write(tx, connected);
      return connected;
    }));
  }
}
