#!/usr/bin/env bash
# Deploys site/public, with the license server in license-server/dist as its API, to the Azure
# Static Web App relay-site, then runs the smoke test.
# Run it on the Omarchy machine: bash site/scripts/deploy.sh [environment]
# Without an environment it deploys to production; with one, for example license-test, it deploys
# to that preview environment and leaves production alone.
# Buying is on in a preview environment and off in production, unless RELAY_LICENSE_BUY=on is set:
# only then does production get the buy form (add-lifetime-license, "What Josué must do").
set -euo pipefail
set +x # tracing would print the deployment token

app=relay-site
group=relay-rg
subscription="Azure subscription 1"
swa_cli=@azure/static-web-apps-cli@2.0.10
environment=${1:-production}
if [ "$environment" = production ]; then buy=${RELAY_LICENSE_BUY:-off}; else buy=on; fi
case "$buy" in on|off) ;; *) echo "deploy: RELAY_LICENSE_BUY must be on or off, not \"$buy\"." >&2; exit 1 ;; esac
export AZURE_CORE_COLLECT_TELEMETRY=false

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

current=$(az account show --query name --output tsv)
if [ "$current" != "$subscription" ]; then
  echo "deploy: the Azure CLI uses \"$current\", not \"$subscription\". Run: az account set --subscription \"$subscription\"" >&2
  exit 1
fi

assets=$(gh release view --repo FrejusGdm/relay --json assets --jq '.assets[].name')
for asset in relay-darwin-arm64 relay-linux-x64; do
  if ! printf '%s\n' "$assets" | grep -qx "$asset"; then
    echo "deploy: the latest release of FrejusGdm/relay has no $asset, so the install commands on the page would fail." >&2
    exit 1
  fi
done

sh site/scripts/fetch-fonts.sh
bun test site/test
# The API is built here and deployed as it is (add-lifetime-license, design decision 12).
(cd license-server && bun install --frozen-lockfile && bun test && bun run build)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
sh site/scripts/build.sh "$build/site" "$buy"

host=$(az staticwebapp show --subscription "$subscription" --name "$app" --resource-group "$group" --query defaultHostname --output tsv)

token=$(az staticwebapp secrets list --subscription "$subscription" --name "$app" --resource-group "$group" --query properties.apiKey --output tsv)
if [ -z "$token" ]; then
  echo "deploy: Azure returned no deployment token for $app." >&2
  exit 1
fi
status=0
output=$(SWA_CLI_DEPLOYMENT_TOKEN="$token" npx --yes "$swa_cli" deploy "$build/site" --env "$environment" \
  --api-location license-server/dist --api-language node --api-version 22 </dev/null 2>&1) || status=$?
case "$output" in
  *"$token"*)
    unset token output
    echo "deploy: the deployment output contained the deployment token, so it is not shown. Replace the token now: az staticwebapp secrets reset-api-key --name $app --resource-group $group" >&2
    exit 1
    ;;
esac
unset token
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  echo "deploy: swa deploy failed with exit code $status." >&2
  exit "$status"
fi

if [ "$environment" != production ]; then
  # Azure keeps only the letters and digits of a preview environment's name: license-test becomes licensetest.
  name=$(printf '%s' "$environment" | tr -cd 'A-Za-z0-9')
  host=$(az staticwebapp environment list --subscription "$subscription" --name "$app" --resource-group "$group" \
    --query "[?name=='$name'].hostname | [0]" --output tsv)
  [ -n "$host" ] || { echo "deploy: Azure lists no environment named $name." >&2; exit 1; }
fi
sh site/scripts/smoke-test.sh "https://$host" "$buy"
echo "Deployed: https://$host"
