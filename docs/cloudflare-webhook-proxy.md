# Cloudflare webhook proxy

Telegram не может стабильно подключаться напрямую к публичным endpoint Yandex
Cloud. Worker принимает Telegram webhook на глобальном edge и пересылает его в
существующую функцию `zvenfit-reminder-bot`. Исходящие Bot API-запросы обеих
Cloud Functions также идут через закрытый маршрут Worker `/telegram/<method>`.

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
- Outbound-маршрут принимает только JSON до 256 KiB, отдельный proxy secret и
  валидный bot token в закрытых заголовках.
- Разрешены только необходимые методы: `getMe`, `getChatMember`, `sendMessage`,
  `editMessageText`, `deleteMessage`, `answerCallbackQuery`,
  `savePreparedKeyboardButton`, `getUserProfilePhotos` и `getFile`.
- Фото профиля скачиваются отдельным закрытым маршрутом `/telegram-file/*`:
  только после проверки proxy secret и bot token, только растровые изображения
  до 512 KiB и только по безопасному Telegram `file_path`.
- Proxy secret сравнивается constant-time. Bot token не хранится в Worker и не
  попадает в публичный URL или ответы; в Telegram он уходит по HTTPS.
- Автоматические invocation logs отключены: они могут индексировать закрытые
  заголовки запроса. Вместо них Worker пишет безопасные structured events с
  `request_id`, категорией маршрута, HTTP-статусом и длительностью, но без
  headers, body, file path и Telegram-идентификаторов.

## Локальная проверка

```bash
npm ci
npm run types --workspace=@zvenfit-reminder/telegram-webhook-proxy
npm test --workspace=@zvenfit-reminder/telegram-webhook-proxy
npm run build --workspace=@zvenfit-reminder/telegram-webhook-proxy
```

Для локального запуска создай игнорируемый `.dev.vars` с тестовым
`TELEGRAM_PROXY_SECRET`, затем выполни `npm run dev:proxy`.

## Production deploy

1. Создай случайный `TELEGRAM_PROXY_SECRET` и запиши одинаковое значение как
   Cloudflare Worker secret и GitHub Environment `production` secret.
2. Разверни Worker из `edge/telegram-webhook-proxy` и проверь
   `GET https://<worker>.<account>.workers.dev/health` → `{ "ok": true }`.
3. Запиши корневой URL Worker в GitHub Environment `production`, secret
   `TELEGRAM_WEBHOOK_URL`.
4. Запусти production deploy: он передаст функциям `/telegram` API root,
   проверит исходящий `getMe` из runtime, установит Telegram
   webhook на Worker, выполнит синтетический POST через Worker и не пропустит
   свежую ошибку доставки.
5. Выполни `/setup@zvenfit_reminder_bot` в тестовой группе и проверь логи
   Worker, bot-функции и появление workspace в YDB.

Worker использует бесплатный `workers.dev` URL, KV/D1/R2 не нужны.
