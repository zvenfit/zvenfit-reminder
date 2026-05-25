import { TypedValues, withSession } from "./client.js";
import {
  getField,
  mapResultRows,
  optionalUtf8,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";
import type { GroupMember } from "../types.js";

function rowToMember(data: Record<string, unknown>): GroupMember {
  return {
    chatId: Number(getField(data, "chat_id")),
    userId: Number(getField(data, "user_id")),
    username: getField(data, "username") == null ? null : String(getField(data, "username")),
    displayName: String(getField(data, "display_name")),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
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
      return mapResultRows(resultSets[0]).map(rowToMember);
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
          $username: optionalUtf8(username),
          $display_name: TypedValues.utf8(displayName),
          $updated_at: timestampValue(now),
        },
      );
    });
  }
}
