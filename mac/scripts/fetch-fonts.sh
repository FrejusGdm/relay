#!/bin/sh
# Runs on macOS. Downloads the fonts named in DESIGN.md from their official sources into mac/Resources/Fonts and
# checks each file against its SHA-256 before copying it (mac/Resources/Fonts/SOURCES.md).
# Font files are never committed: the Satoshi license forbids sharing them through a repository.
set -eu
cd "$(dirname "$0")/.."
dest=Resources/Fonts
tmp=$(mktemp -d "${TMPDIR:-/tmp}/relay-fonts-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# fetch <address of the zip file> <folder name>
fetch() {
  curl -fsSL --retry 3 -o "$tmp/$2.zip" "$1"
  mkdir "$tmp/$2"
  unzip -q "$tmp/$2.zip" -d "$tmp/$2"
}

# take <folder name> <path inside the zip file> <name in Resources/Fonts> <SHA-256>
take() {
  (cd "$tmp/$1" && echo "$4  $2" | shasum -a 256 --check --strict)
  cp "$tmp/$1/$2" "$dest/$3"
}

fetch https://api.fontshare.com/v2/fonts/download/satoshi satoshi
fetch https://github.com/uswds/public-sans/releases/download/v2.001/public-sans-v2.001.zip public-sans
fetch https://github.com/IBM/plex/releases/download/%40ibm/plex-mono%402.5.0/ibm-plex-mono.zip plex-mono

take satoshi Satoshi_Complete/Fonts/OTF/Satoshi-Bold.otf Satoshi-Bold.otf 50e4f9b7c1864c50761d729d6001bfac708c80457fa6fc41559a8ab1bd2573ff
take satoshi Satoshi_Complete/License/FFL.txt Satoshi-LICENSE.txt 145e7fe2429a3336ba215c070ef722000e01348a3e1baaa127e871bb5012f554
take public-sans fonts/otf/PublicSans-Regular.otf PublicSans-Regular.otf 89cca4915bd88489323ad0d0107f7cd1dc81164416584f3c3c6da00e187cd581
take public-sans fonts/otf/PublicSans-Medium.otf PublicSans-Medium.otf dd903e97179c1e8293a30f2a50474819cac10ab18579aa5f1b63cb72f23a50dc
take public-sans fonts/otf/PublicSans-SemiBold.otf PublicSans-SemiBold.otf 57af521ce5bc5a3495293f83051765c32d45d04696218bf0cff2ac66a65ba849
take public-sans OFL.txt PublicSans-LICENSE.txt 157a9e77f7580246e97c769490e2e977ae94399f9d30f4556015c41fe8c28bac
take plex-mono ibm-plex-mono/fonts/complete/otf/IBMPlexMono-Regular.otf IBMPlexMono-Regular.otf 372fe8f8a459baef84ee346b0a478084e80c46bd299a0c27bcb0f3412f5a9d28
take plex-mono ibm-plex-mono/fonts/complete/otf/IBMPlexMono-Medium.otf IBMPlexMono-Medium.otf f7db820bddfbf7fce52946e69fee89a150938d401d82850cdf975b2c4c31b97b
take plex-mono ibm-plex-mono/LICENSE.txt IBMPlexMono-LICENSE.txt 7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da
echo "Fonts ready in mac/$dest"
