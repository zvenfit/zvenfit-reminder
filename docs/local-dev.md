# Локальная разработка

## Быстрый старт (remote YDB)

```bash
cp .env.example .env
# Заполни BOT_TOKEN, ALLOWED_CHAT_ID, YDB_*, YC_SA_JSON

chmod +x scripts/prepare-sa-key.sh
./scripts/prepare-sa-key.sh
# Добавь YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=./sa-key.json в .env

npm install
```

Терминал 1 — backend + Telegram polling:

```bash
npm run dev:bot
```

Терминал 2 — Mini App:

```bash
cd mini-app
cp .env.example .env
# Опционально: npm run dev:init-data → вставь в VITE_DEV_INIT_DATA
npm run dev
```

Терминал 3 (опционально) — cron:

```bash
npm run dev:cron          # каждые 5 минут
npm run dev:cron -- --once  # один прогон
```

## Режимы

| Режим | Команда | Описание |
|-------|---------|----------|
| Unit tests | `npm run test` | Без YC и Telegram |
| Backend dev | `npm run dev:bot` | HTTP :3000 + long polling |
| Cron dev | `npm run dev:cron` | Локальный reminder-cron |
| Mini App | `cd mini-app && npm run dev` | Vite :5173, proxy `/api` → :3000 |
| Hybrid | Mini App + prod API Gateway | `VITE_API_BASE_URL=https://...` |

## Telegram

### Long polling (default)

`BOT_MODE=polling` в `.env` — команды и callbacks без ngrok.
При старте webhook сбрасывается (`deleteWebhook`).

### Webhook + tunnel

```bash
# Терминал 1
BOT_MODE=webhook npm run dev:bot

# Терминал 2
source .env
./scripts/dev-tunnel.sh
# Скопируй URL и:
./scripts/dev-tunnel.sh https://xxxx.ngrok-free.app
```

## Mini App auth

API требует `X-Telegram-Init-Data`. Два варианта для браузера:

**1. Генератор (рекомендуется)**

```bash
npm run dev:init-data
# → вставь вывод в mini-app/.env как VITE_DEV_INIT_DATA=...
```

**2. Dev bypass**

В корневом `.env`:

```env
SKIP_INIT_DATA_VALIDATION=1
DEV_USER_ID=123456789
```

Работает только при `NODE_ENV=development`.

## API smoke

```bash
INIT_DATA=$(npm run dev:init-data --silent)
curl -H "X-Telegram-Init-Data: $INIT_DATA" http://localhost:3000/api/rules
```

## YDB Local (offline)

Без Yandex Cloud аккаунта:

```bash
docker compose up -d
./scripts/ydb-local-init.sh   # ydb CLI на хосте не нужен — скрипт использует docker exec
```

В `.env`:

```env
YDB_ENDPOINT=grpc://localhost:2136
YDB_DATABASE=/local
YDB_ANONYMOUS_CREDENTIALS=1
```

Или одной командой:

```bash
npm run dev:stack
```

## Env reference

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_MODE` | `polling` | `polling` или `webhook` |
| `PORT` | `3000` | Dev HTTP server |
| `YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS` | — | Путь к SA key для remote YDB |
| `SKIP_INIT_DATA_VALIDATION` | `0` | `1` — bypass initData в dev |
| `DEV_USER_ID` | — | User id для bypass / генератора |
| `VITE_DEV_INIT_DATA` | — | initData для Mini App в браузере |
