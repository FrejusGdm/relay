#!/bin/sh
# The local runtime smoke test (add-lifetime-license, task 5.3). Builds the bundle and starts it in
# Azure Functions Core Tools on Node.js 22, with a test signing key and no Stripe values, then checks
# three answers that end before any Stripe call. Run it in license-server/: sh scripts/smoke.sh
set -eu
port=7101
core_tools=azure-functions-core-tools@4.15.2
cd "$(dirname "$0")/.."
export npm_config_cache="$HOME/.cache/npm"
work=$(mktemp -d)
host_pid=

cleanup() {
  # Core Tools starts its own child processes; the host runs in its own process group, which is
  # stopped as a whole.
  if [ -n "$host_pid" ]; then
    kill -TERM -- "-$host_pid" 2>/dev/null || true
    waited=0
    while kill -0 -- "-$host_pid" 2>/dev/null && [ "$waited" -lt 20 ]; do sleep 0.5; waited=$((waited + 1)); done
  fi
  rm -f dist/local.settings.json
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "License server smoke test failed: $1" >&2; [ -f "$work/host.log" ] && tail -n 40 "$work/host.log" >&2; exit 1; }

bun run build >/dev/null
keygen="$(pwd)/scripts/keygen.ts"
(cd "$work" && bun "$keygen" test-1 >/dev/null 2>&1) || fail "keygen.ts did not create a test key"
signing_key=$(cat "$work/test-1.signing-key")
umask 077
cat > dist/local.settings.json <<SETTINGS
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "RELAY_LICENSE_KEY_ID": "test-1",
    "RELAY_LICENSE_SIGNING_KEY": "$signing_key"
  }
}
SETTINGS
unset signing_key

# Node.js 22 first in PATH: on the build machine "mise exec node@22" leaves the system Node.js first,
# and Core Tools runs its first-time setup with whichever node it finds.
node22="$(mise where node@22)/bin"
(cd dist && PATH="$node22:$PATH" exec setsid npx -y "$core_tools" start --port "$port") > "$work/host.log" 2>&1 &
host_pid=$!

tries=0
until curl -s -o /dev/null "http://localhost:$port/api/license"; do
  tries=$((tries + 1))
  [ "$tries" -le 180 ] || fail "the Functions host did not answer on port $port within 3 minutes"
  kill -0 "$host_pid" 2>/dev/null || fail "the Functions host stopped"
  sleep 1
done

webhook=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$port/api/stripe-webhook")
[ "$webhook" = 503 ] || fail "POST /api/stripe-webhook answered $webhook, expected 503"
license=$(curl -s "http://localhost:$port/api/license?session_id=x")
[ "$license" = '{"error":"not_configured"}' ] || fail "GET /api/license answered $license"
checkout=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$port/api/checkout")
[ "$checkout" = 503 ] || fail "POST /api/checkout answered $checkout, expected 503"
echo "License server smoke test passed."
