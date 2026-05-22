import { randomUUID } from "node:crypto";
import { TypedValues, Types, withSession } from "./client.js";
import { getField, parseYdbTimestamp, parseYdbTimestampRequired, timestampValue, type YdbRow } from "./ydb-utils.js";
import type { CreateRuleInput, Rule, RuleStatus, UpdateRuleInput } from "../types.js";

function rowToRule(row: YdbRow): Rule {
  return {
    id: String(getField(row, "id")),
    title: String(getField(row, "title")),
    amount: getField(row, "amount") == null ? null : Number(getField(row, "amount")),
    ruleType: String(getField(row, "rule_type")) as Rule["ruleType"],
    dayOfMonth: getField(row, "day_of_month") == null ? null : Number(getField(row, "day_of_month")),
    dueAt: parseYdbTimestamp(getField(row, "due_at")),
    timeLocal: String(getField(row, "time_local")),
    timezone: String(getField(row, "timezone")),
    chatId: Number(getField(row, "chat_id")),
    mentionIds: JSON.parse(String(getField(row, "mention_ids"))) as number[],
    status: String(getField(row, "status")) as RuleStatus,
    createdAt: parseYdbTimestampRequired(getField(row, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(row, "updated_at"), "updated_at"),
  };
}

export class RulesRepository {
  constructor(
    private readonly endpoint: string,
    private readonly database: string,
  ) {}

  async list(chatId: number, status?: RuleStatus): Promise<Rule[]> {
    return withSession(this.endpoint, this.database, async (session) => {
      if (status) {
        const { resultSets } = await session.executeQuery(
          `
            DECLARE $chat_id AS Int64;
            DECLARE $status AS Utf8;
            SELECT * FROM rules
            WHERE chat_id = $chat_id AND status = $status
            ORDER BY updated_at DESC;
          `,
          {
            $chat_id: TypedValues.int64(chatId),
            $status: TypedValues.utf8(status),
          },
        );
        return (resultSets[0]?.rows ?? []).map((row) => rowToRule(row as YdbRow));
      }

      const { resultSets } = await session.executeQuery(
        `
          DECLARE $chat_id AS Int64;
          SELECT * FROM rules
          WHERE chat_id = $chat_id AND status != 'archived'
          ORDER BY updated_at DESC;
        `,
        { $chat_id: TypedValues.int64(chatId) },
      );
      return (resultSets[0]?.rows ?? []).map((row) => rowToRule(row as YdbRow));
    });
  }

  async getById(id: string): Promise<Rule | null> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          SELECT * FROM rules WHERE id = $id LIMIT 1;
        `,
        { $id: TypedValues.utf8(id) },
      );
      const row = resultSets[0]?.rows?.[0];
      return row ? rowToRule(row as YdbRow) : null;
    });
  }

  async listActive(): Promise<Rule[]> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(`
        SELECT * FROM rules WHERE status = 'active';
      `);
      return (resultSets[0]?.rows ?? []).map((row) => rowToRule(row as YdbRow));
    });
  }

  async create(input: CreateRuleInput, defaultTimezone: string): Promise<Rule> {
    const now = new Date();
    const rule: Rule = {
      id: randomUUID(),
      title: input.title,
      amount: input.amount ?? null,
      ruleType: input.ruleType,
      dayOfMonth: input.ruleType === "recurring" ? (input.dayOfMonth ?? 1) : null,
      dueAt: input.ruleType === "oneoff" && input.dueAt ? new Date(input.dueAt) : null,
      timeLocal: input.timeLocal,
      timezone: input.timezone ?? defaultTimezone,
      chatId: input.chatId,
      mentionIds: input.mentionIds,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $title AS Utf8;
          DECLARE $amount AS Int64?;
          DECLARE $rule_type AS Utf8;
          DECLARE $day_of_month AS Uint8?;
          DECLARE $due_at AS Timestamp?;
          DECLARE $time_local AS Utf8;
          DECLARE $timezone AS Utf8;
          DECLARE $chat_id AS Int64;
          DECLARE $mention_ids AS JsonDocument;
          DECLARE $status AS Utf8;
          DECLARE $created_at AS Timestamp;
          DECLARE $updated_at AS Timestamp;

          UPSERT INTO rules (
            id, title, amount, rule_type, day_of_month, due_at,
            time_local, timezone, chat_id, mention_ids, status, created_at, updated_at
          ) VALUES (
            $id, $title, $amount, $rule_type, $day_of_month, $due_at,
            $time_local, $timezone, $chat_id, $mention_ids, $status, $created_at, $updated_at
          );
        `,
        {
          $id: TypedValues.utf8(rule.id),
          $title: TypedValues.utf8(rule.title),
          $amount: rule.amount == null ? TypedValues.optionalNull(Types.INT64) : TypedValues.int64(rule.amount),
          $rule_type: TypedValues.utf8(rule.ruleType),
          $day_of_month:
            rule.dayOfMonth == null ? TypedValues.optionalNull(Types.UINT8) : TypedValues.uint8(rule.dayOfMonth),
          $due_at: rule.dueAt == null ? TypedValues.optionalNull(Types.TIMESTAMP) : timestampValue(rule.dueAt),
          $time_local: TypedValues.utf8(rule.timeLocal),
          $timezone: TypedValues.utf8(rule.timezone),
          $chat_id: TypedValues.int64(rule.chatId),
          $mention_ids: TypedValues.jsonDocument(JSON.stringify(rule.mentionIds)),
          $status: TypedValues.utf8(rule.status),
          $created_at: timestampValue(rule.createdAt),
          $updated_at: timestampValue(rule.updatedAt),
        },
      );
    });

    return rule;
  }

  async update(id: string, input: UpdateRuleInput): Promise<Rule | null> {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    const updated: Rule = {
      ...existing,
      title: input.title ?? existing.title,
      amount: input.amount !== undefined ? input.amount : existing.amount,
      ruleType: input.ruleType ?? existing.ruleType,
      dayOfMonth: input.dayOfMonth !== undefined ? input.dayOfMonth : existing.dayOfMonth,
      dueAt: input.dueAt !== undefined ? (input.dueAt ? new Date(input.dueAt) : null) : existing.dueAt,
      timeLocal: input.timeLocal ?? existing.timeLocal,
      timezone: input.timezone ?? existing.timezone,
      mentionIds: input.mentionIds ?? existing.mentionIds,
      status: input.status ?? existing.status,
      updatedAt: new Date(),
    };

    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $title AS Utf8;
          DECLARE $amount AS Int64?;
          DECLARE $rule_type AS Utf8;
          DECLARE $day_of_month AS Uint8?;
          DECLARE $due_at AS Timestamp?;
          DECLARE $time_local AS Utf8;
          DECLARE $timezone AS Utf8;
          DECLARE $mention_ids AS JsonDocument;
          DECLARE $status AS Utf8;
          DECLARE $updated_at AS Timestamp;

          UPDATE rules SET
            title = $title,
            amount = $amount,
            rule_type = $rule_type,
            day_of_month = $day_of_month,
            due_at = $due_at,
            time_local = $time_local,
            timezone = $timezone,
            mention_ids = $mention_ids,
            status = $status,
            updated_at = $updated_at
          WHERE id = $id;
        `,
        {
          $id: TypedValues.utf8(id),
          $title: TypedValues.utf8(updated.title),
          $amount: updated.amount == null ? TypedValues.optionalNull(Types.INT64) : TypedValues.int64(updated.amount),
          $rule_type: TypedValues.utf8(updated.ruleType),
          $day_of_month:
            updated.dayOfMonth == null ? TypedValues.optionalNull(Types.UINT8) : TypedValues.uint8(updated.dayOfMonth),
          $due_at:
            updated.dueAt == null ? TypedValues.optionalNull(Types.TIMESTAMP) : timestampValue(updated.dueAt),
          $time_local: TypedValues.utf8(updated.timeLocal),
          $timezone: TypedValues.utf8(updated.timezone),
          $mention_ids: TypedValues.jsonDocument(JSON.stringify(updated.mentionIds)),
          $status: TypedValues.utf8(updated.status),
          $updated_at: timestampValue(updated.updatedAt),
        },
      );
    });

    return updated;
  }

  async archive(id: string): Promise<void> {
    await this.update(id, { status: "archived" });
  }
}
