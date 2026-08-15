#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=${CURIO_ROOT:-/opt/curio}
REPOSITORY=${CURIO_REPOSITORY:-https://github.com/panda850819/curio.git}
REVISION=${CURIO_REVISION:-5bf99fef7f907d6d041814d0055cbba215441a60}
IMAGE=${CURIO_IMAGE:-curio/server:5bf99fe}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ $(id -u) -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if ! docker network inspect personal-infra_private >/dev/null 2>&1; then
  echo "required Docker network personal-infra_private is missing" >&2
  exit 1
fi
if [[ ! -f "$ROOT/.env" ]]; then
  echo "create $ROOT/.env before deployment" >&2
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

install -d -m 0700 "$ROOT" "$ROOT/data" "$ROOT/backups" "$ROOT/restore-test" "$ROOT/operations" "$ROOT/runtime"
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

docker build \
  --label "org.opencontainers.image.revision=$REVISION" \
  --tag "$IMAGE" \
  "$ROOT/source"
if [[ $(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}') != "$REVISION" ]]; then
  echo "image revision label mismatch" >&2
  exit 1
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
install -m 0700 "$SCRIPT_DIR/item-outbox-smoke.sh" "$ROOT/operations/item-outbox-smoke.sh"
install -m 0600 "$SCRIPT_DIR/item-outbox-smoke.ts" "$ROOT/operations/item-outbox-smoke.ts"
install -m 0700 "$SCRIPT_DIR/telegram-failure-smoke.sh" "$ROOT/operations/telegram-failure-smoke.sh"
if grep -q '^CURIO_IMAGE=' "$ROOT/.env"; then
  sed -i "s|^CURIO_IMAGE=.*$|CURIO_IMAGE=$IMAGE|" "$ROOT/.env"
else
  printf 'CURIO_IMAGE=%s\n' "$IMAGE" >> "$ROOT/.env"
fi
printf '30 3 * * * root CURIO_ROOT=%s CURIO_IMAGE=%s %s/operations/backup.sh daily\n' \
  "$ROOT" "$IMAGE" "$ROOT" > /etc/cron.d/curio-backup
chmod 0600 /etc/cron.d/curio-backup
cd "$ROOT"
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --no-build
