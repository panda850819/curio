#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
REPOSITORY=${CURIO_REPOSITORY:-https://github.com/panda850819/curio.git}
REVISION=${CURIO_REVISION:-}
IMAGE=${CURIO_IMAGE:-}
BUILD_TIME=${CURIO_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
CONTRACT_GENERATION=health-v1
RELEASE_MANIFEST="$ROOT/release-manifest.env"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MANIFEST_TMP=
TARGET_MANIFEST_WRITTEN=0
PREVIOUS_TARGET_PRESENT=0

cleanup_manifest() {
  [[ -z "${MANIFEST_TMP:-}" ]] || rm -f -- "$MANIFEST_TMP"
}

install_exit() {
  local status=$?
  trap - EXIT
  cleanup_manifest || true
  if [[ "$status" -ne 0 && "$TARGET_MANIFEST_WRITTEN" == 1 ]]; then
    if [[ "$PREVIOUS_TARGET_PRESENT" == 1 ]]; then
      echo "candidate deployment failed after target manifest write; automatic rollback was not performed; follow the documented manual rollback procedure" >&2
    else
      echo "candidate deployment failed after target manifest write; no previous release was restored; clean up or replace the candidate manually" >&2
    fi
  fi
  exit "$status"
}

if [[ $(id -u) -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if [[ ! "$BUILD_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  ! "$SCRIPT_DIR/validate-utc-timestamp.sh" "$BUILD_TIME"; then
  echo "CURIO_BUILD_TIME must be a real UTC timestamp in YYYY-MM-DDTHH:MM:SSZ form" >&2
  exit 1
fi
if ! docker network inspect personal-infra_private >/dev/null 2>&1; then
  echo "required Docker network personal-infra_private is missing" >&2
  exit 1
fi
if [[ ! -f "$ROOT/.env" || -L "$ROOT/.env" ]]; then
  echo "create a regular $ROOT/.env before deployment" >&2
  exit 1
fi
if [[ $(stat -c '%a' "$ROOT/.env") != 600 ]]; then
  echo "$ROOT/.env must have mode 0600" >&2
  exit 1
fi
if ! grep -q '^TELEGRAM_BOT_TOKEN=..' "$ROOT/.env" || ! grep -q '^TELEGRAM_CHAT_ID=..' "$ROOT/.env"; then
  echo "Telegram token and chat ID must both be configured" >&2
  exit 1
fi
if [[ -z "$REVISION" || ! "$REVISION" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CURIO_REVISION must be an explicit full 40-character commit SHA" >&2
  exit 1
fi
if [[ -z "$IMAGE" || ! "$IMAGE" =~ ^[A-Za-z0-9._/@:+-]+$ ]]; then
  echo "CURIO_IMAGE must be an explicit value without unsupported characters" >&2
  exit 1
fi
if [[ -f "$RELEASE_MANIFEST" && ! -L "$RELEASE_MANIFEST" ]]; then
  PREVIOUS_TARGET_PRESENT=1
  current_target_image=$(awk -F= '$1 == "image" { value = substr($0, index($0, "=") + 1) } END { print value }' "$RELEASE_MANIFEST")
  if [[ -n "$current_target_image" && "$current_target_image" == "$IMAGE" ]]; then
    echo "CURIO_IMAGE must use a new tag instead of overwriting the current release target" >&2
    exit 1
  fi
elif [[ -f "$ROOT/legacy-release-manifest.env" && ! -L "$ROOT/legacy-release-manifest.env" ]]; then
  PREVIOUS_TARGET_PRESENT=1
fi

trap install_exit EXIT
install -d -m 0700 "$ROOT" "$ROOT/data" "$ROOT/backups" "$ROOT/restore-test"
if [[ -f "$ROOT/data/curio.db" ]]; then
  "$SCRIPT_DIR/backup.sh" predeploy
fi

if [[ ! -d "$ROOT/source/.git" ]]; then
  git clone "$REPOSITORY" "$ROOT/source"
fi
git -C "$ROOT/source" fetch --quiet origin "$REVISION"
git -C "$ROOT/source" checkout --detach "$REVISION"
if [[ $(git -C "$ROOT/source" rev-parse HEAD) != "$REVISION" ]]; then
  echo "source revision mismatch" >&2
  exit 1
fi
if [[ -n "$(git -C "$ROOT/source" status --porcelain=v1 --untracked-files=all --ignored)" ]] ||
  git -C "$ROOT/source" ls-files -v | awk '$1 ~ /^[a-zS]$/ { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "source checkout is dirty or has hidden index state; refusing to certify the release" >&2
  exit 1
fi

docker build \
  --build-arg "CURIO_RELEASE_REVISION=$REVISION" \
  --build-arg "CURIO_BUILD_TIME=$BUILD_TIME" \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label "org.opencontainers.image.created=$BUILD_TIME" \
  --label "com.panda.personal-infra.service=curio" \
  --label "com.panda.personal-infra.healthz=http://curio:3000/healthz" \
  --label "com.panda.personal-infra.readyz=http://curio:3000/readyz" \
  --label "com.panda.personal-infra.version=http://curio:3000/version" \
  --label "com.panda.personal-infra.revision=$REVISION" \
  --tag "$IMAGE" \
  "$ROOT/source"
if [[ $(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}') != "$REVISION" ]]; then
  echo "image revision label mismatch" >&2
  exit 1
fi
if [[ $(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.created" }}') != "$BUILD_TIME" ]]; then
  echo "image build time label mismatch" >&2
  exit 1
fi
if [[ $(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "com.panda.personal-infra.revision" }}') != "$REVISION" ]]; then
  echo "image metadata revision mismatch" >&2
  exit 1
fi
IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "image ID is invalid" >&2
  exit 1
fi

# The manifest describes the explicit target image, not a health verdict. Write
# it before changing Compose/runtime state so a failed cutover never leaves an
# older manifest claiming to describe the attempted release.
MANIFEST_TMP=$(mktemp "$ROOT/.release-manifest.XXXXXX")
printf 'manifest_version=1\nimage=%s\nimage_id=%s\nrevision=%s\nbuild_time=%s\ncontract_generation=%s\n' \
  "$IMAGE" "$IMAGE_ID" "$REVISION" "$BUILD_TIME" "$CONTRACT_GENERATION" > "$MANIFEST_TMP"
chown root:root "$MANIFEST_TMP"
chmod 0600 "$MANIFEST_TMP"
mv -f -- "$MANIFEST_TMP" "$RELEASE_MANIFEST"
MANIFEST_TMP=
TARGET_MANIFEST_WRITTEN=1

install -d -m 0700 "$ROOT/operations" "$ROOT/runtime"
if grep -q '^CURIO_IMAGE=' "$ROOT/.env"; then
  sed -i "s|^CURIO_IMAGE=.*$|CURIO_IMAGE=$IMAGE|" "$ROOT/.env"
else
  printf 'CURIO_IMAGE=%s\n' "$IMAGE" >> "$ROOT/.env"
fi
if grep -q '^CURIO_HEALTH_CONTRACT=' "$ROOT/.env"; then
  sed -i "s|^CURIO_HEALTH_CONTRACT=.*$|CURIO_HEALTH_CONTRACT=$CONTRACT_GENERATION|" "$ROOT/.env"
else
  printf 'CURIO_HEALTH_CONTRACT=%s\n' "$CONTRACT_GENERATION" >> "$ROOT/.env"
fi
container_uid=$(docker run --rm "$IMAGE" id -u)
container_gid=$(docker run --rm "$IMAGE" id -g)
chown "$container_uid:$container_gid" "$ROOT/data"
install -d -o root -g "$container_gid" -m 0710 "$ROOT/runtime"
install -o root -g "$container_gid" -m 0440 "$ROOT/.env" "$ROOT/runtime/curio.env"

install -m 0600 "$SCRIPT_DIR/compose.production.yaml" "$ROOT/compose.yaml"
install -m 0700 "$SCRIPT_DIR/backup.sh" "$ROOT/operations/backup.sh"
install -m 0700 "$SCRIPT_DIR/restore-rehearsal.sh" "$ROOT/operations/restore-rehearsal.sh"
install -m 0700 "$SCRIPT_DIR/status.sh" "$ROOT/operations/status.sh"
install -m 0700 "$SCRIPT_DIR/release-values.sh" "$ROOT/operations/release-values.sh"
install -m 0700 "$SCRIPT_DIR/validate-utc-timestamp.sh" "$ROOT/operations/validate-utc-timestamp.sh"
install -m 0700 "$SCRIPT_DIR/legacy-release-values.sh" "$ROOT/operations/legacy-release-values.sh"
install -m 0700 "$SCRIPT_DIR/status-legacy.sh" "$ROOT/operations/status-legacy.sh"
install -m 0700 "$SCRIPT_DIR/item-outbox-smoke.sh" "$ROOT/operations/item-outbox-smoke.sh"
install -m 0600 "$SCRIPT_DIR/item-outbox-smoke.ts" "$ROOT/operations/item-outbox-smoke.ts"
install -m 0700 "$SCRIPT_DIR/telegram-failure-smoke.sh" "$ROOT/operations/telegram-failure-smoke.sh"
install -m 0700 "$SCRIPT_DIR/telegram-webhook-smoke.sh" "$ROOT/operations/telegram-webhook-smoke.sh"
install -m 0700 "$SCRIPT_DIR/ui-smoke.sh" "$ROOT/operations/ui-smoke.sh"
printf '30 3 * * * root CURIO_ROOT=%s CURIO_IMAGE=%s %s/operations/backup.sh daily\n' \
  "$ROOT" "$IMAGE" "$ROOT" > /etc/cron.d/curio-backup
chmod 0600 /etc/cron.d/curio-backup

cd "$ROOT"
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --no-build

release_healthy=
for _ in $(seq 1 30); do
  container_id=$(docker compose --env-file .env -f compose.yaml ps -q curio 2>/dev/null || true)
  if [[ "$container_id" =~ ^[A-Za-z0-9]+$ ]]; then
    container_state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)
    container_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}}' "$container_id" 2>/dev/null || true)
    if [[ "$container_state" == running && "$container_health" == healthy ]]; then
      release_healthy=1
      break
    fi
  fi
  sleep 1
done
if [[ -z "$release_healthy" ]]; then
  echo "new Curio release did not become healthy; target manifest remains the candidate and manual rollback is required" >&2
  exit 1
fi
if ! CURIO_ROOT="$ROOT" CURIO_RELEASE_MANIFEST="$RELEASE_MANIFEST" "$ROOT/operations/status.sh" >/dev/null; then
  echo "new Curio release failed health and identity verification; target manifest remains the candidate and manual rollback is required" >&2
  exit 1
fi
