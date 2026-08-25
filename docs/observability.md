# Наблюдаемость и расследование инцидентов

## Хранение

- Yandex Cloud Functions и API Gateway пишут в custom log group
  `zvenfit-reminder` с retention 30 дней.
- Cloudflare Worker хранит только явно записанные приложением структурированные
  события. Автоматические invocation logs отключены, потому что они могут
  индексировать закрытые request headers. Retention Workers Logs ограничен
  возможностями Cloudflare; основная долговременная история находится в Yandex
  Cloud Logging и YDB audit/delivery tables.
- `audit_events` отвечает за бизнес-действия, а `notification_deliveries` — за
  фактические попытки отправки. Они не заменяют execution logs и проверяются
  вместе с ними.

## Безопасный формат

Все production-события однострочные и содержат машинные поля:

- `event`: `api_request`, `telegram_webhook`, `runtime_health`,
  `cron_dispatch`, `worker_request` или `worker_dependency_error`;
- `request_id`: корреляция внутри запроса и на маршруте Worker → bot-function;
- `route`: нормализованный маршрут без occurrence/reminder/user ID;
- `status_code`, `duration_ms`, `error_code` и счётчики конкретного процесса.

Запрещено добавлять в execution logs сырые headers, request/response body,
Telegram init data, bot/proxy/webhook tokens, service-account JSON, тексты
личных напоминаний и Telegram chat/user/message IDs. Неизвестная ошибка
записывается как тип и стабильный код; для YDB сохраняется числовой issue code,
но не SQL и не исходный текст исключения.

## Cron summary

Каждый запуск dispatcher создаёт ровно одно итоговое событие `cron_dispatch`:

- `workspaces`, `materialized`, `reserved`, `sent`;
- `failed`, `unknown`, `skipped`;
- `completion_finalized`, `messages_synced`;
- `error_count`, `error_codes`, `duration_ms`.

Если есть `failed`, `unknown` или непустой `errors`, событие имеет уровень
`ERROR`, а response cron-функции — `500`. Полное падение до получения stats
пишется с уровнем `FATAL` и пробрасывается в runtime.

## Минимальный сценарий расследования

1. Зафиксировать время, endpoint и `X-Request-Id` из ответа Mini App.
2. Найти `api_request` по `request_id`; проверить `route`, `status_code`,
   `duration_ms` и `error_code`.
3. Для Telegram webhook найти такой же `request_id` в Cloudflare
   `worker_request` и Yandex `telegram_webhook`.
4. Для уведомления найти ближайший `cron_dispatch`, затем проверить
   `notification_deliveries` по status и `error_code` и соответствующие
   `audit_events`.
5. Проверить инварианты: нет delivery locks, `message_sync_required = false`,
   завершённые occurrence финализированы после undo window.

## Алерты

В Yandex Monitoring должны быть заведены:

1. API Gateway/function `5xx > 0` за 5 минут — Alarm.
2. Отсутствие cron invocation более 12 минут — Alarm.
3. `cron_dispatch` с уровнем ERROR/FATAL — Alarm через Cloud Logging trigger
   или выбранный log-processing канал.
4. Function duration p95 выше 10 секунд за 15 минут — Warning.

Канал уведомлений выбирается владельцем облака в Monitoring: email, Telegram,
push, SMS или отдельная Cloud Function. Получатель не хранится в репозитории.

## Доступ CI

Deploy service account должен иметь `logging.editor` на custom log group.
`infra/setup.sh` выдаёт этот доступ при первичной настройке. Для уже созданной
группы binding проверяется отдельно до первого push в `main`, иначе production
workflow остановится на шаге `Resolve production log group`, не начав деплой.

## Проверки после деплоя

- `/health/runtime` должен вернуть `200`, `ok: true` и список выполненных probes;
- `GET /api/history` должен вернуть `200`, даже если история пуста;
- в новых Cloudflare telemetry keys не должны появляться автоматически
  захваченные secret-bearing headers;
- в log group `zvenfit-reminder` должны появиться `runtime_health`,
  `api_request` и следующий `cron_dispatch`.
