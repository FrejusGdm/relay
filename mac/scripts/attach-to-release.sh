#!/bin/sh
# Attaches Relay-macOS.zip to an existing GitHub Release, for example
# `sh mac/scripts/attach-to-release.sh v0.8.0`. The zip comes from the successful `mac-app.yml`
# run that built the tag (design.md decision 15); its version must be the tag's number. Needs gh,
# signed in with permission to upload release assets. Runs on macOS or Linux.
set -eu
tag="${1:-}"
case "$tag" in
  v[0-9]*) ;;
  *) echo "Usage: sh mac/scripts/attach-to-release.sh v0.8.0"; exit 2 ;;
esac
version="${tag#v}"
case "$version" in
  *[!0-9.]* | .* | *. | *..*) echo "The tag must look like v0.8.0, got: $tag"; exit 2 ;;
esac
repo="${RELAY_REPO:-FrejusGdm/relay}"

gh release view "$tag" --repo "$repo" > /dev/null
sha=$(gh api "repos/$repo/commits/$tag" --jq .sha)
run=$(gh run list --repo "$repo" --workflow mac-app.yml --commit "$sha" --status success \
  --json databaseId,headBranch --jq "[.[] | select(.headBranch == \"$tag\")][0].databaseId // empty")
if [ -z "$run" ]; then
  echo "No successful Mac app run built $tag ($sha). Pushing the tag starts one; wait for it, or start it with:"
  echo "  gh workflow run mac-app.yml --repo $repo --ref $tag -f version=$version"
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/relay-attach-XXXXXX")
trap 'rm -rf "$work"' EXIT
gh run download "$run" --repo "$repo" --name Relay-macOS --dir "$work"
unzip -q "$work/Relay-macOS.zip" Relay.app/Contents/Info.plist -d "$work/check"
built=$(sed -n '/<key>CFBundleShortVersionString<\/key>/{s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$work/check/Relay.app/Contents/Info.plist")
if [ "$built" != "$version" ]; then
  echo "Run $run built version $built, not $version. Nothing was uploaded."
  exit 1
fi
gh release upload "$tag" "$work/Relay-macOS.zip" --repo "$repo" --clobber
echo "Attached Relay-macOS.zip (version $version, run $run) to $tag"
