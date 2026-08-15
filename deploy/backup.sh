#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
KIND=${1:-daily}
DATABASE="$ROOT/data/curio.db"
BACKUP_DIR="$ROOT/backups"

if [[ ! -f "$DATABASE" ]]; then
  echo "database does not exist: $DATABASE" >&2
  exit 1
fi
install -d -m 0700 "$BACKUP_DIR"
timestamp=${CURIO_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
backup="$BACKUP_DIR/curio-${KIND}-${timestamp}.db"
sqlite3 "$DATABASE" ".backup '$backup'"
chmod 0600 "$backup"
result=$(sqlite3 "$backup" 'PRAGMA integrity_check;')
if [[ "$result" != ok ]]; then
  echo "backup integrity check failed" >&2
  exit 1
fi

if [[ "$KIND" == daily ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'curio-daily-*.db' \
    | sort -r \
    | tail -n +15 \
    | while IFS= read -r expired; do
        [[ -n "$expired" ]] && rm -- "$expired"
      done
fi
printf 'backup_ok %s\n' "$backup"
