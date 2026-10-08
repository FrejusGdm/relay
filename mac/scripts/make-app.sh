#!/bin/sh
# Builds mac/build/Relay.app and mac/build/Relay-macOS.zip. Runs on macOS only.
set -eu
version="$1"
build="${2:-1}"
case "$version" in
  *[!0-9.]* | "" | .* | *. | *..*) echo "Version must look like 0.8.0, got: $version"; exit 2 ;;
esac
cd "$(dirname "$0")/.."
swift build -c release --product Relay
bin="$(swift build -c release --show-bin-path)/Relay"
app=build/Relay.app
rm -rf build
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Fonts"
cp "$bin" "$app/Contents/MacOS/Relay"
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build/" Support/Info.plist > "$app/Contents/Info.plist"
cp Resources/Fonts/*.otf Resources/Fonts/*.ttf Resources/Fonts/*-LICENSE.txt "$app/Contents/Resources/Fonts/" 2>/dev/null || true
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$app"
codesign --verify --strict --verbose=2 "$app"
(cd build && ditto -c -k --keepParent Relay.app Relay-macOS.zip)
echo "Built mac/build/Relay-macOS.zip"
