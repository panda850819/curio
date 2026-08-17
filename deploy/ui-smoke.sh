#!/usr/bin/env bash
set -euo pipefail

paths=(/ /subscriptions /subscriptions/new /destinations /deliveries)

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
image=${CURIO_IMAGE:-}
if [[ -z "$image" ]]; then
  image=$(docker inspect --format '{{.Config.Image}}' curio-curio-1 2>/dev/null || true)
fi
: "${image:=curio/server:local}"

docker run --rm --network "$network" "$image" bun -e '
const paths = ["/", "/subscriptions", "/subscriptions/new", "/destinations", "/deliveries"];
let cookie = "";
for (const path of paths) {
  const response = await fetch(`http://curio:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (!body.includes("id=\\"main-content\\"")) throw new Error(`${path}: missing main content`);
  if (!body.includes("Curio")) throw new Error(`${path}: missing Curio marker`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
}
console.log("curio_ui_smoke_ok");
'
