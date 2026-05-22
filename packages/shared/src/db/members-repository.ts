import { TypedValues, Types, withSession } from "./client.js";
import { getField, parseYdbTimestampRequired, timestampValue, type YdbRow } from "./ydb-utils.js";
import type { GroupMember } from "../types.js";

function rowToMember(row: YdbRow): GroupMember {
  return {
    chatId: Number(getField(row, "chat_id")),
    userId: Number(getField(row, "user_id")),
    username: getField(row, "username") == null ? null : String(getField(row, "username")),
    displayName: String(getField(row, "display_name")),
    updatedAt: parseYdbTimestampRequired(getField(row, "updated_at"), "updated_at"),
  };
}

export class MembersRepository {
  constructor(
    private readonly endpoint: string,
    private readonly database: string,
  ) {}

  async list(chatId: number): Promise<GroupMember[]> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $chat_id AS Int64;
          SELECT * FROM group_members WHERE chat_id = $chat_id ORDER BY display_name;
        `,
        { $chat_id: TypedValues.int64(chatId) },
      );
      return (resultSets[0]?.rows ?? []).map((row) => rowToMember(row as YdbRow));
    });
  }

  async upsert(chatId: number, userId: number, username: string | null, displayName: string): Promise<void> {
    const now = new Date();
    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $chat_id AS Int64;
          DECLARE $user_id AS Int64;
          DECLARE $username AS Utf8?;
          DECLARE $display_name AS Utf8;
          DECLARE $updated_at AS Timestamp;
          UPSERT INTO group_members (chat_id, user_id, username, display_name, updated_at)
          VALUES ($chat_id, $user_id, $username, $display_name, $updated_at);
        `,
        {
          $chat_id: TypedValues.int64(chatId),
          $user_id: TypedValues.int64(userId),
          $username: username ? TypedValues.utf8(username) : TypedValues.optionalNull(Types.UTF8),
          $display_name: TypedValues.utf8(displayName),
          $updated_at: timestampValue(now),
        },
      );
    });
  }
}
