import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: "@zvenfit-reminder/reminder-cron-deploy",
      type: "module",
      dependencies: {
        "ydb-sdk": "^5.11.1",
        "@yandex-cloud/nodejs-sdk": "^2.9.3",
      },
    },
    null,
    2,
  ),
);
