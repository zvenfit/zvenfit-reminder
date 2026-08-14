import { createHash } from "node:crypto";
import {
  deliveryStatusSchema,
  deliveryTypeSchema,
  type DeliveryStatus,
  type NotificationDelivery,
  type ReminderOccurrence,
} from "../reminder-domain.js";
import {
  adjustForQuietHours,
  calculateFirstEscalationAt,
  calculateNextEscalationAt,
  calculateNextNotificationAt,
} from "../reminder-scheduling.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import {
  DELIVERY_LOCK_TTL_MILLISECONDS,
  hasActiveDeliveryLock,
  prepareOccurrenceMutation,
} from "./delivery-guard.js";
import { rowToOccurrence } from "./occurrences-repository.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalUtf8,
  parseJsonDocument,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

export interface DeliveryCandidate {
  workspaceId: string;
  occurrenceId: string;
  nextNotificationAt: Date;
}

export interface ReservedDelivery {
  delivery: NotificationDelivery;
  occurrence: ReminderOccurrence;
  targetChatId: number;
  nextNotificationAt: Date;
  escalationWatchers: Array<{ userId: number; displayName: string }>;
}

export type DeliveryResult =
  | { status: "sent"; telegramMessageId: number }
  | { status: "failed" | "unknown" | "cancelled"; errorCode?: string | null };

export interface DeliveryValidation {
  valid: boolean;
  targetChatId: number | null;
}

export class DeliveryTargetUnavailableError extends Error {
  constructor(readonly userId: number) {
    super(`User ${userId} has no available private Telegram chat`);
    this.name = "DeliveryTargetUnavailableError";
  }
}

