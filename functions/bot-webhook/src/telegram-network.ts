import {
  TELEGRAM_BOT_TOKEN_HEADER,
  TELEGRAM_PROXY_SECRET_HEADER,
  normalizeTelegramProxyRoot,
  type AppConfig,
} from "@zvenfit-reminder/shared";
import { Agent as HttpsAgent } from "node:https";
import type { ApiClientOptions } from "grammy";

const telegramHttpsAgent = new HttpsAgent({
  family: 4,
  keepAlive: true,
});

type NodeFetchConfig = RequestInit & {
  agent?: unknown;
  compress?: unknown;
};

function telegramProxyFetch(botToken: string, proxySecret: string): typeof fetch {
  return async (input, init) => {
    const { agent: _agent, compress: _compress, ...requestInit } = init as NodeFetchConfig;
    const headers = new Headers(requestInit.headers);
    headers.set(TELEGRAM_PROXY_SECRET_HEADER, proxySecret);
    headers.set(TELEGRAM_BOT_TOKEN_HEADER, botToken);
    return globalThis.fetch(input, { ...requestInit, headers });
  };
}

export function telegramClientOptions(
  timeoutSeconds: number,
  config?: AppConfig,
): ApiClientOptions {
  if (config?.telegramApiRoot && config.telegramProxySecret) {
    const apiRoot = normalizeTelegramProxyRoot(config.telegramApiRoot);
    return {
      apiRoot,
      timeoutSeconds,
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: telegramProxyFetch(config.botToken, config.telegramProxySecret),
    };
  }

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
