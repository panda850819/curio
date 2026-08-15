#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
IMAGE=${CURIO_IMAGE:-curio/server:5bf99fe}
cd "$ROOT"
restart() {
  docker compose --env-file .env -f compose.yaml start curio >/dev/null
}
trap restart EXIT
docker compose --env-file .env -f compose.yaml stop --timeout 30 curio >/dev/null
docker run --rm \
  --user 0:0 \
  --volume "$ROOT/data:/data" \
  --volume "$ROOT/operations:/operations:ro" \
  --env DATABASE_PATH=/data/curio.db \
  "$IMAGE" bun run /operations/item-outbox-smoke.ts
container_uid=$(docker run --rm "$IMAGE" id -u)
container_gid=$(docker run --rm "$IMAGE" id -g)
chown -R "$container_uid:$container_gid" "$ROOT/data"
