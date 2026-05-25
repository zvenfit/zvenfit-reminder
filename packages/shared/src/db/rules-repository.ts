import { randomUUID } from "node:crypto";
import { TypedValues, withSession } from "./client.js";
import {
  getField,
  mapResultRows,
  optionalInt64,
  optionalTimestamp,
  optionalUint8,
  parseJsonDocument,
  parseYdbTimestamp,
  parseYdbTimestampRequired,
  timestampValue,
} from "./ydb-utils.js";
import type { CreateRuleInput, Rule, RuleStatus, UpdateRuleInput } from "../types.js";

function rowToRule(data: Record<string, unknown>): Rule {
  return {
    id: String(getField(data, "id")),
    title: String(getField(data, "title")),
    amount: getField(data, "amount") == null ? null : Number(getField(data, "amount")),
    ruleType: String(getField(data, "rule_type")) as Rule["ruleType"],
    dayOfMonth: getField(data, "day_of_month") == null ? null : Number(getField(data, "day_of_month")),
    dueAt: parseYdbTimestamp(getField(data, "due_at")),
    timeLocal: String(getField(data, "time_local")),
    timezone: String(getField(data, "timezone")),
    chatId: Number(getField(data, "chat_id")),
    mentionIds: parseJsonDocument<number[]>(getField(data, "mention_ids"), []),
    status: String(getField(data, "status")) as RuleStatus,
    createdAt: parseYdbTimestampRequired(getField(data, "created_at"), "created_at"),
    updatedAt: parseYdbTimestampRequired(getField(data, "updated_at"), "updated_at"),
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
        return mapResultRows(resultSets[0]).map(rowToRule);
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
      return mapResultRows(resultSets[0]).map(rowToRule);
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
      const mapped = mapResultRows(resultSets[0]);
      return mapped[0] ? rowToRule(mapped[0]) : null;
    });
  }

  async listActive(): Promise<Rule[]> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(`
        SELECT * FROM rules WHERE status = 'active';
      `);
      return mapResultRows(resultSets[0]).map(rowToRule);
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
          $amount: optionalInt64(rule.amount),
          $rule_type: TypedValues.utf8(rule.ruleType),
          $day_of_month: optionalUint8(rule.dayOfMonth),
          $due_at: optionalTimestamp(rule.dueAt),
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
          $amount: optionalInt64(updated.amount),
          $rule_type: TypedValues.utf8(updated.ruleType),
          $day_of_month: optionalUint8(updated.dayOfMonth),
          $due_at: optionalTimestamp(updated.dueAt),
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
