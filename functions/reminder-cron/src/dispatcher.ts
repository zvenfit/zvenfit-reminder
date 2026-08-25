import {
  DeliveriesRepository,
  OccurrenceActionsRepository,
  OccurrencesRepository,
  WorkspacesRepository,
  buildOccurrenceMessage,
  escapeHtml,
  occurrenceCallbackData,
  telegramApiRequest,
  type AppConfig,
  type ReminderOccurrence,
  type ReservedDelivery,
} from "@zvenfit-reminder/shared";
import { setDefaultResultOrder } from "node:dns";

// Yandex Cloud Functions has public IPv4 egress, while Telegram may resolve to IPv6 first.
setDefaultResultOrder("ipv4first");
const TELEGRAM_API_TIMEOUT_MS = 10_000;

export interface DispatcherStats {
  mode: "workspace";
  workspaces: number;
  completionFinalized: number;
  messagesSynced: number;
  materialized: number;
  reserved: number;
  sent: number;
  failed: number;
  unknown: number;
  skipped: number;
  errors: string[];
}

interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data: string;
  }>>;
}

interface TelegramClient {
  send(
    botToken: string,
    chatId: number,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<number>;
  delete(botToken: string, chatId: number, messageId: number): Promise<void>;
  editFinal(
    botToken: string,
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void>;
  editActive(
    botToken: string,
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void>;
}

interface DispatcherDependencies {
  workspaces: Pick<WorkspacesRepository, "listActive">;
  occurrences: Pick<
    OccurrencesRepository,
    "listRuntimeCandidates" | "materialize" |
    "listMessageSyncCandidates" | "beginMessageSync" | "finishMessageSync"
  >;
  actions: Pick<
    OccurrenceActionsRepository,
    "listCompletionFinalizationCandidates" | "finalizeCompletion" |
    "markCompletionMessageFinalized"
  >;
  deliveries: Pick<
    DeliveriesRepository,
    "listCandidates" | "reserve" | "beginSend" | "recordResult"
  >;
  telegram: TelegramClient;
}

class TelegramHttpError extends Error {
  constructor(readonly status: number, readonly description: string | null = null) {
    super(`Telegram HTTP ${status}${description ? `: ${description}` : ""}`);
    this.name = "TelegramHttpError";
  }
}

export function createTelegramClient(
  routing: Pick<AppConfig, "telegramApiRoot" | "telegramProxySecret"> = {},
): TelegramClient {
  return {
    async send(botToken, chatId, text, replyMarkup) {
      const request = telegramApiRequest({ ...routing, botToken }, "sendMessage");
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
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
      const request = telegramApiRequest({ ...routing, botToken }, "deleteMessage");
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new TelegramHttpError(response.status);
      }
    },

    async editFinal(botToken, chatId, messageId, text) {
      await editTelegramMessage(
        routing,
        botToken,
        chatId,
        messageId,
        text,
        { inline_keyboard: [] },
      );
    },

    async editActive(botToken, chatId, messageId, text, replyMarkup) {
      await editTelegramMessage(routing, botToken, chatId, messageId, text, replyMarkup);
    },
  };
}

export const telegramClient: TelegramClient = createTelegramClient();

async function editTelegramMessage(
  routing: Pick<AppConfig, "telegramApiRoot" | "telegramProxySecret">,
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup: InlineKeyboardMarkup,
): Promise<void> {
  const request = telegramApiRequest({ ...routing, botToken }, "editMessageText");
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
    signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { description?: unknown } | null;
    const description = typeof body?.description === "string" ? body.description : null;
    const normalized = description?.toLowerCase() ?? "";
    if (
      response.status === 400 &&
      (normalized.includes("message is not modified") ||
        normalized.includes("message to edit not found"))
    ) {
      return;
    }
    throw new TelegramHttpError(response.status, description);
  }
}

function createDependencies(config: AppConfig): DispatcherDependencies {
  return {
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    occurrences: new OccurrencesRepository(config.ydbEndpoint, config.ydbDatabase),
    actions: new OccurrenceActionsRepository(config.ydbEndpoint, config.ydbDatabase),
    deliveries: new DeliveriesRepository(config.ydbEndpoint, config.ydbDatabase),
    telegram: createTelegramClient(config),
  };
}

function deliveryKeyboard(occurrence: ReminderOccurrence): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: occurrence.kind === "payment" ? "✅ Оплатил" : "✅ Выполнил",
        callback_data: occurrenceCallbackData("done", occurrence.occurrenceId),
      },
      {
        text: "⏰ +1 час",
        callback_data: occurrenceCallbackData("snooze", occurrence.occurrenceId),
      },
    ]],
  };
}

