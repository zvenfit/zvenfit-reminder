import { getField, parseYdbTimestamp, timestampValue } from "./ydb-utils.js";
import { TypedValues } from "./client.js";
import type { SerializableTransaction } from "./transaction.js";

// Cloud functions are configured with a one-minute timeout. A two-minute lease
// fences normal sends while still allowing recovery after a crashed process.
export const DELIVERY_LOCK_TTL_MILLISECONDS = 2 * 60 * 1_000;

export class DeliveryInProgressError extends Error {
  constructor(readonly occurrenceId: string) {
    super(`A Telegram delivery is in progress for occurrence ${occurrenceId}`);
    this.name = "DeliveryInProgressError";
  }
}

export function hasActiveDeliveryLock(
  row: Record<string, unknown>,
  now: Date,
): boolean {
  const key = getField(row, "delivery_lock_key");
  const lockedAt = parseYdbTimestamp(getField(row, "delivery_locked_at"));
  return Boolean(
    key &&
    lockedAt &&
    now.getTime() - lockedAt.getTime() < DELIVERY_LOCK_TTL_MILLISECONDS,
  );
}

export function assertNoActiveDeliveryLock(
  row: Record<string, unknown>,
  occurrenceId: string,
  now: Date,
): void {
  if (hasActiveDeliveryLock(row, now)) {
    throw new DeliveryInProgressError(occurrenceId);
  }
}

export async function prepareOccurrenceMutation(
  transaction: SerializableTransaction,
  workspaceId: string,
  row: Record<string, unknown>,
  occurrenceId: string,
  now: Date,
): Promise<void> {
  assertNoActiveDeliveryLock(row, occurrenceId, now);
  const staleDeliveryKey = getField(row, "delivery_lock_key");
  if (!staleDeliveryKey) return;

  await transaction.executeQuery(
    `
      DECLARE $workspace_id AS Utf8;
      DECLARE $delivery_key AS Utf8;
      DECLARE $now AS Timestamp;
      UPDATE notification_deliveries SET
        status = 'unknown', error_code = 'send_lease_expired', updated_at = $now
      WHERE workspace_id = $workspace_id
        AND delivery_key = $delivery_key
        AND status = 'sending';
    `,
    {
      $workspace_id: TypedValues.utf8(workspaceId),
      $delivery_key: TypedValues.utf8(String(staleDeliveryKey)),
      $now: timestampValue(now),
    },
  );
}
