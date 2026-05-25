#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="$ROOT/sa-key.json"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${YC_SA_JSON:-}" ]]; then
  echo "YC_SA_JSON is not set in .env" >&2
  exit 1
fi

printf '%s' "$YC_SA_JSON" > "$KEY_FILE"
echo "Wrote $KEY_FILE"
echo "Add to .env: YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=$KEY_FILE"
