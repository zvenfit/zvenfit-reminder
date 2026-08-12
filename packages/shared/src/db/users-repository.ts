import { z } from "zod";
import type { TelegramUser } from "../reminder-domain.js";
import { createSessionRunner, TypedValues, type SessionRunner } from "./client.js";
import { withSerializableTransaction } from "./transaction.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalUtf8,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";

const observeUserSchema = z
  .object({
    userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    username: z.string().trim().min(1).max(64).nullable(),
    displayName: z.string().trim().min(1).max(200),
    locale: z.string().trim().min(2).max(20).nullable().default(null),
    privateChatId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .default(null),
  })
  .strict();

export type ObserveUserInput = z.input<typeof observeUserSchema>;

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function rowToUser(row: Record<string, unknown>): TelegramUser {
  return {
    userId: Number(getField(row, "user_id")),
    username: nullableString(getField(row, "username")),
    displayName: String(getField(row, "display_name")),
    privateChatAvailable: Boolean(getField(row, "private_chat_available")),
    privateChatId: nullableNumber(getField(row, "private_chat_id")),
    locale: nullableString(getField(row, "locale")),
    createdAt: parseYdbTimestampRequired(getField(row, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(row, "updated_at"), "updated_at"),
  };
}

export class UsersRepository {
  private readonly runSession: SessionRunner;

  constructor(endpoint: string, database: string, runSession?: SessionRunner) {
    this.runSession = runSession ?? createSessionRunner(endpoint, database);
  }

  async getById(userId: number): Promise<TelegramUser | null> {
    return this.runSession(async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $user_id AS Int64;
          SELECT * FROM users WHERE user_id = $user_id LIMIT 1;
        `,
        { $user_id: TypedValues.int64(userId) },
      );
      const row = mapResultRows(resultSets[0])[0];
      return row ? rowToUser(row) : null;
    });
  }

  async observe(input: ObserveUserInput, now: Date = new Date()): Promise<TelegramUser> {
    const parsed = observeUserSchema.parse(input);
    return this.runSession((session) =>
      withSerializableTransaction(session, async (transaction) => {
        const { resultSets } = await transaction.executeQuery(
          `
            DECLARE $user_id AS Int64;
            SELECT * FROM users WHERE user_id = $user_id LIMIT 1;
          `,
          { $user_id: TypedValues.int64(parsed.userId) },
        );
        const existingRow = mapResultRows(resultSets[0])[0];
        const existing = existingRow ? rowToUser(existingRow) : null;
        const privateChatId = parsed.privateChatId ?? existing?.privateChatId ?? null;
        const user: TelegramUser = {
          userId: parsed.userId,
          username: parsed.username,
          displayName: parsed.displayName,
          privateChatAvailable: privateChatId != null,
          privateChatId,
          locale: parsed.locale ?? existing?.locale ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        await transaction.executeQuery(
          `
            DECLARE $user_id AS Int64;
            DECLARE $username AS Utf8?;
            DECLARE $display_name AS Utf8;
            DECLARE $private_chat_available AS Bool;
            DECLARE $private_chat_id AS Int64?;
            DECLARE $locale AS Utf8?;
            DECLARE $created_at AS Timestamp;
            DECLARE $updated_at AS Timestamp;
            UPSERT INTO users (
              user_id, username, display_name, private_chat_available,
              private_chat_id, locale, created_at, updated_at
            ) VALUES (
              $user_id, $username, $display_name, $private_chat_available,
              $private_chat_id, $locale, $created_at, $updated_at
            );
          `,
          {
            $user_id: TypedValues.int64(user.userId),
            $username: optionalUtf8(user.username),
            $display_name: TypedValues.utf8(user.displayName),
            $private_chat_available: TypedValues.bool(user.privateChatAvailable),
            $private_chat_id: optionalInt64(user.privateChatId),
            $locale: optionalUtf8(user.locale),
            $created_at: timestampValue(user.createdAt),
            $updated_at: timestampValue(user.updatedAt),
          },
        );
        return user;
      }),
    );
  }
}
