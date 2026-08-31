#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release_values=$("$SCRIPT_DIR/release-values.sh" "$ROOT")
IFS=$'\t' read -r IMAGE manifest_image_id REVISION _ _ <<< "$release_values"
if [[ -f "$ROOT/compose.yaml" ]]; then
  compose_image=$(docker compose --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" config --images | awk 'NF { if (found) exit 2; found=1; value=$0 } END { if (found) print value }') || {
    echo "restore Compose image list is invalid" >&2
    exit 1
  }
  if [[ "$compose_image" != "$IMAGE" ]]; then
    echo "restore Compose image does not match the release target" >&2
    exit 1
  fi
fi
BACKUP=${1:-}
RESTORE_DIR="$ROOT/restore-test"
RESTORE_DB="$RESTORE_DIR/curio.db"

if [[ -z "$BACKUP" ]]; then
  BACKUP=$(find "$ROOT/backups" -maxdepth 1 -type f -name 'curio-*.db' | sort -r | head -n 1)
fi
if [[ -z "$BACKUP" || ! -f "$BACKUP" ]]; then
  echo "backup file not found" >&2
  exit 1
fi
image_id=$(docker image inspect "$IMAGE" --format '{{.Id}}')
if [[ "$image_id" != "$manifest_image_id" ]]; then
  echo "restore image ID mismatch with the release target" >&2
  exit 1
fi
image_revision=$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
if [[ "$image_revision" != "$REVISION" ]]; then
  echo "restore image revision mismatch: expected $REVISION, got $image_revision" >&2
  exit 1
fi
install -d -m 0700 "$RESTORE_DIR"
rm -f -- "$RESTORE_DB" "$RESTORE_DB-wal" "$RESTORE_DB-shm"
sqlite3 "$BACKUP" ".backup '$RESTORE_DB'"
chmod 0600 "$RESTORE_DB"
if [[ $(sqlite3 "$RESTORE_DB" 'PRAGMA integrity_check;') != ok ]]; then
  echo "restored database integrity check failed" >&2
  exit 1
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$RESTORE_DIR:/restore" \
  --env DATABASE_PATH=/restore/curio.db \
  "$IMAGE" bun run src/db/migrate.ts >/dev/null
expected_migrations=$'001_initialize.sql\n002_core_ingestion.sql\n003_subscription_health.sql\n004_subscription_scheduling.sql\n005_telegram_delivery.sql\n006_routes.sql\n007_telegram_bot.sql\n008_item_enrichments.sql\n009_reader_state_quotes.sql
010_reader_visibility.sql'
applied_migrations=$(sqlite3 "$RESTORE_DB" 'SELECT name FROM schema_migrations ORDER BY version;')
if [[ "$applied_migrations" != "$expected_migrations" ]]; then
  echo "restored migration set does not match release $REVISION" >&2
  exit 1
fi
printf 'restore_rehearsal_ok %s\n' "$RESTORE_DB"
