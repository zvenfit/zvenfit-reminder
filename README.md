# zvenfit-reminder

Telegram-приложение для личных и групповых напоминаний: назначенный человек
получает уведомления до явного выполнения дела. Проект работает на Yandex Cloud
Functions, YDB Serverless и Telegram Mini App.

Один бот обслуживает несколько Telegram-групп. Он поддерживает разовые и
повторяющиеся напоминания, ответственность,
тихие часы, повторные сигналы, отсрочку и явное выполнение.

Репозиторий: [github.com/zvenfit/zvenfit-reminder](https://github.com/zvenfit/zvenfit-reminder).

## Архитектура

- `functions/bot-webhook` — webhook Telegram, команды бота, REST API для Mini App
- `functions/reminder-cron` — задача Cloud Timer каждые 5 минут
- `packages/shared` — репозитории YDB, планировщик, хелперы Telegram
- `mini-app` — Telegram Mini App (Vite + React)
- `infra/` — схема YDB, спецификация API Gateway, скрипты первичной настройки

Документация:

- [текущая архитектура](docs/architecture.md);
- [продуктовая спецификация](docs/product-spec.md);
- [UX и визуальная система «Тихий пульс»](docs/ux-design.md);
- [целевая архитектура и модель данных](docs/target-architecture.md);
- [план реализации и перехода](docs/implementation-plan.md);
- [стратегия тестирования](docs/testing.md);
- [группы, участники и доступы](docs/workspaces-and-access.md);
- [чистый перезапуск БД](docs/database-reset.md).

## Требования

- Node.js 22+
- [Yandex Cloud CLI](https://yandex.cloud/ru/docs/cli/quickstart)
- Токен бота от [@BotFather](https://t.me/BotFather)
- GitHub-репозиторий с включёнными Actions

## Первичная настройка Yandex Cloud

```bash
export YC_FOLDER_ID=b1g...
chmod +x infra/setup.sh
./infra/setup.sh
```

Применить схему и последовательные миграции БД:

```bash
./scripts/apply-ydb-migrations.sh
```

Создать Cloud Timer для `zvenfit-reminder-cron` или обновить уже существующий.
`SA_ID` должен принадлежать отдельному `zvenfit-reminder-invoker-sa`:

```bash
SA_ID=... YC_FOLDER_ID=... ./infra/create-timer.sh
```

Скрипт идемпотентен: при повторном запуске он сохраняет тот же trigger и
обновляет расписание, функцию и invoker service account.

Настроить API Gateway по `infra/api-gateway.yaml` и привязать к функции бота.

## GitHub Secrets

| Secret | Описание |
|--------|----------|
| `YC_SA_JSON` | JSON-ключ отдельного deploy-аккаунта |
| `YC_FOLDER_ID` | ID каталога Yandex Cloud |
| `YC_RUNTIME_SERVICE_ACCOUNT_ID` | ID runtime-аккаунта функций; без статического ключа |
| `YC_BUCKET` | Bucket Object Storage для статики Mini App |
| `YDB_ENDPOINT` | gRPC endpoint YDB |
| `YDB_DATABASE` | Путь к базе YDB |
| `BOT_TOKEN` | Токен Telegram-бота |
| `WEBHOOK_SECRET` | Случайный секрет для webhook |
| `WEBHOOK_URL` | Базовый URL API Gateway для Mini App API |
| `TELEGRAM_WEBHOOK_URL` | Корневой URL Cloudflare Worker-прокси `https://<name>.<account>.workers.dev/` |
| `MINI_APP_URL` | Публичный URL на `index.html` Mini App |
| `DEFAULT_TIMEZONE` | Опционально, по умолчанию `Europe/Moscow` |

Production-пайплайн перед обновлением функций применяет только ещё не
выполненные YDB-миграции и проверяет их контрольные суммы.

`infra/setup.sh` создаёт три отдельные identity: runtime пишет только в
конкретную YDB, invoker вызывает только функции бота и таймера, а deploy имеет
доступ к обновлению этих функций, миграциям этой базы и публикации в bucket.
Статический JSON-ключ нужен только deploy-аккаунту.

Telegram webhook использует Cloudflare Worker из
[`edge/telegram-webhook-proxy`](edge/telegram-webhook-proxy), потому что Telegram
не может стабильно подключаться к публичным endpoint Yandex Cloud. Worker
принимает только JSON POST с `X-Telegram-Bot-Api-Secret-Token`, ограничивает
размер update и пересылает его в bot-функцию. Bot token в Cloudflare не хранится;
секретный заголовок повторно проверяется функцией. Mini App API остаётся за API
Gateway и проверяет Telegram init data. Инструкция развёртывания —
[`docs/cloudflare-webhook-proxy.md`](docs/cloudflare-webhook-proxy.md).
Исходящие запросы обеих функций к Telegram принудительно используют IPv4:
serverless-egress Yandex Cloud доступен по IPv4, а DNS Telegram может первым
вернуть IPv6-адрес.

Если инфраструктура раньше использовала общий `zvenfit-reminder-sa`, после
первого успешного деплоя с тремя новыми аккаунтами отдельно отзови его широкие
роли. Скрипт настройки не делает это автоматически, чтобы случайно не оборвать
работающий production. Безопасная проверка и команды приведены в
[`docs/legacy-service-account-cleanup.md`](docs/legacy-service-account-cleanup.md).

## Локальная разработка

```bash
cp .env.example .env
npm ci
npm run check
```

Полная инструкция: [docs/local-dev.md](docs/local-dev.md).

Quick start:

```bash
./scripts/prepare-sa-key.sh   # после заполнения YC_SA_JSON
npm run dev:bot               # backend :3000 + Telegram polling
cd mini-app && npm run dev    # Mini App :5173
```

## Использование бота

1. Добавь бота администратором в каждую нужную Telegram-группу и выполни
   `/setup` от имени администратора. Каждая группа получит отдельный workspace.
2. Открой личный чат с ботом и нажми `/start`.
3. Нажми «Добавить участников» для нужной группы и выбери до 10 пользователей.
   Бот добавит только тех, чьё членство именно в этой группе подтвердит Telegram.
4. Открой Mini App кнопкой «Открыть панель» и создай напоминание.
5. Если доступно несколько групп, выбери нужную в верхней части Mini App. Новые
   участники и пользователи, активные в группе, добавляются автоматически.

Участники, роли, настройки, история и напоминания изолированы по группам. Если
ответственный выходит из группы, его активные напоминания приостанавливаются, а
владелец или организатор может переназначить их в Mini App.

Первый Telegram-администратор, выполнивший `/setup`, становится владельцем
рабочего пространства. Владелец может назначить организаторов и безопасно
передать владение через раздел «Ритм группы». Настройки и права не задаются
глобальными env-переменными.

Для группового напоминания выбранным участникам не требуется запускать бота.
Для личных сообщений каждый получатель должен один раз открыть бота сам:
Telegram не разрешает боту первым начинать личный диалог.

Запасные команды:

- `/list` — активные напоминания текущей группы
- `/sync` — владельцу или организатору повторно проверить уже известных боту участников

Выполнение и отсрочка доступны кнопками под уведомлением и в Mini App.

## Smoke test

См. [docs/smoke-test.md](docs/smoke-test.md).

## Переименование облачных ресурсов

Новые конфигурации используют префикс `zvenfit-reminder-`. Ресурсы, ранее
созданные с префиксом `payments-reminder-`, автоматически не переименовываются:
перед первым production-деплоем после переименования их нужно явно создать или
мигрировать.
