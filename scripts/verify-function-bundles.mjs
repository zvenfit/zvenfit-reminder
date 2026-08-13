const functionBundles = [
  ["bot-webhook", "../functions/bot-webhook/dist/index.js"],
  ["reminder-cron", "../functions/reminder-cron/dist/index.js"],
];

for (const [name, relativePath] of functionBundles) {
  const module = await import(new URL(relativePath, import.meta.url));
  if (typeof module.handler !== "function") {
    throw new Error(`${name} bundle does not export a handler function`);
  }
}

console.log(`Verified ${functionBundles.length} function bundle(s).`);
