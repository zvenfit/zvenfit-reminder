#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/infra/ydb/migrations"
LEDGER_SCHEMA="$PROJECT_ROOT/infra/ydb/schema-migrations.sql"
YDB_ENDPOINT="${YDB_ENDPOINT:-grpc://localhost:2136}"
YDB_DATABASE="${YDB_DATABASE:-/local}"
YDB_CONTAINER="${YDB_CONTAINER:-}"
SA_KEY_FILE="${SA_KEY_FILE:-${YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS:-}}"
YDB_AUTH_ARGS=()
if [[ -n "$SA_KEY_FILE" ]]; then
  YDB_AUTH_ARGS+=(--sa-key-file "$SA_KEY_FILE")
fi

if [[ -z "$YDB_CONTAINER" ]] && command -v docker >/dev/null 2>&1; then
  YDB_CONTAINER="$(docker compose -f "$PROJECT_ROOT/docker-compose.yml" ps -q ydb 2>/dev/null || true)"
fi

if [[ -z "$YDB_CONTAINER" ]] && ! command -v ydb >/dev/null 2>&1; then
  echo "ydb CLI not found and docker compose ydb container is not running." >&2
  exit 1
fi

run_ydb() {
  if [[ -n "$YDB_CONTAINER" ]]; then
    docker exec "$YDB_CONTAINER" /ydb -e grpc://localhost:2136 -d "$YDB_DATABASE" "$@"
    return
  fi

  if [[ ${#YDB_AUTH_ARGS[@]} -gt 0 ]]; then
    ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" "${YDB_AUTH_ARGS[@]}" "$@"
    return
  fi

  ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" "$@"
}

apply_file() {
  local source_file="$1"
  if [[ -n "$YDB_CONTAINER" ]]; then
    local container_file="/tmp/$(basename "$source_file")"
    docker cp "$source_file" "$YDB_CONTAINER:$container_file"
    docker exec "$YDB_CONTAINER" /ydb -e grpc://localhost:2136 -d "$YDB_DATABASE" \
      sql -f "$container_file"
    return
  fi

  if [[ ${#YDB_AUTH_ARGS[@]} -gt 0 ]]; then
    ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" "${YDB_AUTH_ARGS[@]}" sql -f "$source_file"
    return
  fi

  ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" sql -f "$source_file"
}

checksum_file() {
  local source_file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$source_file" | awk '{print $1}'
    return
  fi
  sha256sum "$source_file" | awk '{print $1}'
}

apply_file "$LEDGER_SCHEMA"

for migration_file in "$MIGRATIONS_DIR"/*.sql; do
  migration_basename="$(basename "$migration_file")"
  if [[ ! "$migration_basename" =~ ^([0-9]{4})_([a-z0-9_-]+)\.sql$ ]]; then
    echo "Invalid migration filename: $migration_basename" >&2
    exit 1
  fi

  migration_version=$((10#${BASH_REMATCH[1]}))
  migration_name="${BASH_REMATCH[2]}"
  migration_checksum="$(checksum_file "$migration_file")"
  applied_row="$(run_ydb sql \
    -s "SELECT checksum FROM schema_migrations WHERE version = Uint32(\"$migration_version\");" \
    --format json-unicode)"

  if [[ -n "$applied_row" ]]; then
    if grep -Fq "\"checksum\":\"$migration_checksum\"" <<<"$applied_row"; then
      echo "Already applied: $migration_basename"
      continue
    fi
    echo "Checksum mismatch for applied migration: $migration_basename" >&2
    exit 1
  fi

  echo "Applying: $migration_basename"
  apply_file "$migration_file"
  run_ydb sql -s "
    UPSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (
      Uint32(\"$migration_version\"),
      Utf8(\"$migration_name\"),
      Utf8(\"$migration_checksum\"),
      CurrentUtcTimestamp()
    );
  " >/dev/null
done

echo "YDB migrations are up to date."
