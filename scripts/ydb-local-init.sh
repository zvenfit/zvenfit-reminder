#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="$ROOT/infra/ydb/schema.sql"
YDB_ENDPOINT="${YDB_ENDPOINT:-grpc://localhost:2136}"
YDB_DATABASE="${YDB_DATABASE:-/local}"

run_ydb() {
  if [[ -n "${YDB_CONTAINER:-}" ]]; then
    docker exec "$YDB_CONTAINER" /ydb -e grpc://localhost:2136 -d "$YDB_DATABASE" "$@"
    return
  fi

  ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" "$@"
}

apply_schema() {
  if [[ -n "${YDB_CONTAINER:-}" ]]; then
    docker cp "$SCHEMA_FILE" "$YDB_CONTAINER:/tmp/schema.sql"
    docker exec "$YDB_CONTAINER" /ydb -e grpc://localhost:2136 -d "$YDB_DATABASE" sql -f /tmp/schema.sql
    return
  fi

  ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" sql -f "$SCHEMA_FILE"
}

YDB_CONTAINER=""
if command -v docker >/dev/null 2>&1; then
  YDB_CONTAINER="$(docker compose -f "$ROOT/docker-compose.yml" ps -q ydb 2>/dev/null || true)"
fi

if [[ -n "$YDB_CONTAINER" ]]; then
  echo "Using YDB in Docker container $YDB_CONTAINER"
elif command -v ydb >/dev/null 2>&1; then
  echo "Using host ydb CLI at $YDB_ENDPOINT"
else
  echo "ydb CLI not found and docker compose ydb container is not running." >&2
  echo "Start YDB: docker compose up -d" >&2
  echo "Or install CLI: curl -sSL https://install.ydb.tech/cli | bash" >&2
  exit 1
fi

echo "Waiting for YDB..."
ready=0
for i in $(seq 1 30); do
  if run_ydb scheme ls >/dev/null 2>&1; then
    ready=1
    break
  fi
  echo "  attempt $i/30..."
  sleep 2
done

if [[ "$ready" -eq 0 ]]; then
  echo "YDB is not reachable at $YDB_ENDPOINT" >&2
  exit 1
fi

apply_schema
echo "Schema applied to $YDB_DATABASE"
run_ydb scheme ls
