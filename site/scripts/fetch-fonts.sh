#!/bin/sh
# Downloads the website's fonts into site/public/fonts and checks their SHA-256.
# Run it on the Omarchy machine. It needs gh (signed in), curl, unzip and sha256sum.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh release download v2.001 --repo uswds/public-sans --pattern public-sans-v2.001.zip --dir "$work"
gh release download "@ibm/plex-mono@2.5.0" --repo IBM/plex --pattern ibm-plex-mono.zip --dir "$work"
curl -fsSL -o "$work/satoshi.zip" https://api.fontshare.com/v2/fonts/download/satoshi

mkdir "$work/fonts"
unzip -q -j "$work/public-sans-v2.001.zip" -d "$work/fonts" \
  fonts/webfonts/PublicSans-Regular.woff2 \
  fonts/webfonts/PublicSans-Medium.woff2 \
  fonts/webfonts/PublicSans-SemiBold.woff2
unzip -q -j "$work/ibm-plex-mono.zip" -d "$work/fonts" \
  ibm-plex-mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2 \
  ibm-plex-mono/fonts/complete/woff2/IBMPlexMono-Medium.woff2
unzip -q -j "$work/satoshi.zip" -d "$work/fonts" \
  Satoshi_Complete/Fonts/WEB/fonts/Satoshi-Variable.woff2

(cd "$work/fonts" && sha256sum --check --strict "$root/site/fonts.sha256")
mkdir -p "$root/site/public/fonts"
cp "$work"/fonts/*.woff2 "$root/site/public/fonts/"
