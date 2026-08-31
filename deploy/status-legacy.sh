#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
NETWORK=${CURIO_NETWORK:-personal-infra_private}
# The manifest is accepted at rollback-image build time; never derive its ID
# from the mutable rollback tag during verification.
MANIFEST=${CURIO_LEGACY_MANIFEST:-$ROOT/legacy-release-manifest.env}
LEGACY_REVISION=94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa
LEGACY_IMAGE=curio/server:rollback-94ee0ff
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ -n "${CURIO_LEGACY_IMAGE:-}" && "$CURIO_LEGACY_IMAGE" != "$LEGACY_IMAGE" ]]; then
  echo "status-legacy: CURIO_LEGACY_IMAGE is not the accepted rollback image" >&2
  exit 1
fi
if [[ -n "${CURIO_IMAGE:-}" && "$CURIO_IMAGE" != "$LEGACY_IMAGE" ]]; then
  echo "status-legacy: CURIO_IMAGE is not the accepted rollback image" >&2
  exit 1
fi
if [[ -n "${CURIO_REVISION:-}" && "$CURIO_REVISION" != "$LEGACY_REVISION" ]]; then
  echo "status-legacy: CURIO_REVISION is not the accepted rollback revision" >&2
  exit 1
fi
if [[ -n "${CURIO_HEALTH_CONTRACT:-}" && "$CURIO_HEALTH_CONTRACT" != "legacy-v0" ]]; then
  echo "status-legacy: CURIO_HEALTH_CONTRACT is not the accepted legacy contract" >&2
  exit 1
fi

cd "$ROOT"
legacy_values=$(CURIO_LEGACY_MANIFEST="$MANIFEST" "$SCRIPT_DIR/legacy-release-values.sh" "$ROOT") || {
  echo "status-legacy: accepted rollback manifest is invalid" >&2
  exit 1
}
IFS=$'\t' read -r manifest_image manifest_image_id manifest_revision manifest_contract <<< "$legacy_values"

echo '--- compose ---'
docker compose --env-file .env -f compose.yaml ps
compose_image=$(docker compose --env-file .env -f compose.yaml config --images | awk 'NF { if (found) exit 2; found=1; value=$0 } END { if (found) print value }') || {
  echo "status-legacy: Compose image list is invalid" >&2
  exit 1
}
[[ "$compose_image" == "$LEGACY_IMAGE" ]] || {
  echo "status-legacy: Compose image is not the accepted rollback image" >&2
  exit 1
}

container_id=$(docker compose --env-file .env -f compose.yaml ps -q curio)
[[ "$container_id" =~ ^[A-Za-z0-9]+$ ]] || {
  echo "status-legacy: Curio container is not running under Compose" >&2
  exit 1
}
runtime_image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
[[ "$runtime_image" == "$LEGACY_IMAGE" ]] || {
  echo "status-legacy: running container image is not the accepted rollback image" >&2
  exit 1
}
image_id=$(docker image inspect "$LEGACY_IMAGE" --format '{{.Id}}')
[[ "$image_id" == "$manifest_image_id" ]] || {
  echo "status-legacy: local rollback image ID does not match the accepted manifest" >&2
  exit 1
}
runtime_image_id=$(docker inspect --format '{{.Image}}' "$container_id")
[[ "$runtime_image_id" == "$manifest_image_id" ]] || {
  echo "status-legacy: running container image ID does not match the accepted manifest" >&2
  exit 1
}
runtime_state=$(docker inspect --format '{{.State.Status}}' "$container_id")
[[ "$runtime_state" == "running" ]] || {
  echo "status-legacy: Curio container is not running" >&2
  exit 1
}
runtime_contract=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | awk -F= '$1 == "CURIO_HEALTH_CONTRACT" { print substr($0, index($0, "=") + 1) }')
[[ "$runtime_contract" == "legacy-v0" ]] || {
  echo "status-legacy: running container is not configured for the legacy contract" >&2
  exit 1
}
runtime_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}}' "$container_id")
[[ "$runtime_health" == "healthy" ]] || {
  echo "status-legacy: Curio Docker health is $runtime_health" >&2
  exit 1
}

image_revision=$(docker image inspect "$LEGACY_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
runtime_revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id")
[[ "$image_revision" == "$LEGACY_REVISION" ]] || {
  echo "status-legacy: rollback image revision does not match the accepted artifact" >&2
  exit 1
}
[[ "$runtime_revision" == "$LEGACY_REVISION" ]] || {
  echo "status-legacy: running container revision does not match the accepted artifact" >&2
  exit 1
}

echo '--- bounded legacy health ---'
docker run --rm --network "$NETWORK" "$LEGACY_IMAGE" bun -e '
let response;
try {
  response = await fetch("http://curio:3000/health", { signal: AbortSignal.timeout(5_000) });
} catch {
  throw new Error("legacy /health request failed");
}
let body;
try {
  body = await response.json();
} catch {
  throw new Error("legacy /health returned malformed JSON");
}
if (!response.ok || body.status !== "ok" || body.service !== "curio") {
  throw new Error("legacy /health check failed");
}
console.log(JSON.stringify({ status: "ok", service: body.service, contract: "legacy-v0" }));
'

echo '--- database integrity ---'
integrity=$(sqlite3 "$ROOT/data/curio.db" 'PRAGMA integrity_check;')
[[ "$integrity" == "ok" ]] || {
  echo "status-legacy: database integrity check failed" >&2
  exit 1
}
printf 'status-legacy: ok revision=%s database=ok\n' "$LEGACY_REVISION"
