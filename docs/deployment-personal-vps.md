# Curio deployment on personal-vps

This runbook deploys an explicitly accepted full commit SHA as a separately tagged image. It publishes no host port and uses only `personal-infra_private`. The service contract is `/healthz` for shallow liveness, `/readyz` for SQLite and migration readiness, and `/version` for immutable artifact identity.

## 1. Create the secret file

Run this yourself in an interactive SSH session. The token is read without echo and never appears in shell history:

```bash
ssh personal-vps
sudo install -d -m 0700 /opt/curio
sudo bash -c '
  umask 077
  read -r -s -p "Telegram bot token: " token
  printf "\n"
  read -r -p "Telegram chat ID: " chat
  read -r -p "Telegram webhook URL (blank to disable): " webhook_url
  read -r -p "Telegram allowed user IDs (comma-separated): " allowed_users
  read -r -p "Telegram allowed chat IDs (blank for any chat): " allowed_chats
  read -r -s -p "Telegram webhook secret (blank to disable): " webhook_secret
  printf "\n"
  printf "TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\nTELEGRAM_WEBHOOK_URL=%s\nTELEGRAM_WEBHOOK_SECRET=%s\nTELEGRAM_ALLOWED_USER_IDS=%s\nTELEGRAM_ALLOWED_CHAT_IDS=%s\n" \
    "$token" "$chat" "$webhook_url" "$webhook_secret" "$allowed_users" "$allowed_chats" > /opt/curio/.env
  unset token chat webhook_url webhook_secret allowed_users allowed_chats
'
sudo stat -c '%a %U:%G %n' /opt/curio/.env
exit
```

Expected mode: `600 root:root`. Add the bot to the destination channel and grant permission to post messages before deployment.

## 2. Install or upgrade

Copy the repository `deploy/` directory to a temporary server path, then run:

```bash
sudo env CURIO_REVISION=<accepted-40-character-commit-sha> \
  CURIO_IMAGE=curio/server:<new-release-tag> \
  /path/to/deploy/install.sh
```

Use a new immutable image tag for each install; the installer refuses to overwrite the image tag recorded by the current release target.

`install.sh`:

1. checks the private Docker network and secret-file mode;
2. creates a pre-deploy SQLite backup when a database already exists;
3. clones/fetches and checks out the exact accepted revision, refusing any tracked, untracked, or ignored source-tree changes;
4. builds and labels the explicitly selected image, embedding the accepted revision and a canonical real UTC `CURIO_BUILD_TIME` (`YYYY-MM-DDTHH:MM:SSZ`);
5. atomically writes `/opt/curio/release-manifest.env` with mode `0600` as the desired release target, containing `manifest_version`, `image`, `image_id`, `revision`, `build_time`, and `contract_generation` for the exact image, revision, build time, and `health-v1` contract generation;
6. installs the target Compose/runtime/operations state;
7. validates Compose without printing rendered secrets;
8. starts the service with `--no-build`, waits for Docker health, and verifies `/healthz`, `/readyz`, `/version`, image labels, and the target migration set.

The release manifest is an independently anchored target record, not a post-verification health claim. If candidate configuration, startup, health, identity, or status verification fails, the installer exits loudly without automatic rollback; the target manifest remains the attempted candidate so a subsequent status check cannot falsely describe the old release. Follow the documented manual rollback procedure. The predeploy SQLite backup remains available for an explicitly accepted data restore; database contents are not silently restored over newer writes.

The image and container carry the non-secret discovery labels `com.panda.personal-infra.service`, `com.panda.personal-infra.healthz`, `com.panda.personal-infra.readyz`, `com.panda.personal-infra.version`, and `com.panda.personal-infra.revision`. The Docker healthcheck probes `/healthz`; it does not make external dependency calls.

The installer keeps `.env` at `0600 root:root`, creates `runtime/curio.env` at `0440 root:<container-gid>`, and mounts only that runtime copy as `/run/secrets/curio_env`. The bot token is not embedded in rendered Compose output or stored in the image. Continue using `docker compose config --quiet` in automation to minimize unrelated configuration disclosure.

## 3. Verification

`status.sh` first validates the root-owned `release-manifest.env` target and compares the Compose image, running container, image labels, and `/version` response with it. It accepts only a real canonical UTC `build_time`; malformed, non-UTC, impossible-date, missing, tampered, or stale manifests fail closed. It runs bounded `/healthz` and `/readyz` checks before reporting the database status. It never sources or prints the runtime secret file or private application configuration.

```bash
sudo /opt/curio/operations/status.sh
sudo /opt/curio/operations/item-outbox-smoke.sh
sudo /opt/curio/operations/telegram-failure-smoke.sh
sudo /opt/curio/operations/ui-smoke.sh
```

