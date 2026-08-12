#!/usr/bin/env bash
# Первичная настройка Yandex Cloud. Нужны: yc CLI, авторизованный пользователь.
# Использование: YC_FOLDER_ID=b1g... ./infra/setup.sh

set -euo pipefail

: "${YC_FOLDER_ID:?Укажи YC_FOLDER_ID}"

SA_NAME="zvenfit-reminder-sa"
BUCKET_NAME="${BUCKET_NAME:-zvenfit-reminder-$(openssl rand -hex 4)}"
YDB_NAME="zvenfit-reminder"
BOT_FN="zvenfit-reminder-bot"
CRON_FN="zvenfit-reminder-cron"
APIGW_NAME="zvenfit-reminder-api"

echo "==> Создаём сервисный аккаунт..."
yc iam service-account create --name "$SA_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
SA_ID=$(yc iam service-account get --name "$SA_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)

for ROLE in serverless.functions.admin storage.admin ydb.editor editor; do
  yc resource-manager folder add-access-binding "$YC_FOLDER_ID" \
    --role "$ROLE" --subject "serviceAccount:$SA_ID" 2>/dev/null || true
done

echo "==> Создаём YDB Serverless..."
yc ydb database create --serverless --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
YDB_ID=$(yc ydb database get --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
YDB_ENDPOINT=$(yc ydb database get --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .document_api_endpoint | sed 's|https://|grpcs://|' | sed 's|:443||'):2135
YDB_DATABASE=$(yc ydb database get --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .document_api_endpoint | sed 's|https://ydb.serverless.yandexcloud.net:443||')

echo "==> Создаём bucket Object Storage..."
yc storage bucket create --name "$BUCKET_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc storage bucket update --name "$BUCKET_NAME" --website-settings '{"index":"index.html","error":"index.html"}' 2>/dev/null || true

echo "==> Создаём Cloud Functions..."
yc serverless function create --name "$BOT_FN" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc serverless function create --name "$CRON_FN" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true

echo "==> Создаём API Gateway..."
BOT_FN_ID=$(yc serverless function get --name "$BOT_FN" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
APIGW_SPEC=$(sed "s/\${BOT_FUNCTION_ID}/$BOT_FN_ID/g; s/\${SA_ID}/$SA_ID/g" infra/api-gateway.yaml)
yc serverless api-gateway create --name "$APIGW_NAME" --folder-id "$YC_FOLDER_ID" \
  --spec "$APIGW_SPEC" 2>/dev/null || \
yc serverless api-gateway update --name "$APIGW_NAME" --folder-id "$YC_FOLDER_ID" \
  --spec "$APIGW_SPEC" 2>/dev/null || true

echo ""
echo "=== Настройка завершена ==="
echo "SA_ID=$SA_ID"
echo "YDB_ENDPOINT=$YDB_ENDPOINT"
echo "YDB_DATABASE=$YDB_DATABASE"
echo "BUCKET_NAME=$BUCKET_NAME"
echo ""
echo "Дальше:"
echo "1. Ключ SA: yc iam key create --service-account-id $SA_ID -o key.json"
echo "2. Добавь GitHub Secrets (см. README.md)"
echo "3. Схема: ydb -e $YDB_ENDPOINT -d $YDB_DATABASE sql -f infra/ydb/schema.sql"
echo "4. Миграции: YDB_ENDPOINT=$YDB_ENDPOINT YDB_DATABASE=$YDB_DATABASE ./scripts/apply-ydb-migrations.sh"
echo "5. Push в main для деплоя"
