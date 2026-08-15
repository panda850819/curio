# Curio deployment on personal-vps

This runbook deploys application revision `5bf99fef7f907d6d041814d0055cbba215441a60` as image `curio/server:5bf99fe`. It publishes no host port and uses only `personal-infra_private`.

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
  printf "TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n" "$token" "$chat" > /opt/curio/.env
  unset token chat
'
sudo stat -c '%a %U:%G %n' /opt/curio/.env
exit
```

Expected mode: `600 root:root`. Add the bot to the destination channel and grant permission to post messages before deployment.

## 2. Install or upgrade

Copy the repository `deploy/` directory to a temporary server path, then run:

```bash
sudo /path/to/deploy/install.sh
```

`install.sh`:

1. checks the private Docker network and secret-file mode;
2. creates a pre-deploy SQLite backup when a database already exists;
3. clones/fetches and checks out the exact accepted revision;
4. builds and labels immutable image `curio/server:5bf99fe`;
5. installs production Compose and operations scripts;
6. validates Compose without printing rendered secrets;
7. starts the service with `--no-build`.

Production Compose mounts `.env` as `/run/secrets/curio_env`; the bot token is not embedded in rendered Compose output or stored in the image. Continue using `docker compose config --quiet` in automation to minimize unrelated configuration disclosure.

## 3. Verification

```bash
sudo /opt/curio/operations/status.sh
sudo /opt/curio/operations/item-outbox-smoke.sh
sudo /opt/curio/operations/telegram-failure-smoke.sh
```

The item outbox smoke stops Curio gracefully, verifies one pending delivery inside a transaction, rolls the transaction back, and restarts Curio. It does not send an item message.

The Telegram smoke creates one controlled RSS poll failure. Expected evidence is exactly one failure event, one delivery, one Telegram alert, and a stored Telegram `message_id`. The smoke subscription is soft-deleted afterward.

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

Backups use SQLite `.backup`, mode `0600`, and must return `ok` from `PRAGMA integrity_check`. Restore rehearsal writes only under `/opt/curio/restore-test`, reruns migrations, and requires exactly five migration records.

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

## 6. Credential rotation

1. Stop Curio gracefully.
2. Recreate `/opt/curio/.env` with the no-echo procedure above.
3. Ensure mode `0600`.
4. Start Curio and run `status.sh`.
5. Revoke the old token only after the new bot successfully posts.

## 7. Rollback

Always create a backup before rollback:

```bash
sudo /opt/curio/operations/backup.sh prerollback
```

Application rollback to Issue #9 artifact `94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa` is schema-tolerant: the older application ignores migration 005 tables. Build a separately tagged image from that exact revision, update `CURIO_IMAGE`, and recreate the container with `--no-build`.

Do not delete `destinations`, `deliveries`, or `delivery_attempts`. Rolling back stops Telegram processing but preserves delivery state for a later forward deployment. If restore from backup is required, stop Curio and restore only after explicitly accepting loss of all data written after that backup.
