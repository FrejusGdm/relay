#!/usr/bin/env bash
# Deploys site/public to the Azure Static Web App relay-site, then runs the smoke test.
# Run it on the Omarchy machine: bash site/scripts/deploy.sh
set -euo pipefail
set +x # tracing would print the deployment token

app=relay-site
group=relay-rg
subscription="Azure subscription 1"
swa_cli=@azure/static-web-apps-cli@2.0.10
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

host=$(az staticwebapp show --subscription "$subscription" --name "$app" --resource-group "$group" --query defaultHostname --output tsv)

token=$(az staticwebapp secrets list --subscription "$subscription" --name "$app" --resource-group "$group" --query properties.apiKey --output tsv)
if [ -z "$token" ]; then
  echo "deploy: Azure returned no deployment token for $app." >&2
  exit 1
fi
status=0
output=$(SWA_CLI_DEPLOYMENT_TOKEN="$token" npx --yes "$swa_cli" deploy site/public --env production </dev/null 2>&1) || status=$?
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

sh site/scripts/smoke-test.sh "https://$host"
echo "Deployed: https://$host"
