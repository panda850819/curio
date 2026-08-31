#!/usr/bin/env bash
set -euo pipefail

paths=(/ /reader /subscriptions /subscriptions/new /destinations /deliveries)
root=${CURIO_ROOT:-/opt/curio}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -f "$root/release-manifest.env" || -L "$root/release-manifest.env" ]]; then
  echo "UI smoke requires a forward release target manifest" >&2
  exit 1
fi
release_values=$("$script_dir/release-values.sh" "$root")
IFS=$'\t' read -r image manifest_image_id _ _ _ <<< "$release_values"

if [[ -n "${CURIO_UI_BASE_URL:-}" ]]; then
  cookie_file=$(mktemp)
  trap 'rm -f "$cookie_file"' EXIT
  for path in "${paths[@]}"; do
    body=$(curl --silent --show-error --fail --cookie-jar "$cookie_file" \
      --cookie "$cookie_file" "${CURIO_UI_BASE_URL%/}${path}")
    grep -q 'id="main-content"' <<<"$body"
    grep -q 'Curio' <<<"$body"
  done
  echo "curio_ui_smoke_ok"
  exit 0
fi

network=${CURIO_NETWORK:-personal-infra_private}
compose_image=$(docker compose --env-file "$root/.env" -f "$root/compose.yaml" config --images | awk 'NF { if (found) exit 2; found=1; value=$0 } END { if (found) print value }') || {
  echo "UI smoke Compose image list is invalid" >&2
  exit 1
}
if [[ "$compose_image" != "$image" ]]; then
  echo "UI smoke Compose image does not match the release target" >&2
  exit 1
fi
image_id=$(docker image inspect "$image" --format '{{.Id}}')
if [[ "$image_id" != "$manifest_image_id" ]]; then
  echo "UI smoke image ID mismatch with the release target" >&2
  exit 1
fi

docker run --rm --network "$network" "$image" bun -e '
const paths = ["/", "/reader", "/subscriptions", "/subscriptions/new", "/destinations", "/deliveries"];
let cookie = "";
for (const path of paths) {
  const response = await fetch(`http://curio:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (!body.includes(`id="main-content"`)) throw new Error(`${path}: missing main content`);
  if (!body.includes("Curio")) throw new Error(`${path}: missing Curio marker`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
}
console.log("curio_ui_smoke_ok");
'
