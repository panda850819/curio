#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-${CURIO_ROOT:-/opt/curio}}
MANIFEST=${CURIO_RELEASE_MANIFEST:-$ROOT/release-manifest.env}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

fail() {
  echo "release manifest: $1" >&2
  exit 1
}

if [[ -L "$MANIFEST" || ! -f "$MANIFEST" ]]; then
  fail "release target manifest is missing"
fi
manifest_mode=$(stat -c '%a' "$MANIFEST" 2>/dev/null || stat -f '%Lp' "$MANIFEST" 2>/dev/null) || fail "cannot inspect release manifest mode"
[[ "$manifest_mode" == "600" ]] || fail "release manifest must have mode 0600"
manifest_owner=$(stat -c '%u' "$MANIFEST" 2>/dev/null || stat -f '%u' "$MANIFEST" 2>/dev/null) || fail "cannot inspect release manifest owner"
[[ "$manifest_owner" == "0" ]] || fail "release manifest must be owned by root"

manifest_version=
manifest_image=
manifest_image_id=
manifest_revision=
manifest_build_time=
manifest_contract=
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" == *=* ]] || fail "release manifest has an invalid line"
  key=${line%%=*}
  value=${line#*=}
  [[ "$key" =~ ^[a-z_]+$ ]] || fail "release manifest has an invalid key"
  [[ "$value" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || fail "release manifest has an invalid value"
  case "$key" in
    manifest_version)
      [[ -z "$manifest_version" ]] || fail "release manifest has a duplicate key"
      manifest_version=$value
      ;;
    image)
      [[ -z "$manifest_image" ]] || fail "release manifest has a duplicate key"
      manifest_image=$value
      ;;
    image_id)
      [[ -z "$manifest_image_id" ]] || fail "release manifest has a duplicate key"
      manifest_image_id=$value
      ;;
    revision)
      [[ -z "$manifest_revision" ]] || fail "release manifest has a duplicate key"
      manifest_revision=$value
      ;;
    build_time)
      [[ -z "$manifest_build_time" ]] || fail "release manifest has a duplicate key"
      manifest_build_time=$value
      ;;
    contract_generation)
      [[ -z "$manifest_contract" ]] || fail "release manifest has a duplicate key"
      manifest_contract=$value
      ;;
    *) fail "release manifest has an unknown key: $key" ;;
  esac
done < "$MANIFEST"

[[ "$manifest_version" == "1" ]] || fail "unsupported release manifest version"
[[ "$manifest_image" =~ ^[A-Za-z0-9._/@:+-]+$ ]] || fail "release manifest image is invalid"
[[ "$manifest_image_id" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || fail "release manifest image ID is invalid"
[[ "$manifest_revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "release manifest revision is invalid"
[[ "$manifest_build_time" =~ ^[A-Za-z0-9_.:+-]+$ ]] || fail "release manifest build time is invalid"
"$SCRIPT_DIR/validate-utc-timestamp.sh" "$manifest_build_time" || fail "release manifest build time is not a real UTC timestamp"
[[ "$manifest_contract" == "health-v1" ]] || fail "unsupported release contract"

if [[ -f "$ROOT/.env" ]]; then
  configured_image=$(awk -F= '$1 == "CURIO_IMAGE" { value = substr($0, index($0, "=") + 1) } END { print value }' "$ROOT/.env")
  [[ -z "$configured_image" || "$configured_image" == "$manifest_image" ]] || fail "CURIO_IMAGE in .env does not match the release target manifest"
  configured_contract=$(awk -F= '$1 == "CURIO_HEALTH_CONTRACT" { value = substr($0, index($0, "=") + 1) } END { print value }' "$ROOT/.env")
  [[ -z "$configured_contract" || "$configured_contract" == "health-v1" ]] || fail "CURIO_HEALTH_CONTRACT in .env is not the forward release contract"
fi

if [[ -n "${CURIO_IMAGE:-}" && "$CURIO_IMAGE" != "$manifest_image" ]]; then
  fail "CURIO_IMAGE override does not match the release target manifest"
fi
if [[ -n "${CURIO_REVISION:-}" && "$CURIO_REVISION" != "$manifest_revision" ]]; then
  fail "CURIO_REVISION override does not match the release target manifest"
fi
if [[ -n "${CURIO_BUILD_TIME:-}" && "$CURIO_BUILD_TIME" != "$manifest_build_time" ]]; then
  fail "CURIO_BUILD_TIME override does not match the release target manifest"
fi
if [[ -n "${CURIO_HEALTH_CONTRACT:-}" && "$CURIO_HEALTH_CONTRACT" != "$manifest_contract" ]]; then
  fail "CURIO_HEALTH_CONTRACT override does not match the release target manifest"
fi

printf '%s\t%s\t%s\t%s\t%s\n' \
  "$manifest_image" "$manifest_image_id" "$manifest_revision" "$manifest_build_time" "$manifest_contract"
