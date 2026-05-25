import { startDevServer } from "./dev-server.js";
import { startPollingBot } from "./local-bot.js";

const port = Number(process.env.PORT ?? 3000);
const botMode = process.env.BOT_MODE ?? "polling";

await startDevServer(port);

if (botMode === "polling") {
  await startPollingBot();
} else {
  console.log("Telegram bot: webhook mode (POST /webhook)");
}
