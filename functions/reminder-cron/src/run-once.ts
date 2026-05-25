import { handler } from "./index.js";

const once = process.argv.includes("--once");
const INTERVAL_MS = 5 * 60 * 1000;

async function run(): Promise<void> {
  const result = await handler();
  const body = JSON.parse(result.body);
  console.log(`[${new Date().toISOString()}]`, JSON.stringify(body, null, 2));
}

if (once) {
  await run();
} else {
  console.log("Cron runner: every 5 minutes (pass --once for single run)");
  await run();
  setInterval(() => {
    void run();
  }, INTERVAL_MS);
}
