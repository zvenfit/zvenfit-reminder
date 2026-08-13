import {
  DeliveriesRepository,
  OccurrenceActionsRepository,
  OccurrencesRepository,
  WorkspacesRepository,
  buildOccurrenceMessage,
  occurrenceCallbackData,
  type AppConfig,
  type ReminderOccurrence,
  type ReservedDelivery,
} from "@zvenfit-reminder/shared";
import { InlineKeyboard } from "grammy";

export interface UniversalDispatcherStats {
  mode: "universal";
  workspaces: number;
  completionFinalized: number;
  materialized: number;
  reserved: number;
  sent: number;
  failed: number;
  unknown: number;
  skipped: number;
  errors: string[];
}

interface UniversalTelegramClient {
  send(
    botToken: string,
    chatId: number,
    text: string,
    replyMarkup: InlineKeyboard,
  ): Promise<number>;
  delete(botToken: string, chatId: number, messageId: number): Promise<void>;
}

interface UniversalDispatcherDependencies {
  workspaces: Pick<WorkspacesRepository, "listActive">;
  occurrences: Pick<OccurrencesRepository, "listRuntimeCandidates" | "materialize">;
  actions: Pick<
    OccurrenceActionsRepository,
    "listCompletionFinalizationCandidates" | "finalizeCompletion"
  >;
  deliveries: Pick<
    DeliveriesRepository,
    "listCandidates" | "reserve" | "recordResult"
  >;
  telegram: UniversalTelegramClient;
}

class TelegramHttpError extends Error {
  constructor(readonly status: number) {
    super(`Telegram HTTP ${status}`);
    this.name = "TelegramHttpError";
  }
}

const telegramClient: UniversalTelegramClient = {
  async send(botToken, chatId, text, replyMarkup) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
    if (!response.ok) {
      throw new TelegramHttpError(response.status);
    }
    const body = (await response.json()) as { result?: { message_id?: number } };
    const messageId = body.result?.message_id;
    if (!messageId) {
      throw new Error("Telegram response has no message ID");
    }
    return messageId;
  },

  async delete(botToken, chatId, messageId) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!response.ok) {
      throw new TelegramHttpError(response.status);
    }
  },
};

function createDependencies(config: AppConfig): UniversalDispatcherDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    actions: new OccurrenceActionsRepository(config.ydbEndpoint, config.ydbDatabase),
    deliveries: new DeliveriesRepository(config.ydbEndpoint, config.ydbDatabase),
    telegram: telegramClient,
  };
}

function deliveryKeyboard(occurrence: ReminderOccurrence): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Выполнил", occurrenceCallbackData("done", occurrence.occurrenceId))
    .text("⏰ +1 час", occurrenceCallbackData("snooze", occurrence.occurrenceId));
}

function sanitizedErrorCode(error: unknown): string {
  return error instanceof TelegramHttpError
    ? `telegram_http_${error.status}`
    : "telegram_transport_unknown";
}

async function cleanupPreviousMessage(
  config: AppConfig,
  reservation: ReservedDelivery,
  telegram: UniversalTelegramClient,
): Promise<void> {
  const previousChatId = reservation.occurrence.latestMessageChatId;
  const previousMessageId = reservation.occurrence.latestMessageId;
  if (
    previousChatId == null ||
    previousMessageId == null ||
    (previousChatId === reservation.targetChatId &&
      previousMessageId === reservation.delivery.telegramMessageId)
  ) {
    return;
  }
  await telegram.delete(config.botToken, previousChatId, previousMessageId).catch(() => undefined);
}

