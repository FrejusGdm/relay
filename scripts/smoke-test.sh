#!/bin/sh
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
want="relay $2"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export RELAY_HOME="$tmp/relay-home"
[ "$("$bin" --version)" = "$want" ] || { echo "Wrong version output"; exit 1; }
"$bin" --help >/dev/null
mkdir "$tmp/project" && printf 'RELAY_LOG_LEVEL=loud\n' > "$tmp/project/.env"
# The program must not read .env: if it did, RELAY_LOG_LEVEL=loud would make it exit 78.
set +e; (cd "$tmp/project" && "$bin" policy show claude >/dev/null 2>&1); code=$?; set -e
[ "$code" -eq 0 ] || { echo "Expected exit 0 from policy show, got $code"; exit 1; }
[ -f "$RELAY_HOME/logs/cli.log" ] || { echo "No log written"; exit 1; }
echo "Smoke test passed: $1"
