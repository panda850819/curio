#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
REVISION=${CURIO_REVISION:-1164c3fce0d03b531f0592a76b79d787e2f1a008}
IMAGE=${CURIO_IMAGE:-curio/server:1164c3f}
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
