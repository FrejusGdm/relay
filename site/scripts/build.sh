#!/bin/sh
# Copies site/public to <output folder> for deployment. With "on", it replaces the paid column of
# the pricing section, between <!-- buy:start ... --> and <!-- buy:end --> in index.html, with
# site/buy-section.html: the buy form that posts to /api/checkout. With "off" the copy is
# site/public as it is, without a buy form (add-lifetime-license).
# Usage: sh site/scripts/build.sh <output folder> <on|off>
set -eu
out=${1:?usage: build.sh <output folder> <on|off>}
buy=${2:?usage: build.sh <output folder> <on|off>}
site=$(cd "$(dirname "$0")/.." && pwd)
case "$buy" in on|off) ;; *) echo "build: the second argument must be on or off, not \"$buy\"." >&2; exit 2 ;; esac

rm -rf "$out"
mkdir -p "$out"
cp -R "$site/public/." "$out/"
index="$out/index.html"
starts=$(grep -c '<!-- buy:start' "$index" || true)
ends=$(grep -c '<!-- buy:end -->' "$index" || true)
if [ "$starts" != 1 ] || [ "$ends" != 1 ]; then
  echo "build: index.html must have exactly one buy:start and one buy:end marker." >&2
  exit 1
fi
if [ "$buy" = on ]; then
  awk -v fragment="$site/buy-section.html" '
    /<!-- buy:start/ { while ((getline line < fragment) > 0) print line; skip = 1; next }
    /<!-- buy:end -->/ { skip = 0; next }
    !skip { print }
  ' "$index" > "$index.new"
  mv "$index.new" "$index"
fi
echo "Built the site in $out with buying $buy."
