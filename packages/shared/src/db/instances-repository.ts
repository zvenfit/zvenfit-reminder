import { randomUUID } from "node:crypto";
import { TypedValues, withSession } from "./client.js";
import { getField, mapResultRows, parseYdbTimestamp, parseYdbTimestampRequired, timestampValue } from "./ydb-utils.js";
import type { InstanceStatus, ReminderInstance } from "../types.js";

function rowToInstance(data: Record<string, unknown>): ReminderInstance {
  return {
    id: String(getField(data, "id")),
    ruleId: String(getField(data, "rule_id")),
    dueAt: parseYdbTimestampRequired(getField(data, "due_at"), "due_at"),
    status: String(getField(data, "status")) as InstanceStatus,
    completedBy: getField(data, "completed_by") == null ? null : Number(getField(data, "completed_by")),
    completedAt: parseYdbTimestamp(getField(data, "completed_at")),
    messageId: getField(data, "message_id") == null ? null : Number(getField(data, "message_id")),
  };
}

export class InstancesRepository {
  constructor(
    private readonly endpoint: string,
    private readonly database: string,
  ) {}

  async getById(id: string): Promise<ReminderInstance | null> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $id AS Utf8; SELECT * FROM reminder_instances WHERE id = $id LIMIT 1;`,
        { $id: TypedValues.utf8(id) },
      );
      const mapped = mapResultRows(resultSets[0]);
      return mapped[0] ? rowToInstance(mapped[0]) : null;
    });
  }

  async findByRuleAndDueAt(ruleId: string, dueAt: Date): Promise<ReminderInstance | null> {
    return withSession(this.endpoint, this.database, async (session) => {
      const { resultSets } = await session.executeQuery(
        `
          DECLARE $rule_id AS Utf8;
          DECLARE $due_at AS Timestamp;
          SELECT * FROM reminder_instances
          WHERE rule_id = $rule_id AND due_at = $due_at
          LIMIT 1;
        `,
        {
          $rule_id: TypedValues.utf8(ruleId),
          $due_at: timestampValue(dueAt),
        },
      );
      const mapped = mapResultRows(resultSets[0]);
      return mapped[0] ? rowToInstance(mapped[0]) : null;
    });
  }

  async create(ruleId: string, dueAt: Date, messageId: number, id: string = randomUUID()): Promise<ReminderInstance> {
    const instance: ReminderInstance = {
      id,
      ruleId,
      dueAt,
      status: "pending",
      completedBy: null,
      completedAt: null,
      messageId,
    };

    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $rule_id AS Utf8;
          DECLARE $due_at AS Timestamp;
          DECLARE $status AS Utf8;
          DECLARE $message_id AS Int64;
          UPSERT INTO reminder_instances (id, rule_id, due_at, status, message_id)
          VALUES ($id, $rule_id, $due_at, $status, $message_id);
        `,
        {
          $id: TypedValues.utf8(instance.id),
          $rule_id: TypedValues.utf8(instance.ruleId),
          $due_at: timestampValue(instance.dueAt),
          $status: TypedValues.utf8(instance.status),
          $message_id: TypedValues.int64(messageId),
        },
      );
    });

    return instance;
  }

  async setMessageId(id: string, messageId: number): Promise<void> {
    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $message_id AS Int64;
          UPDATE reminder_instances SET message_id = $message_id WHERE id = $id;
        `,
        {
          $id: TypedValues.utf8(id),
          $message_id: TypedValues.int64(messageId),
        },
      );
    });
  }

  async complete(id: string, userId: number): Promise<ReminderInstance | null> {
    const now = new Date();
    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $status AS Utf8;
          DECLARE $completed_by AS Int64;
          DECLARE $completed_at AS Timestamp;
          UPDATE reminder_instances SET
            status = $status,
            completed_by = $completed_by,
            completed_at = $completed_at
          WHERE id = $id;
        `,
        {
          $id: TypedValues.utf8(id),
          $status: TypedValues.utf8("done"),
          $completed_by: TypedValues.int64(userId),
          $completed_at: timestampValue(now),
        },
      );
    });
    return this.getById(id);
  }

  async skip(id: string): Promise<ReminderInstance | null> {
    await withSession(this.endpoint, this.database, async (session) => {
      await session.executeQuery(
        `
          DECLARE $id AS Utf8;
          DECLARE $status AS Utf8;
          UPDATE reminder_instances SET status = $status WHERE id = $id;
        `,
        {
          $id: TypedValues.utf8(id),
          $status: TypedValues.utf8("skipped"),
        },
      );
    });
    return this.getById(id);
  }
}