function messageSyncKeyboard(
  occurrence: ReminderOccurrence,
  now: Date,
): InlineKeyboardMarkup | null {
  if (occurrence.status === "completed" && occurrence.undoUntil && occurrence.undoUntil > now) {
    return {
      inline_keyboard: [[{
        text: occurrence.kind === "payment" ? "↩️ Отменить оплату" : "↩️ Отменить выполнение",
        callback_data: occurrenceCallbackData("undo", occurrence.occurrenceId),
      }]],
    };
  }
  if (
    occurrence.notificationState === "waiting" &&
    ["scheduled", "pending", "overdue"].includes(occurrence.status)
  ) {
    return deliveryKeyboard(occurrence);
  }
  return null;
}

function formatOccurrenceInstant(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(instant);
}

function messageSyncText(occurrence: ReminderOccurrence, now: Date): string {
  const base = buildOccurrenceMessage(occurrence, now);
  if (occurrence.status === "completed") {
    const actorName = escapeHtml(occurrence.completedByDisplayName ?? "Участник");
    const actor = occurrence.completedBy == null
      ? actorName
      : `<a href="tg://user?id=${occurrence.completedBy}">${actorName}</a>`;
    const completedAt = occurrence.completedAt
      ? formatOccurrenceInstant(occurrence.completedAt, occurrence.timezone)
      : null;
    return `${base}\n\n✅ ${occurrence.kind === "payment" ? "Оплачено" : "Выполнено"}: ${actor}${
      completedAt ? `\nКогда: ${escapeHtml(completedAt)}` : ""
    }`;
  }
  if (occurrence.status === "cancelled") {
    return `${base}\n\n⏹ Напоминание завершено`;
  }
  if (occurrence.notificationState === "stopped") {
    return `${base}\n\n⏸ Напоминание приостановлено`;
  }
  if (occurrence.snoozeUntil) {
    return `${base}\n\n⏰ Отложено до ${escapeHtml(
      formatOccurrenceInstant(occurrence.snoozeUntil, occurrence.timezone),
    )}`;
  }
  return base;
}

function sanitizedErrorCode(error: unknown): string {
  return error instanceof TelegramHttpError
    ? `telegram_http_${error.status}`
    : "telegram_transport_unknown";
}

async function cleanupPreviousMessage(
  config: AppConfig,
  reservation: ReservedDelivery,
  telegram: TelegramClient,
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
  await retireMessage(config, telegram, previousChatId, previousMessageId);
}

async function retireMessage(
  config: AppConfig,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await telegram.delete(config.botToken, chatId, messageId);
  } catch {
    await telegram.editFinal(
      config.botToken,
      chatId,
      messageId,
      "↪️ Напоминание обновлено. Используйте последнее сообщение.",
    ).catch(() => undefined);
  }
}

