#!/usr/bin/env bash
# Cloud Timer для reminder-cron (каждые 5 минут).
# Использование: SA_ID=... YC_FOLDER_ID=... ./infra/create-timer.sh

set -euo pipefail

: "${SA_ID:?Укажи SA_ID}"
: "${YC_FOLDER_ID:?Укажи YC_FOLDER_ID}"

TRIGGER_NAME="zvenfit-reminder-every-5m"
CRON_FN="zvenfit-reminder-cron"

if ! yc serverless trigger create timer \
  --name "$TRIGGER_NAME" \
  --folder-id "$YC_FOLDER_ID" \
  --cron-expression '*/5 * * * ? *' \
  --invoke-function-name "$CRON_FN" \
  --invoke-function-service-account-id "$SA_ID" \
  2>/dev/null; then
  TRIGGER_ID=$(yc serverless trigger get \
    --name "$TRIGGER_NAME" \
    --folder-id "$YC_FOLDER_ID" \
    --format json | jq -r .id)
  yc serverless trigger update timer \
    --id "$TRIGGER_ID" \
    --new-cron-expression '*/5 * * * ? *' \
    --new-invoke-function-name "$CRON_FN" \
    --new-invoke-function-service-account-id "$SA_ID"
fi

echo "Timer trigger настроен: $TRIGGER_NAME"