export class DeliveryAlreadyFinalizedError extends Error {
  constructor(
    readonly deliveryKey: string,
    readonly status: DeliveryStatus,
  ) {
    super(`Delivery ${deliveryKey} is already finalized as ${status}`);
    this.name = "DeliveryAlreadyFinalizedError";
  }
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function rowToDelivery(data: Record<string, unknown>): NotificationDelivery {
  return {
    workspaceId: String(getField(data, "workspace_id")),
    deliveryKey: String(getField(data, "delivery_key")),
    occurrenceId: String(getField(data, "occurrence_id")),
    reminderId: String(getField(data, "reminder_id")),
    deliveryType: deliveryTypeSchema.parse(getField(data, "delivery_type")),
    sequence: Number(getField(data, "sequence")),
    scheduledAt: parseYdbTimestampRequired(getField(data, "scheduled_at"), "scheduled_at"),
    claimedAt: parseYdbTimestampRequired(getField(data, "claimed_at"), "claimed_at"),
    status: deliveryStatusSchema.parse(getField(data, "status")),
    telegramChatId: nullableNumber(getField(data, "telegram_chat_id")),
    telegramMessageId: nullableNumber(getField(data, "telegram_message_id")),
    errorCode: nullableString(getField(data, "error_code")),
    createdAt: parseYdbTimestampRequired(getField(data, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
  };
}

export function createDeliveryKey(
  occurrenceId: string,
  deliveryType: NotificationDelivery["deliveryType"],
  scheduledAt: Date,
  sequence: number,
): string {
  return createHash("sha256")
    .update(`${occurrenceId}\n${deliveryType}\n${scheduledAt.toISOString()}\n${sequence}`)
    .digest("hex");
}

export class DeliveriesRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async listCandidates(
    workspaceId: string,
    now: Date,
    limit = 100,
  ): Promise<DeliveryCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Candidate limit must be an integer between 1 and 1000");
    }
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $now AS Timestamp;
          DECLARE $limit AS Uint64;
          DECLARE $workspace_id AS Utf8;
          SELECT workspace_id, occurrence_id, next_notification_at
          FROM reminder_occurrences VIEW idx_occurrences_dispatch
          WHERE notification_state = 'waiting'
            AND next_notification_at <= $now
            AND workspace_id = $workspace_id
          ORDER BY notification_state, next_notification_at, workspace_id
          LIMIT $limit;
        `,
        {
          $now: timestampValue(now),
          $limit: TypedValues.uint64(limit),
          $workspace_id: TypedValues.utf8(workspaceId),
        },
      );
      return mapResultRows(resultSets[0]).map((row) => ({
        workspaceId: String(getField(row, "workspace_id")),
        occurrenceId: String(getField(row, "occurrence_id")),
        nextNotificationAt: parseYdbTimestampRequired(
          getField(row, "next_notification_at"),
          "next_notification_at",
        ),
      }));
    });
  }

  async getByKey(workspaceId: string, deliveryKey: string): Promise<NotificationDelivery | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $delivery_key AS Utf8;
          SELECT * FROM notification_deliveries
          WHERE workspace_id = $workspace_id AND delivery_key = $delivery_key
          LIMIT 1;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $delivery_key: TypedValues.utf8(deliveryKey),
        },
      );
      const row = mapResultRows(resultSets[0])[0];
      return row ? rowToDelivery(row) : null;
    });
  }

  async reserve(
    workspaceId: string,
    occurrenceId: string,
    now: Date = new Date(),
  ): Promise<ReservedDelivery | null> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $now AS Timestamp;

            SELECT * FROM reminder_occurrences
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND notification_state = 'waiting'
              AND status IN ('pending', 'overdue')
              AND next_notification_at <= $now
            LIMIT 1;

            SELECT telegram_chat_id, quiet_hours_start, quiet_hours_end, status
            FROM workspaces
            WHERE workspace_id = $workspace_id
            LIMIT 1;

            SELECT member.user_id AS user_id, user.display_name AS display_name
            FROM workspace_members AS member
            INNER JOIN users AS user ON user.user_id = member.user_id
            WHERE member.workspace_id = $workspace_id
              AND member.status = 'active'
            ORDER BY member.user_id;

            SELECT delivery.claimed_at AS claimed_at
            FROM notification_deliveries AS delivery
            WHERE delivery.workspace_id = $workspace_id
              AND delivery.occurrence_id = $occurrence_id
              AND delivery.delivery_type = 'escalation'
            ORDER BY delivery.claimed_at DESC
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $occurrence_id: TypedValues.utf8(occurrenceId),
            $now: timestampValue(now),
          },
        );

        const occurrenceRow = mapResultRows(resultSets[0])[0];
        const workspaceRow = mapResultRows(resultSets[1])[0];
        if (!occurrenceRow || !workspaceRow || getField(workspaceRow, "status") !== "active") {
          return null;
        }
        if (hasActiveDeliveryLock(occurrenceRow, now)) {
          return null;
        }
        await prepareOccurrenceMutation(
          transaction, workspaceId, occurrenceRow, occurrenceId, now,
        );
        const occurrence = rowToOccurrence(occurrenceRow);
        const watcherUserIds = new Set(
          parseJsonDocument<number[]>(getField(occurrenceRow, "watcher_user_ids"), []),
        );
        const escalationWatchers = mapResultRows(resultSets[2])
          .filter((row) => watcherUserIds.has(Number(getField(row, "user_id"))))
          .map((row) => ({
            userId: Number(getField(row, "user_id")),
            displayName: String(getField(row, "display_name")),
          }));
        const lastEscalationRow = mapResultRows(resultSets[3])[0];
        const lastEscalatedAt = lastEscalationRow
          ? parseYdbTimestampRequired(getField(lastEscalationRow, "claimed_at"), "claimed_at")
          : null;
        if (!occurrence.nextNotificationAt) {
          return null;
        }

        const quietHours = {
          startLocal: String(getField(workspaceRow, "quiet_hours_start")),
          endLocal: String(getField(workspaceRow, "quiet_hours_end")),
        };
        const allowedAt = adjustForQuietHours(
          now,
          occurrence.timezone,
          quietHours,
          occurrence.ignoreQuietHours,
        );
        if (allowedAt > now) {
          await transaction.executeQuery(
            `
              DECLARE $workspace_id AS Utf8;
              DECLARE $occurrence_id AS Utf8;
              DECLARE $expected_at AS Timestamp;
              DECLARE $deferred_until AS Timestamp;
              DECLARE $updated_at AS Timestamp;
              UPDATE reminder_occurrences SET
                next_notification_at = $deferred_until,
                updated_at = $updated_at
              WHERE workspace_id = $workspace_id
                AND occurrence_id = $occurrence_id
                AND notification_state = 'waiting'
                AND next_notification_at = $expected_at;
            `,
            {
              $workspace_id: TypedValues.utf8(workspaceId),
              $occurrence_id: TypedValues.utf8(occurrenceId),
              $expected_at: timestampValue(occurrence.nextNotificationAt),
              $deferred_until: timestampValue(allowedAt),
              $updated_at: timestampValue(now),
            },
          );
          return null;
        }

        let targetChatId = Number(getField(workspaceRow, "telegram_chat_id"));
        if (occurrence.visibility === "private") {
          if (occurrence.assignment.mode !== "person") {
            throw new Error("Private occurrence has no responsible person");
          }
          const { resultSets: userResultSets } = await transaction.executeQuery(
            `
              DECLARE $user_id AS Int64;
              SELECT private_chat_available, private_chat_id FROM users
              WHERE user_id = $user_id
              LIMIT 1;
            `,
            {
              $user_id: TypedValues.int64(occurrence.assignment.responsibleUserId),
            },
          );
          const userRow = mapResultRows(userResultSets[0])[0];
          if (
            !userRow ||
            !Boolean(getField(userRow, "private_chat_available")) ||
            getField(userRow, "private_chat_id") == null
          ) {
            throw new DeliveryTargetUnavailableError(
              occurrence.assignment.responsibleUserId,
            );
          }
          targetChatId = Number(getField(userRow, "private_chat_id"));
        }

        let escalationDueAt: Date | null = null;
        if (occurrence.escalation.enabled) {
          const firstEscalationAt = calculateFirstEscalationAt(
            occurrence.dueAt,
            occurrence.escalation.delayMinutes,
            occurrence.timezone,
            quietHours,
            occurrence.ignoreQuietHours,
          );
          escalationDueAt = lastEscalatedAt
            ? new Date(Math.max(
                firstEscalationAt.getTime(),
                calculateNextEscalationAt(
                  lastEscalatedAt,
                  occurrence.escalation.repeatMinutes,
                  occurrence.timezone,
                  quietHours,
                  occurrence.ignoreQuietHours,
                ).getTime(),
              ))
            : firstEscalationAt;
        }
        const shouldEscalate = occurrence.visibility === "group" &&
          escalationWatchers.length > 0 &&
          escalationDueAt != null &&
          escalationDueAt <= now;
        const deliveryType = shouldEscalate
          ? "escalation"
          : occurrence.notificationSequence === 0 ? "initial" : "repeat";
        const scheduledAt = occurrence.nextNotificationAt;
        const deliveryKey = createDeliveryKey(
          occurrence.occurrenceId,
          deliveryType,
          scheduledAt,
          occurrence.notificationSequence,
        );
        const nextNotificationAt = calculateNextNotificationAt(
          now,
          occurrence.repeatIntervalMinutes,
          occurrence.timezone,
          quietHours,
          occurrence.ignoreQuietHours,
        );
        const delivery: NotificationDelivery = {
          workspaceId,
          deliveryKey,
          occurrenceId,
          reminderId: occurrence.reminderId,
          deliveryType,
          sequence: occurrence.notificationSequence,
          scheduledAt,
          claimedAt: now,
          status: "reserved",
          telegramChatId: targetChatId,
          telegramMessageId: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $delivery_key AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $reminder_id AS Utf8;
            DECLARE $delivery_type AS Utf8;
            DECLARE $sequence AS Uint32;
            DECLARE $scheduled_at AS Timestamp;
            DECLARE $claimed_at AS Timestamp;
            DECLARE $occurrence_revision AS Uint64;
            DECLARE $status AS Utf8;
            DECLARE $telegram_chat_id AS Int64;
            DECLARE $next_notification_at AS Timestamp;
            DECLARE $next_sequence AS Uint32;

            INSERT INTO notification_deliveries (
              workspace_id, delivery_key, occurrence_id, reminder_id,
              delivery_type, sequence, scheduled_at, claimed_at, status,
              occurrence_revision, telegram_chat_id, created_at, updated_at
            ) VALUES (
              $workspace_id, $delivery_key, $occurrence_id, $reminder_id,
              $delivery_type, $sequence, $scheduled_at, $claimed_at, $status,
              $occurrence_revision, $telegram_chat_id, $claimed_at, $claimed_at
            );

            UPDATE reminder_occurrences SET
              status = IF(due_at <= $claimed_at, 'overdue', status),
              next_notification_at = $next_notification_at,
              notification_sequence = $next_sequence,
              delivery_lock_key = $delivery_key,
              delivery_locked_at = $claimed_at,
              snoozed_by = NULL,
              snoozed_at = NULL,
              snooze_until = NULL,
              updated_at = $claimed_at
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND notification_state = 'waiting'
              AND notification_sequence = $sequence
              AND next_notification_at = $scheduled_at;
          `,
          {
            $workspace_id: TypedValues.utf8(delivery.workspaceId),
            $delivery_key: TypedValues.utf8(delivery.deliveryKey),
            $occurrence_id: TypedValues.utf8(delivery.occurrenceId),
            $reminder_id: TypedValues.utf8(delivery.reminderId),
            $delivery_type: TypedValues.utf8(delivery.deliveryType),
            $sequence: TypedValues.uint32(delivery.sequence),
            $scheduled_at: timestampValue(delivery.scheduledAt),
            $claimed_at: timestampValue(delivery.claimedAt),
            $occurrence_revision: TypedValues.uint64(
              Number(getField(occurrenceRow, "state_revision") ?? 1),
            ),
            $status: TypedValues.utf8(delivery.status),
            $telegram_chat_id: TypedValues.int64(targetChatId),
            $next_notification_at: timestampValue(nextNotificationAt),
            $next_sequence: TypedValues.uint32(delivery.sequence + 1),
          },
        );