async function dispatchReservation(
  config: AppConfig,
  reservation: ReservedDelivery,
  dependencies: UniversalDispatcherDependencies,
  stats: UniversalDispatcherStats,
): Promise<void> {
  const text = buildOccurrenceMessage(reservation.occurrence, reservation.delivery.claimedAt);
  try {
    const messageId = await dependencies.telegram.send(
      config.botToken,
      reservation.targetChatId,
      text,
      deliveryKeyboard(reservation.occurrence),
    );
    const delivery = await dependencies.deliveries.recordResult(
      reservation.delivery.workspaceId,
      reservation.delivery.deliveryKey,
      { status: "sent", telegramMessageId: messageId },
      new Date(),
    );
    if (!delivery) {
      throw new Error("Reserved delivery disappeared before finalization");
    }
    await cleanupPreviousMessage(
      config,
      {
        ...reservation,
        delivery: { ...delivery, telegramMessageId: messageId },
      },
      dependencies.telegram,
    );
    stats.sent += 1;
  } catch (error) {
    const status = error instanceof TelegramHttpError ? "failed" : "unknown";
    const errorCode = sanitizedErrorCode(error);
    try {
      await dependencies.deliveries.recordResult(
        reservation.delivery.workspaceId,
        reservation.delivery.deliveryKey,
        { status, errorCode },
        new Date(),
      );
    } catch {
      stats.errors.push("delivery_result_persist_failed");
    }
    stats[status] += 1;
    stats.errors.push(errorCode);
  }
}

export async function runUniversalDispatcher(
  config: AppConfig,
  now: Date = new Date(),
  providedDependencies?: UniversalDispatcherDependencies,
): Promise<UniversalDispatcherStats> {
  const dependencies = providedDependencies ?? createDependencies(config);
  const stats: UniversalDispatcherStats = {
    mode: "universal",
    workspaces: 0,
    completionFinalized: 0,
    materialized: 0,
    reserved: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    errors: [],
  };
  const workspaces = await dependencies.workspaces.listActive();
  stats.workspaces = workspaces.length;
  for (const workspace of workspaces) {
    try {
      const finalizationCandidates = await dependencies.actions.listCompletionFinalizationCandidates(
        workspace.workspaceId,
        now,
      );
      for (const candidate of finalizationCandidates) {
        try {
          const finalized = await dependencies.actions.finalizeCompletion(
            workspace.workspaceId,
            candidate.occurrenceId,
            now,
          );
          stats.completionFinalized += finalized ? 1 : 0;
          stats.skipped += finalized ? 0 : 1;
        } catch {
          stats.errors.push(`completion_finalize_failed:${workspace.workspaceId}`);
        }
      }
    } catch {
      stats.errors.push(`completion_scan_failed:${workspace.workspaceId}`);
    }

    try {
      const runtimeCandidates = await dependencies.occurrences.listRuntimeCandidates(
        workspace.workspaceId,
        now,
      );
      for (const candidate of runtimeCandidates) {
        try {
          const occurrence = await dependencies.occurrences.materialize(
            workspace.workspaceId,
            candidate.reminderId,
            { now },
          );
          stats.materialized += occurrence ? 1 : 0;
          stats.skipped += occurrence ? 0 : 1;
        } catch {
          stats.errors.push(`occurrence_materialize_failed:${workspace.workspaceId}`);
        }
      }
    } catch {
      stats.errors.push(`occurrence_scan_failed:${workspace.workspaceId}`);
    }

    try {
      const deliveryCandidates = await dependencies.deliveries.listCandidates(
        workspace.workspaceId,
        now,
      );
      for (const candidate of deliveryCandidates) {
        try {
          const reservation = await dependencies.deliveries.reserve(
            workspace.workspaceId,
            candidate.occurrenceId,
            now,
          );
          if (!reservation) {
            stats.skipped += 1;
            continue;
          }
          stats.reserved += 1;
          await dispatchReservation(config, reservation, dependencies, stats);
        } catch {
          stats.errors.push(`delivery_reserve_failed:${workspace.workspaceId}`);
        }
      }
    } catch {
      stats.errors.push(`delivery_scan_failed:${workspace.workspaceId}`);
    }
  }

  return stats;
}

export type { UniversalDispatcherDependencies, UniversalTelegramClient };
