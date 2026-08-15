#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
IMAGE=${CURIO_IMAGE:-curio/server:5bf99fe}
cd "$ROOT"

echo '--- compose ---'
docker compose --env-file .env -f compose.yaml ps
echo '--- image revision ---'
docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
echo '--- private health ---'
docker run --rm --network personal-infra_private "$IMAGE" \
  bun -e "const r=await fetch('http://curio:3000/health');console.log(await r.text());if(!r.ok)process.exit(1)"
echo '--- database ---'
sqlite3 "$ROOT/data/curio.db" <<'SQL'
SELECT 'integrity', * FROM pragma_integrity_check;
SELECT 'migrations', count(*) FROM schema_migrations;
SELECT 'subscriptions', count(*) FROM subscriptions WHERE deleted_at IS NULL;
SELECT 'deliveries_pending', count(*) FROM deliveries WHERE status IN ('pending','retry_scheduled','processing');
SELECT 'deliveries_uncertain', count(*) FROM deliveries WHERE status = 'uncertain';
SELECT 'deliveries_permanent', count(*) FROM deliveries WHERE status = 'permanent_failure';
SQL
echo '--- disk ---'
df -h "$ROOT"
echo '--- recent structured errors ---'
docker compose --env-file .env -f compose.yaml logs --since 24h --no-color curio 2>&1 \
  | grep '"level":"error"' \
  | tail -n 50 \
  || true
