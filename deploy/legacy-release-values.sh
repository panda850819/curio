#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-${CURIO_ROOT:-/opt/curio}}
MANIFEST=${CURIO_LEGACY_MANIFEST:-$ROOT/legacy-release-manifest.env}
LEGACY_REVISION=94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa
LEGACY_IMAGE=curio/server:rollback-94ee0ff
LEGACY_CONTRACT=legacy-v0

fail() {
  echo "legacy release manifest: $1" >&2
  exit 1
}

if [[ -L "$MANIFEST" || ! -f "$MANIFEST" ]]; then
  fail "accepted rollback manifest is missing"
fi
manifest_mode=$(stat -c '%a' "$MANIFEST" 2>/dev/null || stat -f '%Lp' "$MANIFEST" 2>/dev/null) || fail "cannot inspect rollback manifest mode"
[[ "$manifest_mode" == "600" ]] || fail "rollback manifest must have mode 0600"
manifest_owner=$(stat -c '%u' "$MANIFEST" 2>/dev/null || stat -f '%u' "$MANIFEST" 2>/dev/null) || fail "cannot inspect rollback manifest owner"
[[ "$manifest_owner" == "0" ]] || fail "rollback manifest must be owned by root"

manifest_version=
manifest_image=
manifest_image_id=
manifest_revision=
manifest_contract=
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" == *=* ]] || fail "rollback manifest has an invalid line"
  key=${line%%=*}
  value=${line#*=}
  [[ "$key" =~ ^[a-z_]+$ ]] || fail "rollback manifest has an invalid key"
  [[ "$value" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || fail "rollback manifest has an invalid value"
  case "$key" in
    manifest_version)
      [[ -z "$manifest_version" ]] || fail "rollback manifest has a duplicate key"
      manifest_version=$value
      ;;
    image)
      [[ -z "$manifest_image" ]] || fail "rollback manifest has a duplicate key"
      manifest_image=$value
      ;;
    image_id)
      [[ -z "$manifest_image_id" ]] || fail "rollback manifest has a duplicate key"
      manifest_image_id=$value
      ;;
    revision)
      [[ -z "$manifest_revision" ]] || fail "rollback manifest has a duplicate key"
      manifest_revision=$value
      ;;
    contract_generation)
      [[ -z "$manifest_contract" ]] || fail "rollback manifest has a duplicate key"
      manifest_contract=$value
      ;;
    *) fail "rollback manifest has an unknown key: $key" ;;
  esac
done < "$MANIFEST"

[[ "$manifest_version" == "1" ]] || fail "unsupported rollback manifest version"
[[ "$manifest_image" == "$LEGACY_IMAGE" ]] || fail "rollback manifest image is not accepted"
[[ "$manifest_image_id" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || fail "rollback manifest image ID is invalid"
[[ "$manifest_revision" == "$LEGACY_REVISION" ]] || fail "rollback manifest revision is not accepted"
[[ "$manifest_contract" == "$LEGACY_CONTRACT" ]] || fail "rollback manifest contract is not accepted"

printf '%s\t%s\t%s\t%s\n' "$manifest_image" "$manifest_image_id" "$manifest_revision" "$manifest_contract"
