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
  calculateNextNotificationAt,
} from "../reminder-scheduling.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { rowToOccurrence } from "./occurrences-repository.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalUtf8,
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
}

export type DeliveryResult =
  | { status: "sent"; telegramMessageId: number }
  | { status: "failed" | "unknown"; errorCode?: string | null };

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

  async listCandidates(now: Date, limit = 100): Promise<DeliveryCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Candidate limit must be an integer between 1 and 1000");
    }
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $now AS Timestamp;
          DECLARE $limit AS Uint64;
          SELECT workspace_id, occurrence_id, next_notification_at
          FROM reminder_occurrences VIEW idx_occurrences_dispatch
          WHERE notification_state = 'waiting' AND next_notification_at <= $now
          ORDER BY notification_state, next_notification_at, workspace_id
          LIMIT $limit;
        `,
        {
          $now: timestampValue(now),
          $limit: TypedValues.uint64(limit),
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
        const occurrence = rowToOccurrence(occurrenceRow);
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

        const deliveryType = occurrence.notificationSequence === 0 ? "initial" : "repeat";
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
            DECLARE $status AS Utf8;
            DECLARE $telegram_chat_id AS Int64;
            DECLARE $next_notification_at AS Timestamp;
            DECLARE $next_sequence AS Uint32;

            INSERT INTO notification_deliveries (
              workspace_id, delivery_key, occurrence_id, reminder_id,
              delivery_type, sequence, scheduled_at, claimed_at, status,
              telegram_chat_id, created_at, updated_at
            ) VALUES (
              $workspace_id, $delivery_key, $occurrence_id, $reminder_id,
              $delivery_type, $sequence, $scheduled_at, $claimed_at, $status,
              $telegram_chat_id, $claimed_at, $claimed_at
            );

            UPDATE reminder_occurrences SET
              status = IF(due_at <= $claimed_at, 'overdue', status),
              next_notification_at = $next_notification_at,
              notification_sequence = $next_sequence,
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
            $status: TypedValues.utf8(delivery.status),
            $telegram_chat_id: TypedValues.int64(targetChatId),
            $next_notification_at: timestampValue(nextNotificationAt),
            $next_sequence: TypedValues.uint32(delivery.sequence + 1),
          },
        );

        return { delivery, occurrence, targetChatId, nextNotificationAt };
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
        if (!row) {
          return null;
        }
        const existing = rowToDelivery(row);
        if (existing.status !== "reserved") {
          if (existing.status === result.status) {
            return existing;
          }
          throw new DeliveryAlreadyFinalizedError(deliveryKey, existing.status);
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
              AND status = 'reserved';

            UPDATE reminder_occurrences SET
              latest_message_chat_id = IF(
                $status = 'sent', $telegram_chat_id, latest_message_chat_id
              ),
              latest_message_id = IF(
                $status = 'sent', $telegram_message_id, latest_message_id
              ),
              updated_at = $updated_at
            WHERE workspace_id = $workspace_id
              AND occurrence_id = $occurrence_id;
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
