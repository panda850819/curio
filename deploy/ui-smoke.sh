#!/usr/bin/env bash
set -euo pipefail

base_url=${CURIO_UI_BASE_URL:-http://127.0.0.1:3000}
cookie_file=$(mktemp)
trap 'rm -f "$cookie_file"' EXIT
for path in / /subscriptions /subscriptions/new /destinations /deliveries; do
  body=$(curl --silent --show-error --fail --cookie-jar "$cookie_file" \
    --cookie "$cookie_file" "${base_url%/}${path}")
  grep -q 'id="main-content"' <<<"$body"
  grep -q 'Curio' <<<"$body"
done

echo "curio_ui_smoke_ok"
