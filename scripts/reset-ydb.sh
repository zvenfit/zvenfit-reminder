#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ENDPOINT="${YDB_ENDPOINT:?Set YDB_ENDPOINT to the exact database endpoint}"
TARGET_DATABASE="${YDB_DATABASE:?Set YDB_DATABASE to the exact database path}"
CONFIRMED_DATABASE="${CONFIRM_YDB_DATABASE:-}"
CONFIRMED_ENDPOINT="${CONFIRM_YDB_ENDPOINT:-}"
SA_KEY_FILE="${YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS:-}"

if [[ "$TARGET_DATABASE" == "/" || -z "$TARGET_DATABASE" ]]; then
  echo "Refusing to reset a broad database path: $TARGET_DATABASE" >&2
  exit 1
fi

if [[ "$CONFIRMED_DATABASE" != "$TARGET_DATABASE" ]]; then
  echo "Refusing to reset YDB." >&2
  echo "Set CONFIRM_YDB_DATABASE to the exact value of YDB_DATABASE:" >&2
  echo "  $TARGET_DATABASE" >&2
  exit 1
fi

if [[ "$CONFIRMED_ENDPOINT" != "$TARGET_ENDPOINT" ]]; then
  echo "Refusing to reset YDB." >&2
  echo "Set CONFIRM_YDB_ENDPOINT to the exact value of YDB_ENDPOINT:" >&2
  echo "  $TARGET_ENDPOINT" >&2
  exit 1
fi

echo "This permanently deletes every zvenfit-reminder table at:"
echo "  endpoint: $TARGET_ENDPOINT"
echo "  database: $TARGET_DATABASE"
read -r -p "Type RESET to continue: " RESET_ANSWER
if [[ "$RESET_ANSWER" != "RESET" ]]; then
  echo "Reset cancelled."
  exit 1
fi

YDB_ARGS=(-e "$TARGET_ENDPOINT" -d "$TARGET_DATABASE")
if [[ -n "$SA_KEY_FILE" ]]; then
  YDB_ARGS+=(--sa-key-file "$SA_KEY_FILE")
fi

TABLES=(
  calendar_feed_tokens
  audit_events
  notification_deliveries
  reminder_occurrence_slots
  reminder_occurrences
  reminder_runtime
  reminder_watchers
  reminders
  workspace_members
  users
  telegram_chat_workspaces
  workspaces
  group_members
  reminder_instances
  rules
  schema_migrations
)

for table in "${TABLES[@]}"; do
  if ydb "${YDB_ARGS[@]}" scheme describe "$table" >/dev/null 2>&1; then
    echo "Dropping table: $table"
    ydb "${YDB_ARGS[@]}" table drop "$table"
  fi
done

YDB_ENDPOINT="$TARGET_ENDPOINT" \
YDB_DATABASE="$TARGET_DATABASE" \
SA_KEY_FILE="$SA_KEY_FILE" \
  "$PROJECT_ROOT/scripts/apply-ydb-migrations.sh"

echo "YDB reset complete. Only the current multi-workspace schema is installed."
