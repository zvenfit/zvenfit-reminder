# Runbook очистки старого service account

Основной production переведён на раздельные `runtime`, `invoker` и `deploy`
аккаунты 14 августа 2026 года. Общий `zvenfit-reminder-sa` после проверки
production был лишён ролей и удалён вместе со старым IAM-ключом. Этот runbook
остаётся для повторного развёртывания или очистки другого окружения.

Новая схема использует отдельные аккаунты `runtime`, `invoker` и `deploy`.
Старый общий `zvenfit-reminder-sa` больше не нужен, но его права нельзя отзывать
до переключения production.

## Когда выполнять

1. `YC_SA_JSON` принадлежит `zvenfit-reminder-deploy-sa`.
2. `YC_RUNTIME_SERVICE_ACCOUNT_ID` указывает на `zvenfit-reminder-runtime-sa`.
3. Новый workflow успешно применил миграцию и обновил обе функции.
4. Webhook, Mini App и timer прошли smoke test.

## Проверка

```bash
export YC_FOLDER_ID=b1g...
LEGACY_SA_ID="$(yc iam service-account get \
  --name zvenfit-reminder-sa \
  --folder-id "$YC_FOLDER_ID" \
  --format json | jq -r .id)"
printf 'Legacy SA: %s\n' "$LEGACY_SA_ID"
yc resource-manager folder list-access-bindings --id "$YC_FOLDER_ID" \
  --format json | jq --arg id "$LEGACY_SA_ID" \
  '.[] | select(.subject.id == $id)'
```

## Отзыв старых folder-level ролей

Команды ниже намеренно не встроены в `setup.sh`: это отдельное destructive
действие после ручной проверки идентификатора.

```bash
yc resource-manager folder remove-access-binding --id "$YC_FOLDER_ID" \
  --role editor --subject "serviceAccount:$LEGACY_SA_ID"
yc resource-manager folder remove-access-binding --id "$YC_FOLDER_ID" \
  --role serverless.functions.admin --subject "serviceAccount:$LEGACY_SA_ID"
yc resource-manager folder remove-access-binding --id "$YC_FOLDER_ID" \
  --role storage.admin --subject "serviceAccount:$LEGACY_SA_ID"
yc resource-manager folder remove-access-binding --id "$YC_FOLDER_ID" \
  --role ydb.editor --subject "serviceAccount:$LEGACY_SA_ID"
```

После отзыва повтори production smoke test. Когда в audit log больше нет
обращений, точечные resource bindings также отсутствуют и rollback на старую
схему не нужен, удали аккаунт вместе с оставшимися ключами:

```bash
yc iam service-account delete --id "$LEGACY_SA_ID"
```

Удаление необратимо. Перед командой ещё раз выведи имя и ID аккаунта и убедись,
что функции, API Gateway и timer используют новые service accounts.
