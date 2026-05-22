import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: "bot-webhook-deploy",
      type: "module",
      dependencies: {
        "ydb-sdk": "^5.11.1",
        "@yandex-cloud/nodejs-sdk": "^2.7.7",
      },
    },
    null,
    2,
  ),
);
