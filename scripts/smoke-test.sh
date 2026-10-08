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
set +e; (cd "$tmp/project" && "$bin" status 2>/dev/null); code=$?; set -e
[ "$code" -eq 69 ] || { echo "Expected exit 69 from status, got $code"; exit 1; }
[ -f "$RELAY_HOME/logs/cli.log" ] || { echo "No log written"; exit 1; }
echo "Smoke test passed: $1"
