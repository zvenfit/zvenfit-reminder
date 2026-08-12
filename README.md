# zvenfit-reminder

Telegram-бот для семейных напоминаний о платежах на Yandex Cloud Functions с YDB Serverless, Mini App и деплоем через GitHub Actions.

Репозиторий: [github.com/zvenfit/zvenfit-reminder](https://github.com/zvenfit/zvenfit-reminder).

## Архитектура

- `functions/bot-webhook` — webhook Telegram, команды бота, REST API для Mini App
- `functions/reminder-cron` — задача Cloud Timer каждые 5 минут
- `packages/shared` — репозитории YDB, планировщик, хелперы Telegram
- `mini-app` — Telegram Mini App (Vite + React)
- `infra/` — схема YDB, спецификация API Gateway, скрипты первичной настройки

Подробные потоки, инварианты и известные ограничения: [docs/architecture.md](docs/architecture.md).

## Требования

- Node.js 20+
- [Yandex Cloud CLI](https://yandex.cloud/ru/docs/cli/quickstart)
- Токен бота от [@BotFather](https://t.me/BotFather)
- GitHub-репозиторий с включёнными Actions

## Первичная настройка Yandex Cloud

```bash
export YC_FOLDER_ID=b1g...
chmod +x infra/setup.sh
./infra/setup.sh
```

Применить схему БД:

```bash
ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" scheme -f infra/ydb/schema.sql
```

Создать Cloud Timer для `zvenfit-reminder-cron`:

```bash
SA_ID=... YC_FOLDER_ID=... ./infra/create-timer.sh
```

Настроить API Gateway по `infra/api-gateway.yaml` и привязать к функции бота.

## GitHub Secrets

| Secret | Описание |
|--------|----------|
| `YC_SA_JSON` | JSON-ключ сервисного аккаунта |
| `YC_FOLDER_ID` | ID каталога Yandex Cloud |
| `YC_BUCKET` | Bucket Object Storage для статики Mini App |
| `YDB_ENDPOINT` | gRPC endpoint YDB |
| `YDB_DATABASE` | Путь к базе YDB |
| `BOT_TOKEN` | Токен Telegram-бота |
| `WEBHOOK_SECRET` | Случайный секрет для webhook |
| `WEBHOOK_URL` | Базовый URL API Gateway |
| `ALLOWED_CHAT_ID` | ID семейной группы |
| `MINI_APP_URL` | Публичный URL на `index.html` Mini App |
| `DEFAULT_TIMEZONE` | Опционально, по умолчанию `Europe/Moscow` |
| `ADMIN_USER_IDS` | Опционально, Telegram user id админов через запятую |

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

1. Добавь бота в семейную Telegram-группу
2. **Отключи privacy mode** в [@BotFather](https://t.me/BotFather): `/setprivacy` → Disable (иначе кэш участников не работает)
3. Напиши любое сообщение в группе — участники закэшируются
4. Открой Mini App через `/start` или кнопку меню
5. Создай правила: ежемесячные или разовые
6. Cron шлёт напоминания с `@mention` и кнопками Done/Skip

Запасные команды:

- `/list` — активные правила
- `/done <instance_id>` — отметить выполненным
- `/skip <instance_id>` — пропустить

## Smoke test

См. [docs/smoke-test.md](docs/smoke-test.md).

## Переименование облачных ресурсов

Новые конфигурации используют префикс `zvenfit-reminder-`. Ресурсы, ранее
созданные с префиксом `payments-reminder-`, автоматически не переименовываются:
перед первым production-деплоем после переименования их нужно явно создать или
мигрировать.
