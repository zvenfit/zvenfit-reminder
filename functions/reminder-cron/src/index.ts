import {
  loadConfig,
} from "@zvenfit-reminder/shared";
import { runDispatcher } from "./dispatcher.js";

interface CronEvent {
  messages?: unknown[];
}

export async function handler(_event: CronEvent = {}): Promise<{ statusCode: number; body: string }> {
  const config = loadConfig();
  const stats = await runDispatcher(config);
  return { statusCode: 200, body: JSON.stringify({ ok: true, ...stats }) };
}