        return {
          delivery,
          occurrence,
          targetChatId,
          nextNotificationAt,
          escalationWatchers: shouldEscalate ? escalationWatchers : [],
        };
      }),
    );
  }

  async beginSend(
    workspaceId: string,
    deliveryKey: string,
    now: Date = new Date(),
  ): Promise<DeliveryValidation> {
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
      const { resultSets } = await transaction.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $delivery_key AS Utf8;
          SELECT delivery.status AS delivery_status,
            delivery.telegram_chat_id AS reserved_chat_id,
            delivery.occurrence_revision AS occurrence_revision,
            delivery.occurrence_id AS occurrence_id,
            occurrence.status AS occurrence_status,
            occurrence.state_revision AS state_revision,
            occurrence.delivery_lock_key AS delivery_lock_key,
            occurrence.delivery_locked_at AS delivery_locked_at,
            occurrence.notification_state AS notification_state,
            occurrence.visibility AS visibility,
            occurrence.assignment_mode AS assignment_mode,
            occurrence.responsible_user_id AS responsible_user_id,
            reminder.status AS reminder_status,
            workspace.status AS workspace_status,
            workspace.telegram_chat_id AS workspace_chat_id,
            user.private_chat_available AS private_chat_available,
            user.private_chat_id AS private_chat_id
          FROM notification_deliveries AS delivery
          INNER JOIN reminder_occurrences AS occurrence
            ON occurrence.workspace_id = delivery.workspace_id
            AND occurrence.occurrence_id = delivery.occurrence_id
          INNER JOIN reminders AS reminder
            ON reminder.workspace_id = occurrence.workspace_id
            AND reminder.reminder_id = occurrence.reminder_id
          INNER JOIN workspaces AS workspace
            ON workspace.workspace_id = delivery.workspace_id
          LEFT JOIN users AS user
            ON occurrence.assignment_mode = 'person'
            AND user.user_id = occurrence.responsible_user_id
          WHERE delivery.workspace_id = $workspace_id
            AND delivery.delivery_key = $delivery_key
          LIMIT 1;
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $delivery_key: TypedValues.utf8(deliveryKey),
        },
      );
      const row = mapResultRows(resultSets[0])[0];
      if (!row) return { valid: false, targetChatId: null };
      let currentTargetChatId: number | null = Number(getField(row, "workspace_chat_id"));
      if (getField(row, "visibility") === "private") {
        currentTargetChatId =
          getField(row, "assignment_mode") === "person" &&
          Boolean(getField(row, "private_chat_available")) &&
          getField(row, "private_chat_id") != null
            ? Number(getField(row, "private_chat_id"))
            : null;
      }
      const reservedChatId = getField(row, "reserved_chat_id") == null
        ? null
        : Number(getField(row, "reserved_chat_id"));
      const valid =
        getField(row, "delivery_status") === "reserved" &&
          getField(row, "workspace_status") === "active" &&
          getField(row, "reminder_status") === "active" &&
          ["pending", "overdue"].includes(String(getField(row, "occurrence_status"))) &&
          getField(row, "notification_state") === "waiting" &&
          Number(getField(row, "occurrence_revision")) ===
            Number(getField(row, "state_revision")) &&
          (
            getField(row, "delivery_lock_key") === deliveryKey ||
            !hasActiveDeliveryLock(row, now)
          ) &&
          currentTargetChatId != null &&
          currentTargetChatId === reservedChatId;

      const occurrenceId = String(getField(row, "occurrence_id"));
      if (!valid) {
        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $delivery_key AS Utf8;
            DECLARE $now AS Timestamp;
            UPDATE notification_deliveries SET
              status = 'cancelled', error_code = 'reservation_stale', updated_at = $now
            WHERE workspace_id = $workspace_id
              AND delivery_key = $delivery_key
              AND status = 'reserved';
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $delivery_key: TypedValues.utf8(deliveryKey),
            $now: timestampValue(now),
          },
        );
        return { valid: false, targetChatId: currentTargetChatId };
      }

      const previousLockKey = getField(row, "delivery_lock_key");
      const leaseExpiredBefore = new Date(now.getTime() - DELIVERY_LOCK_TTL_MILLISECONDS);
      await transaction.executeQuery(
        `
          DECLARE $workspace_id AS Utf8;
          DECLARE $delivery_key AS Utf8;
          DECLARE $occurrence_id AS Utf8;
          DECLARE $previous_lock_key AS Utf8?;
          DECLARE $lease_expired_before AS Timestamp;
          DECLARE $now AS Timestamp;

          UPDATE notification_deliveries SET
            status = 'unknown', error_code = 'send_lease_expired', updated_at = $now
          WHERE workspace_id = $workspace_id
            AND delivery_key = $previous_lock_key
            AND status = 'sending';

          UPDATE notification_deliveries SET status = 'sending', updated_at = $now
          WHERE workspace_id = $workspace_id
            AND delivery_key = $delivery_key
            AND status = 'reserved';

          UPDATE reminder_occurrences SET
            delivery_lock_key = $delivery_key,
            delivery_locked_at = $now
          WHERE workspace_id = $workspace_id
            AND occurrence_id = $occurrence_id
            AND (
              delivery_lock_key = $delivery_key
              OR
              delivery_lock_key IS NULL
              OR delivery_locked_at <= $lease_expired_before
            );
        `,
        {
          $workspace_id: TypedValues.utf8(workspaceId),
          $delivery_key: TypedValues.utf8(deliveryKey),
          $occurrence_id: TypedValues.utf8(occurrenceId),
          $previous_lock_key: optionalUtf8(
            previousLockKey == null ? null : String(previousLockKey),
          ),
          $lease_expired_before: timestampValue(leaseExpiredBefore),
          $now: timestampValue(now),
        },
      );
      return { valid: true, targetChatId: currentTargetChatId };
    }),
    );
  }

  async recordResult(
    workspaceId: string,
    deliveryKey: string,
    result: DeliveryResult,
    now: Date = new Date(),
  ): Promise<NotificationDelivery | null> {
    const errorCode = result.status === "sent" ? null : (result.errorCode ?? null);
    if (errorCode && !/^[a-z0-9_.:-]{1,100}$/i.test(errorCode)) {
      throw new Error("Delivery error code must be a sanitized identifier");
    }

    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $delivery_key AS Utf8;
            SELECT delivery.*,
              occurrence.delivery_lock_key AS delivery_lock_key,
              occurrence.state_revision AS current_state_revision
            FROM notification_deliveries AS delivery
            LEFT JOIN reminder_occurrences AS occurrence
              ON occurrence.workspace_id = delivery.workspace_id
              AND occurrence.occurrence_id = delivery.occurrence_id
            WHERE delivery.workspace_id = $workspace_id
              AND delivery.delivery_key = $delivery_key
            LIMIT 1;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $delivery_key: TypedValues.utf8(deliveryKey),
          },
        );
        const row = mapResultRows(resultSets[0])[0];
        if (!row) {
          return null;
        }
        const existing = rowToDelivery(row);
        if (existing.status !== "sending") {
          if (existing.status === result.status) {
            return existing;
          }
          throw new DeliveryAlreadyFinalizedError(deliveryKey, existing.status);
        }

        const deliveryRevision = Number(getField(row, "occurrence_revision"));
        const currentRevision = Number(getField(row, "current_state_revision"));
        if (
          getField(row, "delivery_lock_key") !== deliveryKey ||
          !Number.isFinite(deliveryRevision) ||
          deliveryRevision !== currentRevision
        ) {
          await transaction.executeQuery(
            `
              DECLARE $workspace_id AS Utf8;
              DECLARE $delivery_key AS Utf8;
              DECLARE $updated_at AS Timestamp;
              UPDATE notification_deliveries SET
                status = 'unknown', error_code = 'send_lease_lost', updated_at = $updated_at
              WHERE workspace_id = $workspace_id
                AND delivery_key = $delivery_key
                AND status = 'sending';
            `,
            {
              $workspace_id: TypedValues.utf8(workspaceId),
              $delivery_key: TypedValues.utf8(deliveryKey),
              $updated_at: timestampValue(now),
            },
          );
          return {
            ...existing,
            status: "unknown",
            errorCode: "send_lease_lost",
            updatedAt: now,
          };
        }

        const telegramMessageId =
          result.status === "sent" ? result.telegramMessageId : null;
        await transaction.executeQuery(
          `
            DECLARE $workspace_id AS Utf8;
            DECLARE $delivery_key AS Utf8;
            DECLARE $occurrence_id AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $telegram_chat_id AS Int64?;
            DECLARE $telegram_message_id AS Int64?;
            DECLARE $error_code AS Utf8?;
            DECLARE $updated_at AS Timestamp;

            UPDATE notification_deliveries SET
              status = $status,
              telegram_message_id = $telegram_message_id,
              error_code = $error_code,
              updated_at = $updated_at
            WHERE workspace_id = $workspace_id
              AND delivery_key = $delivery_key
              AND status = 'sending';

            UPDATE reminder_occurrences SET
              latest_message_chat_id = IF(
                $status = 'sent', $telegram_chat_id, latest_message_chat_id
              ),
              latest_message_id = IF(
                $status = 'sent', $telegram_message_id, latest_message_id
              ),
              message_sync_required = IF(
                $status = 'sent', false, message_sync_required
              ),
              message_sync_retire_only = IF(
                $status = 'sent', false, message_sync_retire_only
              ),
              delivery_lock_key = NULL,
              delivery_locked_at = NULL,
              updated_at = $updated_at
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id
              AND delivery_lock_key = $delivery_key;
          `,
          {
            $workspace_id: TypedValues.utf8(workspaceId),
            $delivery_key: TypedValues.utf8(deliveryKey),
            $occurrence_id: TypedValues.utf8(existing.occurrenceId),
            $status: TypedValues.utf8(result.status),
            $telegram_chat_id: optionalInt64(existing.telegramChatId),
            $telegram_message_id: optionalInt64(telegramMessageId),
            $error_code: optionalUtf8(errorCode),
            $updated_at: timestampValue(now),
          },
        );

        return {
          ...existing,
          status: result.status,
          telegramMessageId,
          errorCode,
          updatedAt: now,
        };
      }),
    );
  }
}
