#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
DATABASE="$ROOT/data/curio.db"
marker="deployment-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
route_id="${marker}-route"
now_ms=$(( $(date +%s) * 1000 ))
source_url="https://example.com/${marker}.xml"

cleanup() {
  [[ -f "$DATABASE" ]] || return 0
  local cleanup_ms
  cleanup_ms=$(( $(date +%s) * 1000 ))
  sqlite3 "$DATABASE" "
    DELETE FROM routes WHERE id = '$route_id';
    UPDATE subscriptions
      SET enabled = 0, deleted_at = COALESCE(deleted_at, $cleanup_ms), updated_at = $cleanup_ms
      WHERE id = '$marker';
    UPDATE deliveries
      SET status = 'permanent_failure', next_attempt_at = NULL,
          last_error = 'Deployment smoke cleanup', updated_at = $cleanup_ms
      WHERE failure_event_id IN (
        SELECT id FROM poll_failure_events WHERE subscription_id = '$marker'
      ) AND status NOT IN ('delivered', 'uncertain', 'permanent_failure');
  " >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$ROOT"
destination_id=$(sqlite3 "$DATABASE" "
  SELECT id FROM destinations
  WHERE kind = 'telegram' AND enabled = 1
  ORDER BY id LIMIT 1;")
if [[ -z "$destination_id" ]]; then
  echo "an enabled Telegram destination is required for the failure smoke" >&2
  exit 1
fi

sqlite3 "$DATABASE" <<SQL
INSERT INTO subscriptions (
  id, adapter, source_key, source_url, title, enabled, metadata_json,
  next_poll_at, poll_interval_minutes, created_at, updated_at
) VALUES (
  '$marker', 'rss', '$marker', '$source_url', 'Curio deployment smoke', 1, '{}',
  9999999999999, 60, $now_ms, $now_ms
);
INSERT INTO routes (
  id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
) VALUES (
  '$route_id', '$marker', '$destination_id', 1, '{}', $now_ms, $now_ms
);
SQL

set +e
docker compose --env-file .env -f compose.yaml exec -T curio \
  bun run src/cli.ts poll "$marker" --json >/dev/null 2>&1
poll_status=$?
set -e
if [[ $poll_status -eq 0 ]]; then
  echo "controlled failure unexpectedly succeeded" >&2
  exit 1
fi

message_id=""
for _ in $(seq 1 60); do
  message_id=$(sqlite3 "$DATABASE" "
    SELECT d.telegram_message_id
    FROM deliveries d
    JOIN poll_failure_events e ON e.id = d.failure_event_id
    WHERE e.subscription_id = '$marker' AND d.status = 'delivered'
    ORDER BY d.delivered_at DESC LIMIT 1;")
  [[ -n "$message_id" ]] && break
  sleep 1
done
if [[ -z "$message_id" ]]; then
  echo "Telegram failure smoke was not acknowledged within 60 seconds" >&2
  exit 1
fi
counts=$(sqlite3 "$DATABASE" "
  SELECT
    (SELECT count(*) FROM poll_failure_events WHERE subscription_id = '$marker'),
    (SELECT count(*) FROM deliveries d JOIN poll_failure_events e ON e.id = d.failure_event_id
      WHERE e.subscription_id = '$marker');")
if [[ "$counts" != "1|1" ]]; then
  echo "expected one failure event and one delivery, received $counts" >&2
  exit 1
fi
printf 'telegram_failure_smoke_ok message_id=%s\n' "$message_id"
