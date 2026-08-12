#!/usr/bin/env bash
# Cloud Timer для reminder-cron (каждые 5 минут).
# Использование: SA_ID=... YC_FOLDER_ID=... ./infra/create-timer.sh

set -euo pipefail

: "${SA_ID:?Укажи SA_ID}"
: "${YC_FOLDER_ID:?Укажи YC_FOLDER_ID}"

TRIGGER_NAME="zvenfit-reminder-every-5m"
CRON_FN="zvenfit-reminder-cron"

yc serverless trigger create timer \
  --name "$TRIGGER_NAME" \
  --folder-id "$YC_FOLDER_ID" \
  --cron-expression '*/5 * * * ? *' \
  --invoke-function-name "$CRON_FN" \
  --invoke-function-service-account-id "$SA_ID" \
  2>/dev/null || \
yc serverless trigger update timer "$TRIGGER_NAME" \
  --folder-id "$YC_FOLDER_ID" \
  --cron-expression '*/5 * * * ? *' \
  --invoke-function-name "$CRON_FN" \
  --invoke-function-service-account-id "$SA_ID"

echo "Timer trigger настроен: $TRIGGER_NAME"
