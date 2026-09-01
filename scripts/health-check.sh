#!/usr/bin/env bash
#
# Assert that a deployed environment is up and its database reachable.
#
# /health returns {"ok":true,"register":true,"store":true}: the register answered,
# and a store belonging to no account was opened and brought up to date
# (architecture, "Observability"). Both halves matter here — an account's data
# lives in its own store, so a check on the register alone would pass this
# assertion while every real request to the deployment failed.
#
# It must stay reachable *without* Cloudflare Access, because two things depend on
# reaching it unauthenticated: this post-deploy check, and the external uptime
# monitor that is the only observability layer not running on the app's own code.
# docs/deployment.md's "`/health` must stay outside the gate" records the Bypass
# policy that keeps it open.
#
# If Access ever does gate it, curl receives an HTML login page instead of JSON.
# That is a configuration error with a specific fix, so it is detected and named
# rather than surfacing as a mysterious failed promotion.
#
# Usage: health-check.sh <base-url>
set -uo pipefail

base="${1:?usage: health-check.sh <base-url>}"
endpoint="${base%/}/health"

body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT

# No -L: a redirect is a signal here, not something to follow.
code=$(curl -sS --max-time 20 --retry 3 --retry-delay 5 \
  -o "$body_file" -w '%{http_code}' "$endpoint" || echo '000')
body=$(tr -d '\r' < "$body_file")

echo "GET $endpoint -> $code"

case "$code" in
  200) ;;
  30[1237])
    echo "::error::$endpoint redirected ($code). /health must be reachable without Cloudflare Access: add a Bypass policy scoped to the /health path (docs/deployment.md, \"\`/health\` must stay outside the gate\"). The uptime monitor in architecture's Observability section depends on this too."
    exit 1
    ;;
  000)
    echo "::error::$endpoint was unreachable (DNS, TLS, or timeout)."
    exit 1
    ;;
  *)
    echo "::error::$endpoint returned $code"
    printf '%s\n' "$body" | head -5
    exit 1
    ;;
esac

# A 200 that is not our JSON means something answered in front of the Worker.
if ! printf '%s' "$body" | grep -q '"ok":true'; then
  echo "::error::$endpoint returned 200 but not a healthy body. Either the register is unreachable, or an account store could not be opened or brought up to date (the reason is in the Worker's logs, never in this body), or something (an Access login page, a cached error) answered instead of the Worker."
  printf '%s\n' "$body" | head -5
  exit 1
fi

echo "healthy: $body"
