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
Используй отдельно выбранного тестового бота: при старте удаляются его webhook
и ожидающие обновления (`deleteWebhook` с `drop_pending_updates: true`).
`npm run dev:bot` загружает корневой `.env`; существующая конфигурация сама по
себе не означает, что бот тестовый.

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

Для проверки текущего локального кода выбери отдельного тестового бота и
тестовую группу, запусти backend на отдельной локальной YDB после миграций.
Для настоящего Telegram Mini App нужен публичный HTTPS-адрес локального
frontend с маршрутом `/api` к этому backend; укажи его в `MINI_APP_URL`.
Используй авторизацию Telegram без dev bypass (`SKIP_INIT_DATA_VALIDATION=0`)
и без `VITE_DEV_INIT_DATA`. Пошаговая проверка — в [smoke-test.md](smoke-test.md).

1. Открой личный чат с тестовым ботом, нажми Start и затем постоянную кнопку
   «Напоминания» у поля ввода.
2. На пустом экране Mini App в блоке «Подключить группу» нажми «Выбрать группу»
   и выбери тестовую группу, где ты администратор. Если группы уже есть, сначала
   нажми «Подключить группу» на главном экране. Если системный выбор недоступен,
   перейди по предложенной кнопке в личный чат и нажми там «Выбрать группу».
   После проверки Telegram-прав появится workspace с quiet hours `22:00–08:00`;
   каждая группа получает свой workspace.
3. Нажми «Участники» и опубликуй кнопку подключения в группе.
   Каждый тестовый участник нажимает её сам. Backend сверяет workspace с чатом,
   повторно проверяет `getChatMember` и добавляет только нажавшего пользователя.
   Запасной способ публикации той же кнопки — команда `/members` в группе.
4. Для личных напоминаний ответственный должен один раз отправить боту `/start`
   в личном чате.

`/setup` от Telegram-администратора остаётся запасным способом регистрации
тестовой группы; `/sync` — повторной проверки уже известных боту пользователей.
Будущие вступления и активность также учитываются автоматически.

### Подключение групп, темы и вход в панель

- Основной вход — постоянная кнопка «Напоминания» у поля ввода в личном чате.
  Бот настраивает её при инициализации и восстанавливает при личном входе.
  `/menu`, `/start` и `/app` остаются запасными способами открыть панель.
- В пустом списке групп нажми «Выбрать группу» в блоке «Подключить группу».
  Если группы уже есть, открой этот блок кнопкой «Подключить группу» на главном
  экране или «Подключить ещё группу» в настройках, затем нажми «Выбрать группу».
  Новые клиенты Telegram покажут системный выбор группы; для остальных доступен
  переход в личный чат и временная клавиатура «Выбрать группу». Вводить команду
  не нужно. Telegram предложит добавить бота с минимальными правами администратора.
- Чтобы получить кнопку панели в подключённой группе, отправь в ней `/menu`.
  Кнопка сохраняет контекст этой группы. При настроенном Main Mini App в BotFather
  «Открыть панель» ведёт напрямую; иначе нажми «Открыть бота», затем в личном чате
  «Открыть панель».
- В форме группового напоминания выбери тему и ответственного. Если темы нет
  в списке, открой «Подключить тему», вставь ссылку из Telegram, задай название
  и нажми «Проверить и подключить». В теме появится одно тихое служебное сообщение
  без упоминаний. Доступно владельцу/организатору; `/topic Оплаты` внутри темы
  остаётся запасным способом.
- Если ответ потерялся, UI проверит статус прежней операции. Для неизвестного
  результата можно подтвердить подключение кнопкой на проверочном сообщении.
  Новая проверка запускается явно и может отправить ещё одно сообщение.
- Черновик напоминания сохраняется на этом устройстве при переходе в Telegram,
  включая незавершённый ввод даты/времени. После подтверждённого сохранения он удаляется.
- Первый сигнал, повторы и эскалации используют выбранную тему. Закрытая или
  удалённая тема отмечается недоступной; автоматического переноса в «Общее» нет.
  Для личных напоминаний тема не задаётся. Старые напоминания сохраняют прежнее место.
- До обновления функций применяются миграции `0006`–`0008`. Production proxy должен
  пропускать `getChat`, `savePreparedKeyboardButton`, `setChatMenuButton`, `setMyCommands`.
  Эти инструкции описывают настройку при будущем запуске; локальные тесты API Telegram
  подменяют и не отправляют реальные сообщения.

Первые новые endpoints:

```text
GET  /api/reminders
POST /api/reminders
PATCH /api/reminders/:id
GET  /api/dashboard
GET  /api/members
GET  /api/topics
POST /api/topic-connections
GET  /api/topic-connections/:id
POST /api/group-connections
GET  /api/group-connections/:id
POST /api/group-connections/:id/retry
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

Все endpoints требуют валидный `X-Telegram-Init-Data`.
`GET /api/workspaces` возвращает доступные пользователю группы.
`/api/group-connections` и его дочерние endpoints относятся к текущему
пользователю и позволяют подключить первую группу без `X-Workspace-Id` и
предварительного членства в workspace. Остальные перечисленные endpoints
требуют `X-Workspace-Id`; backend повторно проверяет активное членство
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
следующего раздела. CI поднимает такой же YDB-контейнер и отдельно выполняет
`read-queries.integration.test.ts` для всех критичных read-запросов Mini App.

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

Проверки SQL новых сценариев на **отдельной локальной** базе `/local` после миграций:

```bash
RUN_YDB_INTEGRATION=1 YDB_ANONYMOUS_CREDENTIALS=1 \
  npm test --workspace=@zvenfit-reminder/shared -- read-queries.integration.test.ts
RUN_YDB_WRITE_INTEGRATION=1 YDB_ANONYMOUS_CREDENTIALS=1 \
  npm test --workspace=@zvenfit-reminder/shared -- onboarding.integration.test.ts
RUN_BOT_YDB_INTEGRATION=1 YDB_ANONYMOUS_CREDENTIALS=1 \
  npm test --workspace=@zvenfit-reminder/bot-webhook -- onboarding.integration.test.ts
```

Оба набора с записью разрешают только loopback endpoint и базу `/local`, создают
случайные тестовые записи и после проверки удаляют только записи своего запуска.
Shared-suite проверяет транзакции, конкурирующие запросы и отзыв прав. Bot-suite
проходит через настоящий API/webhook handler: подключение группы, проверку темы
и создание напоминания. Он использует подписанную синтетическую авторизацию,
подменяет транспорт Telegram и запрещает внешние HTTP-запросы. Telegram API
в этих тестах не вызывается.

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
