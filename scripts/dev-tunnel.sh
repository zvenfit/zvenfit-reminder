#!/usr/bin/env bash
set -euo pipefail

# Start ngrok tunnel for webhook mode. Requires ngrok installed.
# Usage: WEBHOOK_SECRET=... ./scripts/dev-tunnel.sh

PORT="${PORT:-3000}"
TUNNEL_URL="${1:-}"

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Starting ngrok on port $PORT..."
  echo "After ngrok starts, run: ./scripts/dev-tunnel.sh https://xxxx.ngrok-free.app"
  exec ngrok http "$PORT"
fi

if [[ -z "${BOT_TOKEN:-}" || -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "BOT_TOKEN and WEBHOOK_SECRET must be set" >&2
  exit 1
fi

WEBHOOK_URL="${TUNNEL_URL%/}/webhook"
curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}"

echo ""
echo "Webhook set to ${WEBHOOK_URL}"
echo "Run with BOT_MODE=webhook npm run dev:bot"
