import {
  createRequestId,
  loadConfig,
  operationalErrorFields,
  writeFunctionLog,
} from "@zvenfit-reminder/shared";
import { runDispatcher } from "./dispatcher.js";

interface CronEvent {
  messages?: unknown[];
}

interface FunctionContext {
  requestId?: string;
}

export async function handler(
  _event: CronEvent = {},
  context: FunctionContext = {},
): Promise<{ statusCode: number; body: string }> {
  const requestId = createRequestId(context.requestId);
  const startedAt = performance.now();
  try {
    const config = loadConfig();
    const stats = await runDispatcher(config);
    const hasOperationalErrors = stats.failed > 0 || stats.unknown > 0 || stats.errors.length > 0;
    writeFunctionLog(hasOperationalErrors ? "ERROR" : "INFO", "Reminder dispatcher completed", {
      event: "cron_dispatch",
      request_id: requestId,
      duration_ms: Math.round(performance.now() - startedAt),
      workspaces: stats.workspaces,
      completion_finalized: stats.completionFinalized,
      messages_synced: stats.messagesSynced,
      materialized: stats.materialized,
      reserved: stats.reserved,
      sent: stats.sent,
      failed: stats.failed,
      unknown: stats.unknown,
      skipped: stats.skipped,
      error_count: stats.errors.length,
      error_codes: [...new Set(stats.errors)],
      error_causes: stats.errorCauses,
    });
    return {
      statusCode: hasOperationalErrors ? 500 : 200,
      body: JSON.stringify({ ok: !hasOperationalErrors, requestId, ...stats }),
    };
  } catch (error) {
    writeFunctionLog("FATAL", "Reminder dispatcher crashed", {
      event: "cron_dispatch",
      request_id: requestId,
      duration_ms: Math.round(performance.now() - startedAt),
      ...operationalErrorFields(error),
    });
    throw error;
  }
}
