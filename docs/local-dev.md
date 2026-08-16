# Локальная разработка

## Быстрый старт (remote YDB)

```bash
cp .env.example .env
# Заполни BOT_TOKEN, YDB_* и YC_SA_JSON

chmod +x scripts/prepare-sa-key.sh
./scripts/prepare-sa-key.sh
# Добавь YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=./sa-key.json в .env

npm ci
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
| Mini App E2E | `npm run test:e2e` | Playwright + изолированный mock API |
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
curl -H "X-Telegram-Init-Data: $INIT_DATA" http://localhost:3000/api/workspaces
```

## Группы и напоминания

После применения YDB-миграций:

1. Запусти polling-бота и выполни `/setup` в нужной группе от имени её
   администратора. Команда создаст workspace с quiet hours `22:00–08:00`.
   Команду можно выполнить в нескольких группах: каждая создаёт отдельный workspace.
2. Открой Mini App, нажми «Участники» и опубликуй кнопку подключения в группе.
   Каждый тестовый участник нажимает её сам. Backend сверяет workspace с чатом,
   повторно проверяет `getChatMember` и добавляет только нажавшего пользователя.
   Запасной способ публикации той же кнопки — команда `/members` в группе.
3. `/sync` остаётся запасной командой для повторной проверки уже известных боту
   пользователей; будущие вступления и активность также учитываются автоматически.
4. Для личных напоминаний ответственный должен один раз отправить боту `/start`
   в личном чате.

Первые новые endpoints:

```text
GET  /api/reminders
POST /api/reminders
PATCH /api/reminders/:id
GET  /api/dashboard
GET  /api/members
POST /api/occurrences/:id/complete
POST /api/occurrences/:id/snooze
POST /api/occurrences/:id/undo-completion
POST /api/reminders/:id/reassign
POST /api/reminders/:id/pause
POST /api/reminders/:id/resume
POST /api/reminders/:id/archive
PATCH /api/members/:userId/role
PATCH /api/workspace/settings
POST  /api/workspace/transfer-ownership
```

Они требуют валидный `X-Telegram-Init-Data` и активное членство в workspace.
`GET /api/workspaces` возвращает доступные пользователю группы. Остальные
endpoints требуют `X-Workspace-Id`; backend повторно проверяет активное членство
перед каждой операцией.

Для визуальной проверки нового Mini App без запущенного backend открой
`http://localhost:5173/?mock=1`. Mock-режим доступен только в Vite development
и показывает просроченное, текущее и повторяющиеся напоминания.

## Mini App E2E

Первый запуск устанавливает Chromium, следующие используют уже загруженный
браузер:

```bash
npm run test:e2e:install
npm run test:e2e
```

Playwright сам запускает Vite и подменяет API на границе HTTP. Для этих тестов
не нужны Telegram, облако, `.env` или YDB. Набор прогоняется в мобильном и
десктопном размерах и проверяет переключение групп, права участника, создание,
выполнение, отмену выполнения, отсрочку, переназначение и выдачу роли.

Для проверки настоящих YDB-запросов используется локальный контейнер из
следующего раздела. Этот интеграционный слой пока не включён в CI.

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

Скрипт применяет по порядку файлы из `infra/ydb/migrations`. Выполненные версии
и SHA-256 записываются в
`schema_migrations`; изменение уже применённого файла останавливает запуск.

Для отдельного применения миграций к настроенной базе:

```bash
YDB_ENDPOINT=grpc://localhost:2136 \
YDB_DATABASE=/local \
./scripts/apply-ydb-migrations.sh
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
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Production Worker route `/telegram`; настраивается только вместе с proxy secret |
| `TELEGRAM_PROXY_SECRET` | — | Shared secret для исходящих Bot API-вызовов через Worker |
