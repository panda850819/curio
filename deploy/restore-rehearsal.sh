#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
IMAGE=${CURIO_IMAGE:-curio/server:5bf99fe}
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
migration_count=$(sqlite3 "$RESTORE_DB" 'SELECT count(*) FROM schema_migrations;')
if [[ "$migration_count" != 5 ]]; then
  echo "restored migration count mismatch: $migration_count" >&2
  exit 1
fi
printf 'restore_rehearsal_ok %s\n' "$RESTORE_DB"
