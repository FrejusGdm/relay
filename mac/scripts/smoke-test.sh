#!/bin/sh
# Checks the bundle, then starts the app with an empty RELAY_HOME and checks it is still running after 5 seconds.
set -eu
app="$1"
plutil -lint "$app/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$app/Contents/Info.plist")" = "true" ]
[ "$(lipo -archs "$app/Contents/MacOS/Relay")" = "arm64" ]
codesign --verify --strict --verbose=2 "$app"
tmp=$(mktemp -d /tmp/relay-smoke-XXXXXX)
RELAY_HOME="$tmp/home" "$app/Contents/MacOS/Relay" &
pid=$!
sleep 5
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"; wait "$pid" 2>/dev/null || true; rm -rf "$tmp"
  echo "Smoke test passed: $app"
else
  echo "relay exited within 5 seconds"; exit 1
fi