The item outbox smoke stops Curio gracefully, verifies one pending delivery inside a transaction, rolls the transaction back, and restarts Curio. It does not send an item message.

The Telegram smoke creates one controlled RSS poll failure. Expected evidence is exactly one failure event, one delivery, one Telegram alert, and a stored Telegram `message_id`. The smoke subscription is soft-deleted afterward.

When webhook control is enabled, configure Telegram once after the service is healthy. Normal startup never resets the webhook:

```bash
cd /opt/curio
sudo docker compose --env-file .env -f compose.yaml exec -T curio bun run telegram:webhook
sudo env TELEGRAM_WEBHOOK_SECRET="$(sudo awk -F= '$1 == \"TELEGRAM_WEBHOOK_SECRET\" { print substr($0, index($0, \"=\") + 1) }' .env)" \
  CURIO_WEBHOOK_BASE_URL=https://curio.example.com /opt/curio/operations/telegram-webhook-smoke.sh
```

The webhook smoke verifies `GET` rejection, secret validation, and a valid update response without sending a real user command.

When the shared email inbox is enabled, set `EMAIL_INBOUND_ADDRESS` and `EMAIL_INBOUND_WEBHOOK_SECRET` in `/opt/curio/.env`. Configure the external inbound email service to send its normalized JSON payload to `https://curio.example.com/email/inbound` with `X-Curio-Email-Secret`. Curio does not run an SMTP server.

Verify a restart:

```bash
cd /opt/curio
sudo docker compose --env-file .env -f compose.yaml restart curio
sudo docker compose --env-file .env -f compose.yaml ps
sudo /opt/curio/operations/status.sh
```

## 4. Backups and restore rehearsal

Cron runs daily at 03:30 UTC from `/etc/cron.d/curio-backup` and retains 14 daily files.

```bash
sudo /opt/curio/operations/backup.sh daily
sudo /opt/curio/operations/restore-rehearsal.sh
```

Backups use SQLite `.backup`, mode `0600`, and must return `ok` from `PRAGMA integrity_check`. Restore rehearsal writes only under `/opt/curio/restore-test`, rejects an image whose revision label differs from the release target, reruns migrations, and requires the exact release migration set through `010_reader_visibility.sql`.

## 5. Operations

```bash
sudo /opt/curio/operations/status.sh
cd /opt/curio
sudo docker compose --env-file .env -f compose.yaml logs --since 1h --no-color curio
sudo sqlite3 data/curio.db "SELECT status,count(*) FROM deliveries GROUP BY status;"
sudo sqlite3 data/curio.db "SELECT version,name,applied_at FROM schema_migrations ORDER BY version;"
df -h /opt/curio
```

Use `curio deliveries retry <delivery-id>` only after reviewing an `uncertain` or `permanent_failure` record. A retry can duplicate a Telegram message when the original outcome was ambiguous.

## 6. X source credentials

The optional `xbird` adapter requires both `X_AUTH_TOKEN` and `X_CT0`. These are X session cookies with full account authority even though Curio invokes only the read path. Use a dedicated read account and never paste values into chat, Git, shell arguments, or logs.

Append or rotate them through a no-echo root shell, then rerun `install.sh` so the restricted runtime copy is refreshed:

```bash
ssh personal-vps
sudo bash -c '
  set -euo pipefail
  read -r -s -p "X auth_token: " auth; printf "\n"
  read -r -s -p "X ct0: " ct0; printf "\n"
  tmp=$(mktemp)
  grep -vE "^(X_AUTH_TOKEN|X_CT0)=" /opt/curio/.env > "$tmp"
  printf "X_AUTH_TOKEN=%s\nX_CT0=%s\n" "$auth" "$ct0" >> "$tmp"
  install -o root -g root -m 0600 "$tmp" /opt/curio/.env
  rm -f "$tmp"
  unset auth ct0
'
exit
```

Production sets `XBIRD_DISABLE_LIVE_WRITES=1` inside the child process, invokes only `user-tweets` with fixed argv, and does not pass Telegram credentials to the child environment.

## 7. Credential rotation

1. Stop Curio gracefully.
2. Recreate `/opt/curio/.env` with the no-echo procedure above.
3. Ensure mode `0600`.
4. Rerun `install.sh` to refresh the restricted runtime secret copy and recreate Curio.
5. Run `status.sh`.
6. Revoke the old token only after the new bot successfully posts.

## 8. Rollback

Always create a backup before rollback:

```bash
sudo /opt/curio/operations/backup.sh prerollback
```

