import { Agent as HttpsAgent } from "node:https";
import type { ApiClientOptions } from "grammy";

const telegramHttpsAgent = new HttpsAgent({
  family: 4,
  keepAlive: true,
});

export function telegramClientOptions(timeoutSeconds: number): ApiClientOptions {
  return {
    timeoutSeconds,
    // grammY uses node-fetch in Node.js, which accepts an HTTPS agent here.
    // Pinning the agent to IPv4 is stronger than only reordering DNS results:
    // Yandex Cloud Functions do not have reliable public IPv6 egress.
    baseFetchConfig: { agent: telegramHttpsAgent } as ApiClientOptions["baseFetchConfig"],
  };
}

export function telegramAgentFamily(): number | undefined {
  return telegramHttpsAgent.options.family;
}
