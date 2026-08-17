#!/usr/bin/env bash
set -euo pipefail

base_url=${CURIO_WEBHOOK_BASE_URL:-http://127.0.0.1:3000}
secret=${TELEGRAM_WEBHOOK_SECRET:?TELEGRAM_WEBHOOK_SECRET is required}
endpoint="${base_url%/}/telegram/webhook"

status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request GET "$endpoint")
[[ "$status" == "405" ]] || { echo "expected GET 405, received $status" >&2; exit 1; }

status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --header 'x-telegram-bot-api-secret-token: invalid' \
  --data '{}' "$endpoint")
[[ "$status" == "401" ]] || { echo "expected invalid-secret 401, received $status" >&2; exit 1; }

update='{"update_id":990000001,"message":{"message_id":1,"from":{"id":0},"chat":{"id":0,"type":"private"},"text":"/start"}}'
status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --header "x-telegram-bot-api-secret-token: $secret" \
  --data "$update" "$endpoint")
[[ "$status" == "200" ]] || { echo "expected valid webhook 200, received $status" >&2; exit 1; }

echo "telegram_webhook_smoke_ok"
