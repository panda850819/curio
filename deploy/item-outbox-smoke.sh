#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release_values=$("$SCRIPT_DIR/release-values.sh" "$ROOT")
IFS=$'\t' read -r IMAGE manifest_image_id _ _ _ <<< "$release_values"
cd "$ROOT"
compose_image=$(docker compose --env-file .env -f compose.yaml config --images | awk 'NF { if (found) exit 2; found=1; value=$0 } END { if (found) print value }') || {
  echo "item outbox Compose image list is invalid" >&2
  exit 1
}
if [[ "$compose_image" != "$IMAGE" ]]; then
  echo "item outbox Compose image does not match the release target" >&2
  exit 1
fi
image_id=$(docker image inspect "$IMAGE" --format '{{.Id}}')
if [[ "$image_id" != "$manifest_image_id" ]]; then
  echo "item outbox image ID mismatch with the release target" >&2
  exit 1
fi
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
