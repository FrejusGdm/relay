#!/bin/sh
# Checks the bundle, then starts the app with a RELAY_HOME whose run/ folder exists and is empty,
# checks it is still running after 5 seconds and has no network sockets open.
set -eu
app="$1"
plutil -lint "$app/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$app/Contents/Info.plist")" = "true" ]
[ "$(lipo -archs "$app/Contents/MacOS/Relay")" = "arm64" ]
codesign --verify --strict --verbose=2 "$app"
tmp=$(mktemp -d /tmp/relay-smoke-XXXXXX)
mkdir -m 700 -p "$tmp/home/run"
RELAY_HOME="$tmp/home" "$app/Contents/MacOS/Relay" &
pid=$!
sleep 5
if ! kill -0 "$pid" 2>/dev/null; then
  echo "relay exited within 5 seconds"; exit 1
fi
network=$(lsof -a -p "$pid" -i || true)
kill "$pid"; wait "$pid" 2>/dev/null || true; rm -rf "$tmp"
if [ -n "$network" ]; then
  echo "relay opened network sockets:"; echo "$network"; exit 1
fi
echo "Smoke test passed: $app"
