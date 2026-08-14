# Cloudflare webhook proxy

Telegram не может стабильно подключаться напрямую к публичным endpoint Yandex
Cloud. Worker принимает Telegram webhook на глобальном edge и пересылает его в
существующую функцию `zvenfit-reminder-bot`.

## Границы безопасности

- Worker не хранит `BOT_TOKEN`, ключи YDB или service-account JSON.
- Origin зафиксирован в `wrangler.jsonc`; произвольный URL передать нельзя.
- Принимаются только JSON `POST /` и `POST /webhook` с непустым заголовком
  `X-Telegram-Bot-Api-Secret-Token`.
- Bot-функция повторно сравнивает заголовок с `WEBHOOK_SECRET` и отвечает `403`
  при несовпадении.
- Update больше 1 MiB не пересылается.
- При недоступности origin Worker возвращает `502`, поэтому Telegram повторит
  доставку.

## Локальная проверка

```bash
npm ci
npm run types --workspace=@zvenfit-reminder/telegram-webhook-proxy
npm test --workspace=@zvenfit-reminder/telegram-webhook-proxy
npm run build --workspace=@zvenfit-reminder/telegram-webhook-proxy
```

Для локального запуска создай игнорируемый `.dev.vars` только при необходимости
переопределить `ORIGIN_URL`, затем выполни `npm run dev:proxy`.

## Production deploy

1. Подключи Cloudflare account и разверни Worker из
   `edge/telegram-webhook-proxy`.
2. Проверь `GET https://<worker>.<account>.workers.dev/health` → `{ "ok": true }`.
3. Запиши корневой URL Worker в GitHub Environment `production`, secret
   `TELEGRAM_WEBHOOK_URL`.
4. Запусти production deploy: он проверит bot username, установит Telegram
   webhook на Worker, выполнит синтетический POST через Worker и не пропустит
   свежую ошибку доставки.
5. Выполни `/setup@zvenfit_reminder_bot` в тестовой группе и проверь логи
   Worker, bot-функции и появление workspace в YDB.

Worker использует бесплатный `workers.dev` URL, KV/D1/R2 не нужны.
