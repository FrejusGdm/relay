#!/bin/sh
# Builds relay for this computer with the release flags and checks that the program contains no
# fake agent: the test fakes must never ship (add-provider-adapters, design decision 17).
set -eu
cd "$(dirname "$0")/.."
bun build ./src/cli/main.ts --compile --minify --sourcemap --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig --outfile=dist/relay
found=$(strings dist/relay | grep -E 'fake-claude|fake-codex|RELAY_FAKE_SCENARIO' || true)
if [ -n "$found" ]; then
  echo "dist/relay contains test-only fake agent text:"
  printf '%s\n' "$found" | head -n 5
  exit 1
fi
echo "Release check passed: dist/relay contains no fake agent."