async function dispatchReservation(
  config: AppConfig,
  reservation: ReservedDelivery,
  dependencies: DispatcherDependencies,
  stats: DispatcherStats,
): Promise<void> {
  const validation = await dependencies.deliveries.beginSend(
    reservation.delivery.workspaceId,
    reservation.delivery.deliveryKey,
    new Date(),
  );
  if (!validation.valid || validation.targetChatId !== reservation.targetChatId) {
    stats.skipped += 1;
    return;
  }
  let sentMessageId: number | null = null;
  try {
    const text = buildOccurrenceMessage(
      reservation.occurrence,
      reservation.delivery.claimedAt,
      { escalationWatchers: reservation.escalationWatchers },
    );
    sentMessageId = await dependencies.telegram.send(
      config.botToken,
      reservation.targetChatId,
      text,
      deliveryKeyboard(reservation.occurrence),
    );
    const delivery = await dependencies.deliveries.recordResult(
      reservation.delivery.workspaceId,
      reservation.delivery.deliveryKey,
      { status: "sent", telegramMessageId: sentMessageId },
      new Date(),
    );
    if (!delivery) {
      throw new Error("Reserved delivery disappeared before finalization");
    }
    if (delivery.status !== "sent") {
      await retireMessage(
        config,
        dependencies.telegram,
        reservation.targetChatId,
        sentMessageId,
      );
      stats.unknown += 1;
      stats.errors.push(delivery.errorCode ?? "send_lease_lost");
      return;
    }
    await cleanupPreviousMessage(
      config,
      {
        ...reservation,
        delivery: { ...delivery, telegramMessageId: sentMessageId },
      },
      dependencies.telegram,
    );
    stats.sent += 1;
  } catch (error) {
    if (sentMessageId != null) {
      await retireMessage(
        config,
        dependencies.telegram,
        reservation.targetChatId,
        sentMessageId,
      );
    }
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

export async function runDispatcher(
  config: AppConfig,
  now: Date = new Date(),
  providedDependencies?: DispatcherDependencies,
): Promise<DispatcherStats> {
  const dependencies = providedDependencies ?? createDependencies(config);
  const stats: DispatcherStats = {
    mode: "workspace",
    workspaces: 0,
    completionFinalized: 0,
    messagesSynced: 0,
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
          let telegramFinalized = true;
          if (
            finalized?.occurrence.latestMessageChatId != null &&
            finalized.occurrence.latestMessageId != null
          ) {
            try {
              await dependencies.telegram.editFinal(
                config.botToken,
                finalized.occurrence.latestMessageChatId,
                finalized.occurrence.latestMessageId,
                messageSyncText(finalized.occurrence, now),
              );
            } catch {
              telegramFinalized = false;
              stats.errors.push("completion_message_finalize_failed");
            }
          }
          if (finalized && telegramFinalized) {
            await dependencies.actions.markCompletionMessageFinalized(
              workspace.workspaceId,
              candidate.occurrenceId,
              now,
            );
          }
          stats.completionFinalized += finalized ? 1 : 0;
          stats.skipped += finalized ? 0 : 1;
        } catch {
          stats.errors.push("completion_finalize_failed");
        }
      }
    } catch {
      stats.errors.push("completion_scan_failed");
    }

    try {
      const messageCandidates = await dependencies.occurrences.listMessageSyncCandidates(
        workspace.workspaceId,
      );
      for (const candidate of messageCandidates) {
        const claim = await dependencies.occurrences.beginMessageSync(
          workspace.workspaceId,
          candidate.occurrence.occurrenceId,
          candidate.stateRevision,
          now,
        );
        if (!claim) {
          stats.skipped += 1;
          continue;
        }
        const { occurrence, stateRevision, syncKey, retireOnly } = claim;
        let succeeded = false;
        try {
          if (occurrence.latestMessageChatId != null && occurrence.latestMessageId != null) {
            const keyboard = retireOnly ? null : messageSyncKeyboard(occurrence, now);
            if (retireOnly) {
              await dependencies.telegram.editFinal(
                config.botToken,
                occurrence.latestMessageChatId,
                occurrence.latestMessageId,
                "↪️ Напоминание перенесено. Используйте последнее сообщение.",
              );
            } else if (keyboard) {
              await dependencies.telegram.editActive(
                config.botToken,
                occurrence.latestMessageChatId,
                occurrence.latestMessageId,
                messageSyncText(occurrence, now),
                keyboard,
              );
            } else {
              await dependencies.telegram.editFinal(
                config.botToken,
                occurrence.latestMessageChatId,
                occurrence.latestMessageId,
                messageSyncText(occurrence, now),
              );
            }
          }
          succeeded = true;
          stats.messagesSynced += 1;
        } catch {
          stats.errors.push("message_sync_failed");
        } finally {
          try {
            await dependencies.occurrences.finishMessageSync(
              workspace.workspaceId,
              occurrence.occurrenceId,
              stateRevision,
              syncKey,
              succeeded,
            );
          } catch {
            stats.errors.push("message_sync_finalize_failed");
          }
        }
      }
    } catch {
      stats.errors.push("message_sync_scan_failed");
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
          stats.errors.push("occurrence_materialize_failed");
        }
      }
    } catch {
      stats.errors.push("occurrence_scan_failed");
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
          stats.errors.push("delivery_reserve_failed");
        }
      }
    } catch {
      stats.errors.push("delivery_scan_failed");
    }
  }

  return stats;
}

export type { DispatcherDependencies, TelegramClient };
