import { describe, expect, it, vi } from "vitest";
import type { SerializableTransaction } from "./transaction.js";
import {
  DeliveryInProgressError,
  prepareOccurrenceMutation,
} from "./delivery-guard.js";
import { decodeYdbValue } from "./ydb-utils.js";

describe("prepareOccurrenceMutation", () => {
  it("retires the sending delivery when a stale lease is reclaimed", async () => {
    const executeQuery = vi.fn().mockResolvedValue({ resultSets: [] });
    const transaction = { executeQuery } as unknown as SerializableTransaction;

    await prepareOccurrenceMutation(
      transaction,
      "workspace-a",
      {
        delivery_lock_key: "delivery-a",
        delivery_locked_at: "2026-08-13T12:00:00.000Z",
      },
      "occurrence-a",
      new Date("2026-08-13T12:03:00.000Z"),
    );

    expect(executeQuery).toHaveBeenCalledOnce();
    expect(executeQuery.mock.calls[0]?.[0]).toContain("send_lease_expired");
    expect(decodeYdbValue(executeQuery.mock.calls[0]?.[1]?.$delivery_key)).toBe("delivery-a");
  });

  it("blocks mutation while the delivery lease is active", async () => {
    const executeQuery = vi.fn();
    const transaction = { executeQuery } as unknown as SerializableTransaction;

    await expect(prepareOccurrenceMutation(
      transaction,
      "workspace-a",
      {
        delivery_lock_key: "delivery-a",
        delivery_locked_at: "2026-08-13T12:02:30.000Z",
      },
      "occurrence-a",
      new Date("2026-08-13T12:03:00.000Z"),
    )).rejects.toBeInstanceOf(DeliveryInProgressError);
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
