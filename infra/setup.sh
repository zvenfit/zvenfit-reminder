#!/usr/bin/env bash
# Первичная настройка Yandex Cloud. Нужны: yc CLI, авторизованный пользователь.
# Использование: YC_FOLDER_ID=b1g... ./infra/setup.sh

set -euo pipefail

: "${YC_FOLDER_ID:?Укажи YC_FOLDER_ID}"

RUNTIME_SA_NAME="zvenfit-reminder-runtime-sa"
INVOKER_SA_NAME="zvenfit-reminder-invoker-sa"
DEPLOY_SA_NAME="zvenfit-reminder-deploy-sa"
BUCKET_NAME="${BUCKET_NAME:-zvenfit-reminder-$(openssl rand -hex 4)}"
YDB_NAME="zvenfit-reminder"
BOT_FN="zvenfit-reminder-bot"
CRON_FN="zvenfit-reminder-cron"
APIGW_NAME="zvenfit-reminder-api"
LOG_GROUP_NAME="zvenfit-reminder"
LOG_RETENTION="720h"

echo "==> Создаём runtime, invoker и deploy service accounts..."
yc iam service-account create --name "$RUNTIME_SA_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc iam service-account create --name "$INVOKER_SA_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc iam service-account create --name "$DEPLOY_SA_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
RUNTIME_SA_ID=$(yc iam service-account get --name "$RUNTIME_SA_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
INVOKER_SA_ID=$(yc iam service-account get --name "$INVOKER_SA_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
DEPLOY_SA_ID=$(yc iam service-account get --name "$DEPLOY_SA_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)

echo "==> Настраиваем production log group на 30 дней..."
if yc logging group get --name "$LOG_GROUP_NAME" --folder-id "$YC_FOLDER_ID" >/dev/null 2>&1; then
  yc logging group update --name "$LOG_GROUP_NAME" --folder-id "$YC_FOLDER_ID" \
    --retention-period "$LOG_RETENTION"
else
  yc logging group create --name "$LOG_GROUP_NAME" --folder-id "$YC_FOLDER_ID" \
    --description "ZvenFit Reminder production logs" \
    --retention-period "$LOG_RETENTION"
fi
LOG_GROUP_ID=$(yc logging group get --name "$LOG_GROUP_NAME" --folder-id "$YC_FOLDER_ID" \
  --format json | jq -r .id)
yc logging group add-access-binding --id "$LOG_GROUP_ID" \
  --service-account-id "$DEPLOY_SA_ID" --role logging.editor 2>/dev/null || true

yc iam service-account add-access-binding --id "$RUNTIME_SA_ID" \
  --role iam.serviceAccounts.user --subject "serviceAccount:$DEPLOY_SA_ID" 2>/dev/null || true

echo "==> Создаём YDB Serverless..."
yc ydb database create --serverless --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
YDB_ID=$(yc ydb database get --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
YDB_CONNECTION_STRING=$(yc ydb database get --name "$YDB_NAME" --folder-id "$YC_FOLDER_ID" --format json | jq -r .endpoint)
YDB_ENDPOINT=$(jq -nr --arg value "$YDB_CONNECTION_STRING" '$value | split("/?database=")[0]')
YDB_DATABASE=$(jq -nr --arg value "$YDB_CONNECTION_STRING" '$value | split("/?database=")[1]')
yc ydb database add-access-binding --id "$YDB_ID" \
  --service-account-id "$RUNTIME_SA_ID" --role ydb.editor 2>/dev/null || true
yc ydb database add-access-binding --id "$YDB_ID" \
  --service-account-id "$DEPLOY_SA_ID" --role ydb.editor 2>/dev/null || true

echo "==> Создаём bucket Object Storage..."
yc storage bucket create --name "$BUCKET_NAME" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc storage bucket update --name "$BUCKET_NAME" \
  --website-settings '{"index":"index.html","error":"index.html"}' \
  --grants "grantee-id=$DEPLOY_SA_ID,grant-type=grant-type-account,permission=permission-read" \
  --grants "grantee-id=$DEPLOY_SA_ID,grant-type=grant-type-account,permission=permission-write" \
  --grants "grant-type=grant-type-all-users,permission=permission-read" 2>/dev/null || true

echo "==> Создаём Cloud Functions..."
yc serverless function create --name "$BOT_FN" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
yc serverless function create --name "$CRON_FN" --folder-id "$YC_FOLDER_ID" 2>/dev/null || true
BOT_FN_ID=$(yc serverless function get --name "$BOT_FN" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
CRON_FN_ID=$(yc serverless function get --name "$CRON_FN" --folder-id "$YC_FOLDER_ID" --format json | jq -r .id)
yc serverless function add-access-binding --id "$BOT_FN_ID" \
  --service-account-id "$INVOKER_SA_ID" --role functions.functionInvoker 2>/dev/null || true
yc serverless function add-access-binding --id "$BOT_FN_ID" \
  --role functions.functionInvoker --subject "system:allUsers" 2>/dev/null || true
yc serverless function add-access-binding --id "$CRON_FN_ID" \
  --service-account-id "$INVOKER_SA_ID" --role functions.functionInvoker 2>/dev/null || true
yc serverless function add-access-binding --id "$BOT_FN_ID" \
  --service-account-id "$DEPLOY_SA_ID" --role functions.editor 2>/dev/null || true
yc serverless function add-access-binding --id "$CRON_FN_ID" \
  --service-account-id "$DEPLOY_SA_ID" --role functions.editor 2>/dev/null || true

echo "==> Создаём API Gateway..."
APIGW_SPEC=$(mktemp)
trap 'rm -f "$APIGW_SPEC"' EXIT
sed "s/\${BOT_FUNCTION_ID}/$BOT_FN_ID/g; s/\${INVOKER_SA_ID}/$INVOKER_SA_ID/g" infra/api-gateway.yaml > "$APIGW_SPEC"
if yc serverless api-gateway get --name "$APIGW_NAME" --folder-id "$YC_FOLDER_ID" >/dev/null 2>&1; then
  yc serverless api-gateway update --name "$APIGW_NAME" --folder-id "$YC_FOLDER_ID" \
    --spec "$APIGW_SPEC" --log-group-id "$LOG_GROUP_ID" --min-log-level info
else
  yc serverless api-gateway create --name "$APIGW_NAME" --folder-id "$YC_FOLDER_ID" \
    --spec "$APIGW_SPEC" --log-group-id "$LOG_GROUP_ID" --min-log-level info
fi

echo ""
echo "=== Настройка завершена ==="
echo "RUNTIME_SA_ID=$RUNTIME_SA_ID"
echo "INVOKER_SA_ID=$INVOKER_SA_ID"
echo "DEPLOY_SA_ID=$DEPLOY_SA_ID"
echo "YDB_ENDPOINT=$YDB_ENDPOINT"
echo "YDB_DATABASE=$YDB_DATABASE"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "LOG_GROUP_ID=$LOG_GROUP_ID"
echo ""
echo "Дальше:"
echo "1. Создай JSON-ключ только для deploy SA ($DEPLOY_SA_ID) и сохрани его в YC_SA_JSON."
echo "2. Не создавай статические ключи для runtime и invoker SA."
echo "3. Добавь GitHub Secrets, включая YC_RUNTIME_SERVICE_ACCOUNT_ID=$RUNTIME_SA_ID."
echo "   TELEGRAM_WEBHOOK_URL=https://functions.yandexcloud.net/$BOT_FN_ID"
echo "4. Схема: YDB_ENDPOINT=$YDB_ENDPOINT YDB_DATABASE=$YDB_DATABASE ./scripts/apply-ydb-migrations.sh"
echo "5. Timer: SA_ID=$INVOKER_SA_ID YC_FOLDER_ID=$YC_FOLDER_ID ./infra/create-timer.sh"
echo "6. Push в main для деплоя"
