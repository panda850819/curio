#!/usr/bin/env bash
set -euo pipefail

image="curio/server:smoke"
network="curio-smoke-$$"
volume="curio-smoke-$$"
container="curio-smoke-$$"

has_hidden_index_state() {
  git ls-files -v | awk '$1 ~ /^[a-zS]$/ { found = 1 } END { exit found ? 0 : 1 }'
}

has_untracked_build_input() {
  local path
  local tracked_under
  while IFS= read -r -d '' path; do
    if [[ -d "$path" && ! -L "$path" ]]; then
      [[ "$path" == src || "$path" == migrations ]] && continue
      tracked_under=$(git ls-files -- "$path/")
      [[ -n "$tracked_under" ]] || return 0
      continue
    fi
    if ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      return 0
    fi
  done < <(find src migrations -print0)
  return 1
}

append_context_entry() {
  local path=$1
  local type
  local mode
  local content_hash
  [[ -e "$path" || -L "$path" ]] || {
    echo "missing Docker build input: $path" >&2
    return 1
  }
  if [[ -L "$path" ]]; then
    type=symlink
  elif [[ -f "$path" ]]; then
    type=regular
  elif [[ -d "$path" ]]; then
    type=directory
  else
    type=other
  fi
  mode=$(stat -c '%a' -- "$path" 2>/dev/null || stat -f '%Lp' -- "$path")
  case "$type" in
    regular) content_hash=$(git hash-object -- "$path") ;;
    symlink) content_hash=$(readlink "$path" | git hash-object --stdin) ;;
    *) content_hash=- ;;
  esac
  printf 'entry\0path\0%s\0type\0%s\0mode\0%s\0content\0%s\0' \
    "$path" "$type" "$mode" "$content_hash"
}

build_context_hash() {
  local path
  {
    # Keep this input list aligned with the Dockerfile COPY instructions. It
    # deliberately walks source trees instead of asking Git so Docker-included
    # ignored files are represented too.
    printf 'base-tree\0%s\0' "$(git rev-parse HEAD^{tree})"
    for path in Dockerfile .dockerignore package.json bun.lock src migrations; do
      append_context_entry "$path"
    done
    while IFS= read -r -d '' path; do
      [[ "$path" == src || "$path" == migrations ]] && continue
      append_context_entry "$path"
    done < <(find src migrations -print0 | LC_ALL=C sort -z)
  } | git hash-object --stdin
}

if git diff --quiet HEAD -- &&
  [[ -z "$(git ls-files --others --exclude-standard)" ]] &&
  ! has_untracked_build_input &&
  ! has_hidden_index_state; then
  release_revision=$(git rev-parse HEAD)
else
  release_revision="dirty-$(build_context_hash)"
fi
build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build \
  --build-arg "CURIO_RELEASE_REVISION=$release_revision" \
  --build-arg "CURIO_BUILD_TIME=$build_time" \
  --tag "$image" .
image_revision=$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
if [[ "$image_revision" != "$release_revision" ]]; then
  echo "expected image revision $release_revision, got $image_revision" >&2
  exit 1
fi
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null

start_container() {
  docker run --detach \
    --name "$container" \
    --network "$network" \
    --network-alias curio \
    --volume "$volume:/data" \
    "$image" >/dev/null
}

wait_for_health() {
  for _ in $(seq 1 30); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$status" == "unhealthy" ]]; then
      docker logs "$container"
      return 1
    fi
    sleep 1
  done
  docker logs "$container"
  return 1
}

check_contract() {
  docker run --rm --network "$network" \
    -e "EXPECTED_REVISION=$release_revision" \
    -e "EXPECTED_BUILD_TIME=$build_time" \
    oven/bun:1.3.5-alpine bun -e '
const responses = await Promise.all(["/healthz", "/readyz", "/version"].map(async (path) => {
  const response = await fetch(`http://curio:3000${path}`, { signal: AbortSignal.timeout(5_000) });
  return { path, response, body: await response.json() };
}));
const liveness = responses.find(({ path }) => path === "/healthz");
const readiness = responses.find(({ path }) => path === "/readyz");
const version = responses.find(({ path }) => path === "/version");
if (!liveness || !liveness.response.ok || liveness.body.status !== "ok") process.exit(1);
if (!readiness || !readiness.response.ok || readiness.body.status !== "ok") process.exit(1);
if (!version || !version.response.ok || version.body.service !== "curio") process.exit(1);
if (version.body.revision !== process.env.EXPECTED_REVISION) process.exit(1);
if (version.body.buildTime !== process.env.EXPECTED_BUILD_TIME) process.exit(1);
if (!Number.isSafeInteger(version.body.schemaVersion) || version.body.schemaVersion < 0) process.exit(1);
console.log("curio_health_contract_ok");
'
}

start_container
wait_for_health
check_contract

docker rm -f "$container" >/dev/null
start_container
wait_for_health
check_contract

migration_count=$(docker exec "$container" bun -e \
  "import {Database} from 'bun:sqlite';const db=new Database('/data/curio.db');console.log(db.query('SELECT COUNT(*) AS count FROM schema_migrations').get().count);db.close()")
expected_migration_count=$(find migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')

if [[ "$migration_count" != "$expected_migration_count" ]]; then
  echo "expected $expected_migration_count applied migrations after restart, got $migration_count" >&2
  exit 1
fi

echo "Docker smoke test passed"
