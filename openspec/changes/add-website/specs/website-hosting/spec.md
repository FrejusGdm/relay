# Spec Delta

## Purpose

Defines where the website is hosted, how it is deployed from the Omarchy machine without exposing the deployment token, and how the live address is checked after each deployment.

## ADDED Requirements

### Requirement: Azure resources
The website SHALL be hosted on one Azure Static Web App named `relay-site`, on the Free plan, in the resource group `relay-rg`, in the subscription "Azure subscription 1", in the region `eastus2`. Every resource in `relay-rg`, and the group itself, SHALL have the tag `project=relay`. The app SHALL have no connection to a source repository.

#### Scenario: Resource check
- **WHEN** `az staticwebapp show --subscription "Azure subscription 1" --name relay-site --resource-group relay-rg --query "[sku.name, tags.project]" --output tsv` runs
- **THEN** it prints `Free` and `relay`

#### Scenario: Every resource tagged
- **WHEN** `az resource list --subscription "Azure subscription 1" --resource-group relay-rg --query "[?tags.project!='relay'].id" --output tsv` runs
- **THEN** it prints nothing

#### Scenario: No repository connection
- **WHEN** `az staticwebapp show --subscription "Azure subscription 1" --name relay-site --resource-group relay-rg --query repositoryUrl --output tsv` runs
- **THEN** it prints nothing

### Requirement: Deployment from the Omarchy machine
The website SHALL be deployed only by `site/scripts/deploy.sh`, run by hand on the Omarchy machine. Before deploying, the script SHALL check that the Azure CLI uses "Azure subscription 1", that the latest release of `FrejusGdm/relay` has the assets `relay-darwin-arm64` and `relay-linux-x64` (not `Relay-macOS.zip`, because the Mac app block shows a "not released yet" note until a release contains it), that the fonts download with matching hashes, and that `bun test site/test` passes. Any failed check SHALL stop the script before anything is deployed. The script SHALL deploy `site/public` to the production environment with `swa deploy` from `@azure/static-web-apps-cli` version 2.0.10.

#### Scenario: Wrong subscription
- **WHEN** the Azure CLI's current subscription is not "Azure subscription 1" and the script runs
- **THEN** it prints the `az account set` command to run and exits with code 1 without deploying

#### Scenario: Missing release asset
- **WHEN** the latest release lacks `relay-linux-x64`
- **THEN** the script says that the install commands on the page would fail and exits with code 1 without deploying

### Requirement: The deployment token stays secret
The deployment token SHALL be read with `az staticwebapp secrets list` into a shell variable and passed to `swa deploy` only through `SWA_CLI_DEPLOYMENT_TOKEN` for that one command. It SHALL NOT be printed, written to a file, committed or stored in GitHub. The script SHALL turn shell tracing off, SHALL keep the deployment output in memory, SHALL check it for the token and, if it is there, SHALL NOT show the output and SHALL tell the person to reset the token with `az staticwebapp secrets reset-api-key`.

#### Scenario: Normal deployment
- **WHEN** `bash site/scripts/deploy.sh` succeeds
- **THEN** the token appears nowhere in its output
- **AND** the script writes neither the token nor the deployment output to any file

#### Scenario: Token in the output
- **WHEN** the deployment output contains the token
- **THEN** the script shows only the reset instruction and exits with code 1

### Requirement: Smoke test of the live address
After every deployment, `site/scripts/smoke-test.sh https://<address>` SHALL pass. It SHALL check that the home page answers 200, has the title `relay: never run out of limits again` and contains the install commands with the asset names `relay-darwin-arm64` and `relay-linux-x64` (the Mac app block shows a "not released yet" note until a release contains `Relay-macOS.zip`); that the response has the exact Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options` and `X-Robots-Tag` headers and no `Set-Cookie`; that `/fonts/Satoshi-Variable.woff2` answers 200 as `font/woff2`; that `/.auth/login/github` answers 404; and that `/no-such-page` answers 404 with the text `Page not found`.

#### Scenario: Live site
- **WHEN** `sh site/scripts/smoke-test.sh https://<address>` runs after a deployment
- **THEN** it prints `Smoke test passed: https://<address>` and exits with code 0

#### Scenario: Wrong site
- **WHEN** the smoke test runs against an address that does not serve the relay website
- **THEN** it prints a line starting with `Smoke test failed:` and exits with a non-zero code

### Requirement: Live screenshots
After the first deployment and after every deployment that changes the page, the Playwright tests SHALL run against the live address with `SITE_URL` set, and the screenshots `live-1440.png`, `live-1024.png` and `live-390.png` SHALL be attached to the pull request.

#### Scenario: Live run
- **WHEN** `SITE_URL=https://<address> bun run site:e2e` runs on the Omarchy machine
- **THEN** every test passes and `site/e2e/out/` holds the three `live-` screenshots
