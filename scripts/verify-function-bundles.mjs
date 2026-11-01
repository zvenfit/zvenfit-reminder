import assert from "node:assert/strict";
import { Agent } from "node:https";
import { createRequire } from "node:module";

const functionBundles = [
  ["bot-webhook", "../functions/bot-webhook/dist/index.js"],
  ["reminder-cron", "../functions/reminder-cron/dist/index.js"],
];

async function verifyBotTransport(getBot) {
  const env = process.env;
  process.env = {
    BOT_TOKEN: "bundle-check",
    WEBHOOK_SECRET: "bundle-check",
    YDB_ENDPOINT: "grpc://127.0.0.1:1",
    YDB_DATABASE: "/local",
  };
  try {
    const { api } = getBot();
    const agent = new Agent();
    const reachedTransport = new Error("Offline bundle check reached the HTTPS agent");
    // Let the bundled grammY and node-fetch construct and validate the request, then stop before I/O.
    agent.createConnection = () => { throw reachedTransport; };
    const client = new api.constructor(process.env.BOT_TOKEN, {
      ...api.options,
      apiRoot: "https://127.0.0.1:1",
      baseFetchConfig: { ...api.options.baseFetchConfig, agent },
    });
    await assert.rejects(client.getMe(), (error) => error.error === reachedTransport);
  } finally {
    process.env = env;
  }
}

for (const [name, relativePath] of functionBundles) {
  const bundleUrl = new URL(relativePath, import.meta.url);
  const module = await import(bundleUrl);
  if (typeof module.handler !== "function") {
    throw new Error(`${name} bundle does not export a handler function`);
  }
  if (name === "bot-webhook") await verifyBotTransport(module.getBot);

  const deployRequire = createRequire(bundleUrl);
  const ydb = deployRequire("ydb-sdk");
  const metadata = deployRequire(
    "@yandex-cloud/nodejs-sdk/dist/token-service/metadata-token-service",
  );
  if (typeof ydb.Driver !== "function" || typeof metadata.MetadataTokenService !== "function") {
    throw new Error(`${name} bundle is missing runtime YDB credentials dependencies`);
  }
}

console.log(`Verified ${functionBundles.length} function bundle(s).`);
