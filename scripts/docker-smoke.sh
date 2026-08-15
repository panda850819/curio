#!/usr/bin/env bash
set -euo pipefail

image="curio/server:smoke"
network="curio-smoke-$$"
volume="curio-smoke-$$"
container="curio-smoke-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --tag "$image" .
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

start_container
wait_for_health

docker run --rm --network "$network" oven/bun:1.3.5-alpine \
  bun -e "const response=await fetch('http://curio:3000/health');if(!response.ok)process.exit(1);const body=await response.json();if(body.status!=='ok'||body.service!=='curio')process.exit(1)"

docker rm -f "$container" >/dev/null
start_container
wait_for_health

migration_count=$(docker exec "$container" bun -e \
  "import {Database} from 'bun:sqlite';const db=new Database('/data/curio.db');console.log(db.query('SELECT COUNT(*) AS count FROM schema_migrations').get().count);db.close()")

if [[ "$migration_count" != "1" ]]; then
  echo "expected one applied migration after restart, got $migration_count" >&2
  exit 1
fi

echo "Docker smoke test passed"
