import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const distArg = process.argv[2];
if (!distArg) {
  throw new Error("Usage: node scripts/prune-function-deploy.mjs <dist-directory>");
}

const distDir = resolve(distArg);
if (basename(distDir) !== "dist" || !existsSync(join(distDir, "package.json"))) {
  throw new Error(`Refusing to prune an unexpected directory: ${distDir}`);
}

const nodeModules = join(distDir, "node_modules");
if (!existsSync(join(nodeModules, "ydb-sdk", "package.json"))) {
  throw new Error(`ydb-sdk is missing from deploy directory: ${distDir}`);
}

// The application loads ydb-sdk through CommonJS. The SDK uses only the
// metadata-token-service subpath from @yandex-cloud/nodejs-sdk at runtime;
// generated API clients and their dedicated dependency tree are not needed.
const removablePaths = [
  "@types",
  "@yandex-cloud/nodejs-sdk/dist/generated",
  "ydb-sdk/build/esm",
  "rxjs",
  "typed-emitter",
  "luxon",
  "abort-controller-x",
  "log4js",
  "nice-grpc",
  "nice-grpc-common",
  "nice-grpc-client-middleware-deadline",
  "node-abort-controller",
  "utility-types",
  "date-format",
  "flatted",
  "rfdc",
  "streamroller",
  "fs-extra",
  "jsonfile",
  "graceful-fs",
  "universalify",
  "ts-error",
];

for (const relativePath of removablePaths) {
  rmSync(join(nodeModules, relativePath), { recursive: true, force: true });
}

const lodashDir = join(nodeModules, "lodash");
for (const entry of readdirSync(lodashDir)) {
  if (!["LICENSE", "lodash.js", "package.json"].includes(entry)) {
    rmSync(join(lodashDir, entry), { recursive: true, force: true });
  }
}

const luxonBuildDir = join(nodeModules, "ydb-sdk", "node_modules", "luxon", "build");
for (const entry of readdirSync(luxonBuildDir)) {
  if (entry !== "node") {
    rmSync(join(luxonBuildDir, entry), { recursive: true, force: true });
  }
}

function pruneNonRuntimeFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      pruneNonRuntimeFiles(path);
      continue;
    }

    if (entry.endsWith(".d.ts") || entry.endsWith(".map") || entry.endsWith(".md")) {
      rmSync(path);
    }
  }
}

pruneNonRuntimeFiles(nodeModules);

const metadataTokenService = join(
  nodeModules,
  "@yandex-cloud",
  "nodejs-sdk",
  "dist",
  "token-service",
  "metadata-token-service.js",
);
if (!existsSync(metadataTokenService)) {
  throw new Error("Metadata token service was removed from the deploy bundle");
}

console.log(`Pruned function deploy directory: ${distDir}`);
