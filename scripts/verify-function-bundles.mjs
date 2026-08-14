import { createRequire } from "node:module";

const functionBundles = [
  ["bot-webhook", "../functions/bot-webhook/dist/index.js"],
  ["reminder-cron", "../functions/reminder-cron/dist/index.js"],
];

for (const [name, relativePath] of functionBundles) {
  const bundleUrl = new URL(relativePath, import.meta.url);
  const module = await import(bundleUrl);
  if (typeof module.handler !== "function") {
    throw new Error(`${name} bundle does not export a handler function`);
  }

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
