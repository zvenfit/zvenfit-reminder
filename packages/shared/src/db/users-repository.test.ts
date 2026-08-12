import { describe, expect, it, vi } from "vitest";
import type { TableSession } from "ydb-sdk";
import type { SessionRunner } from "./client.js";
import { UsersRepository } from "./users-repository.js";
import { decodeYdbValue } from "./ydb-utils.js";

function resultSet(rows: Array<Record<string, string | number | boolean | null>>) {
  const names = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns: names.map((name) => ({ name })),
    rows: rows.map((row) => ({
      items: names.map((name) => {
        const value = row[name];
        if (value == null) return { nullFlagValue: "NULL_VALUE" };
        if (typeof value === "number") return { int64Value: value };
        if (typeof value === "boolean") return { boolValue: value };
        return { textValue: value };
      }),
    })),
  };
}

describe("UsersRepository", () => {
  it("records a private chat without losing the original creation time", async () => {
    const existing = {
      user_id: 20,
      username: "old_name",
      display_name: "Old Name",
      private_chat_available: false,
      private_chat_id: null,
      locale: "ru",
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    };
    const session = {
      beginTransaction: vi.fn().mockResolvedValue({ id: "tx-user" }),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      executeQuery: vi.fn(async (query: string) => ({
        resultSets: query.includes("SELECT * FROM users") ? [resultSet([existing])] : [],
      })),
    };
    const runSession: SessionRunner = async (operation) =>
      operation(session as unknown as TableSession);
    const repository = new UsersRepository("", "", runSession);
    const now = new Date("2026-08-13T12:00:00.000Z");

    const user = await repository.observe(
      {
        userId: 20,
        username: "new_name",
        displayName: "New Name",
        locale: "ru",
        privateChatId: 20,
      },
      now,
    );

    expect(user).toMatchObject({
      userId: 20,
      username: "new_name",
      privateChatAvailable: true,
      privateChatId: 20,
    });
    expect(user.createdAt.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    const writeCall = session.executeQuery.mock.calls.find(([query]) =>
      query.includes("UPSERT INTO users"),
    );
    expect(decodeYdbValue(writeCall?.[1]?.$private_chat_id)).toBe(20);
  });
});