Application rollback to the known Issue #9 artifact `94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa` is schema-tolerant: the older application ignores migrations 005, 006, and 007 tables. Its image predates `/healthz`, `/readyz`, and `/version`, so do not run the standard `status.sh` against it. Build exactly the documented rollback image and add the revision label because the old Dockerfile predates OCI identity labels:

```bash
git clone https://github.com/panda850819/curio.git /tmp/curio-rollback
git -C /tmp/curio-rollback checkout --detach 94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa
if [[ -n "$(git -C /tmp/curio-rollback status --porcelain=v1 --untracked-files=all --ignored)" ]] ||
  git -C /tmp/curio-rollback ls-files -v | awk '$1 ~ /^[a-zS]$/ { found = 1 } END { exit found ? 0 : 1 }'; then
  echo 'rollback source checkout is dirty or has hidden index state' >&2
  exit 1
fi
rollback_revision=$(git -C /tmp/curio-rollback rev-parse HEAD)
if [[ "$rollback_revision" != 94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa ]]; then
  echo 'rollback source revision is not accepted' >&2
  exit 1
fi
sudo docker build \
  --label "org.opencontainers.image.revision=$rollback_revision" \
  --tag curio/server:rollback-94ee0ff \
  /tmp/curio-rollback
if [[ "$(sudo docker image inspect curio/server:rollback-94ee0ff --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" != "$rollback_revision" ]]; then
  echo 'rollback image revision label mismatch' >&2
  exit 1
fi
```

Record the image ID as an independently accepted, root-owned `legacy-release-manifest.env` containing `manifest_version`, `image`, `image_id`, `revision`, and `contract_generation`. Do not derive the expected ID from the mutable tag during verification:

```bash
sudo sh -c '
  set -eu
  image_id=$(docker image inspect curio/server:rollback-94ee0ff --format "{{.Id}}")
  case "$image_id" in
    sha256:*) digest=${image_id#sha256:} ;;
    *) echo "rollback image ID is invalid" >&2; exit 1 ;;
  esac
  if [ "${#digest}" -ne 64 ] || ! printf "%s\\n" "$digest" | grep -Eq "^[0-9a-fA-F]{64}$"; then
    echo "rollback image ID is invalid" >&2
    exit 1
  fi
  tmp=$(mktemp /opt/curio/.legacy-release-manifest.XXXXXX)
  printf "manifest_version=1\\nimage=curio/server:rollback-94ee0ff\\nimage_id=%s\\nrevision=94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa\\ncontract_generation=legacy-v0\\n" "$image_id" > "$tmp"
  chown root:root "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" /opt/curio/legacy-release-manifest.env
'
```

Set `CURIO_IMAGE=curio/server:rollback-94ee0ff` and `CURIO_HEALTH_CONTRACT=legacy-v0` in `/opt/curio/.env` without sourcing the secret file, recreate with `--no-build`, then run the explicitly scoped verifier:

```bash
sudo sh -c '
  file=/opt/curio/.env
  if grep -q "^CURIO_IMAGE=" "$file"; then
    sed -i "s|^CURIO_IMAGE=.*$|CURIO_IMAGE=curio/server:rollback-94ee0ff|" "$file"
  else
    printf "CURIO_IMAGE=curio/server:rollback-94ee0ff\\n" >> "$file"
  fi
  if grep -q "^CURIO_HEALTH_CONTRACT=" "$file"; then
    sed -i "s|^CURIO_HEALTH_CONTRACT=.*$|CURIO_HEALTH_CONTRACT=legacy-v0|" "$file"
  else
    printf "CURIO_HEALTH_CONTRACT=legacy-v0\\n" >> "$file"
  fi
'
cd /opt/curio
sudo docker compose --env-file .env -f compose.yaml up -d --no-build curio
sudo /opt/curio/operations/status-legacy.sh
```

`status-legacy.sh` is bounded and fails unless the root-owned rollback manifest's image ID matches the local tag and running container, the Compose image and OCI revision match the known artifact, legacy `GET /health` returns `status: ok`, Docker reports the explicit legacy healthcheck healthy, and `PRAGMA integrity_check` returns `ok`. It does not silently skip health or use the current release manifest. The standard restore, item-outbox, and UI smoke scripts reject the `legacy-v0` Compose contract instead of using the forward release manifest. Rerun the normal installer to return to a `health-v1` release and replace the manifest.

Do not delete `destinations`, `deliveries`, or `delivery_attempts`. Rolling back stops Telegram processing but preserves delivery state for a later forward deployment. If restore from backup is required, stop Curio and restore only after explicitly accepting loss of all data written after that backup.
