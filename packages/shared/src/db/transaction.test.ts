import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import { withSerializableTransaction } from "./transaction.js";

function sessionDouble(options: { missingId?: boolean; rollbackFails?: boolean } = {}) {
  return {
    beginTransaction: vi.fn().mockResolvedValue({ id: options.missingId ? "" : "tx-1" }),
    executeQuery: vi.fn().mockResolvedValue({ resultSets: [] }),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: options.rollbackFails
      ? vi.fn().mockRejectedValue(new Error("rollback failed"))
      : vi.fn().mockResolvedValue(undefined),
  };
}

describe("withSerializableTransaction", () => {
  it("uses one explicit serializable transaction and commits it", async () => {
    const session = sessionDouble();

    const result = await withSerializableTransaction(
      session as unknown as TableSession,
      async (transaction) => {
        await transaction.executeQuery("SELECT 1;");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(session.beginTransaction).toHaveBeenCalledWith({ serializableReadWrite: {} });
    expect(session.executeQuery).toHaveBeenCalledWith("SELECT 1;", {}, { txId: "tx-1" });
    expect(session.commitTransaction).toHaveBeenCalledWith({ txId: "tx-1" });
    expect(session.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and preserves the operation error", async () => {
    const session = sessionDouble({ rollbackFails: true });
    const original = new Error("write failed");

    await expect(
      withSerializableTransaction(session as unknown as TableSession, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.rollbackTransaction).toHaveBeenCalledWith({ txId: "tx-1" });
  });

  it("fails before invoking the operation when YDB returns no transaction ID", async () => {
    const session = sessionDouble({ missingId: true });
    const operation = vi.fn();

    await expect(
      withSerializableTransaction(session as unknown as TableSession, operation),
    ).rejects.toThrow("transaction ID");
    expect(operation).not.toHaveBeenCalled();
  });
});
