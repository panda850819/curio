#!/usr/bin/env bash
set -euo pipefail

ROOT=${CURIO_ROOT:-/opt/curio}
NETWORK=${CURIO_NETWORK:-personal-infra_private}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"

fail() {
  echo "status: $1" >&2
  exit 1
}

release_values=$("$SCRIPT_DIR/release-values.sh" "$ROOT") || fail "release target manifest is invalid"
IFS=$'\t' read -r manifest_image manifest_image_id manifest_revision manifest_build_time manifest_contract <<< "$release_values"
IMAGE=$manifest_image
expected_revision=$manifest_revision
expected_build_time=$manifest_build_time

printf 'release manifest: image=%s revision=%s contract=%s\n' \
  "$IMAGE" "$expected_revision" "$manifest_contract"

echo '--- compose ---'
docker compose --env-file .env -f compose.yaml ps
compose_image=$(docker compose --env-file .env -f compose.yaml config --images | awk 'NF { if (found) exit 2; found=1; value=$0 } END { if (found) print value }') \
  || fail "Compose image list is invalid"
[[ "$compose_image" == "$IMAGE" ]] || fail "Compose image does not match the release target manifest"

container_id=$(docker compose --env-file .env -f compose.yaml ps -q curio)
[[ "$container_id" =~ ^[A-Za-z0-9]+$ ]] || fail "Curio container is not running under Compose"
runtime_image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
runtime_image_id=$(docker inspect --format '{{.Image}}' "$container_id")
[[ "$runtime_image" == "$IMAGE" ]] || fail "running container image does not match the release target manifest"
[[ "$runtime_image_id" == "$manifest_image_id" ]] || fail "running container image ID does not match the release target manifest"
runtime_state=$(docker inspect --format '{{.State.Status}}' "$container_id")
[[ "$runtime_state" == "running" ]] || fail "Curio container is not running"
runtime_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}}' "$container_id")
[[ "$runtime_health" == "healthy" ]] || fail "Curio Docker health is $runtime_health"
runtime_contract=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | awk -F= '$1 == "CURIO_HEALTH_CONTRACT" { print substr($0, index($0, "=") + 1) }')
[[ "$runtime_contract" == "$manifest_contract" ]] || fail "running container health contract does not match the release target manifest"

image_id=$(docker image inspect "$IMAGE" --format '{{.Id}}')
image_revision=$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
image_created=$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.created" }}')
image_metadata_revision=$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "com.panda.personal-infra.revision" }}')
[[ "$image_id" == "$manifest_image_id" ]] || fail "image ID does not match the release target manifest"
[[ "$image_revision" == "$expected_revision" ]] || fail "image revision does not match the release target manifest"
[[ "$image_created" == "$expected_build_time" ]] || fail "image build time does not match the release target manifest"
[[ "$image_metadata_revision" == "$expected_revision" ]] || fail "image metadata revision does not match the release target manifest"

runtime_revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id")
runtime_created=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.created" }}' "$container_id")
runtime_metadata_revision=$(docker inspect --format '{{ index .Config.Labels "com.panda.personal-infra.revision" }}' "$container_id")
runtime_service=$(docker inspect --format '{{ index .Config.Labels "com.panda.personal-infra.service" }}' "$container_id")
runtime_healthz=$(docker inspect --format '{{ index .Config.Labels "com.panda.personal-infra.healthz" }}' "$container_id")
runtime_readyz=$(docker inspect --format '{{ index .Config.Labels "com.panda.personal-infra.readyz" }}' "$container_id")
runtime_version=$(docker inspect --format '{{ index .Config.Labels "com.panda.personal-infra.version" }}' "$container_id")
[[ "$runtime_revision" == "$expected_revision" ]] || fail "running container revision does not match the release target manifest"
[[ "$runtime_created" == "$expected_build_time" ]] || fail "running container build time does not match the release target manifest"
[[ "$runtime_metadata_revision" == "$expected_revision" ]] || fail "running container metadata revision does not match the release target manifest"
[[ "$runtime_service" == "curio" ]] || fail "running container service label is invalid"
[[ "$runtime_healthz" == "http://curio:3000/healthz" ]] || fail "running container health label is invalid"
[[ "$runtime_readyz" == "http://curio:3000/readyz" ]] || fail "running container readiness label is invalid"
[[ "$runtime_version" == "http://curio:3000/version" ]] || fail "running container version label is invalid"

printf '%s\n' "$expected_revision"
echo '--- private health contract ---'
docker run --rm --network "$NETWORK" \
  -e "EXPECTED_REVISION=$expected_revision" \
  -e "EXPECTED_BUILD_TIME=$expected_build_time" \
  "$IMAGE" bun -e '
const expectedRevision = process.env.EXPECTED_REVISION;
const expectedBuildTime = process.env.EXPECTED_BUILD_TIME;
async function get(path) {
  let response;
  try {
    response = await fetch(`http://curio:3000${path}`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`${path} request failed`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned malformed JSON`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return body;
}
const liveness = await get("/healthz");
if (liveness.status !== "ok" || liveness.service !== "curio") {
  throw new Error("Curio liveness check failed");
}
const readiness = await get("/readyz");
if (readiness.status !== "ok" || readiness.service !== "curio") {
  throw new Error("Curio readiness check failed");
}
const version = await get("/version");
if (
  version.service !== "curio" ||
  version.revision !== expectedRevision ||
  version.buildTime !== expectedBuildTime ||
  !Number.isSafeInteger(version.schemaVersion) ||
  version.schemaVersion < 0
) {
  throw new Error("Curio version identity does not match the release target manifest");
}
if (
  readiness.status !== "ok" ||
  readiness.service !== "curio" ||
  readiness.checks?.database !== "ok" ||
  readiness.checks?.migrations !== "ok"
) {
  throw new Error("Curio readiness checks are not healthy");
}
console.log(JSON.stringify({
  status: "ok",
  service: version.service,
  revision: version.revision,
  buildTime: version.buildTime,
  schemaVersion: version.schemaVersion,
}));
'
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
