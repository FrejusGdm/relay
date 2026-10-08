# Tasks

Edit on the Mac, but install, build and test on the build machine (`AGENTS.md`, `jstack-remote-build` skill). Every command below runs in the repository root on the build machine, after `export TMPDIR=$HOME/.cache/tmp-bp; eval "$(mise env -s bash -C ~)"`. The whole change is one pull request.

## 1. The relay program

- [x] 1.1 Delete `src/cli/commands/license.ts`, `src/license/`, `test/license/`, `test/cli/license.test.ts` and `test/cli/golden/license.txt`. Remove the `license` entry, its handler and the `licensePublicKeys` field from `src/cli/commands/registry.ts`, `src/cli/run.ts` and `test/helpers/cli.ts`, the help line from `test/cli/golden/top-help.txt`, and `LicenseInvalid` and `LicenseMissing` from `src/cli/exit-codes.ts`. Change the command count test in `test/cli/router.test.ts` to sixteen. Remove the license rows from `docs/cli.md` and say in its reserved row that 50 and 51 are free again. Verify: `bun run typecheck` passes, `bun run test` reports 0 failures, and `grep -rn -E "src/license|PAID_FEATURES|LicenseInvalid|LicenseMissing|licensePublicKeys" src test` prints nothing.

## 2. The license server

- [x] 2.1 Delete `license-server/`. Remove the `license-server` job and the security job's "Audit the license server's dependencies" step from `.github/workflows/ci.yml`, changing nothing else in the file. Remove the license-server entries from `bunfig.toml`, `tsconfig.json` and `.gitignore`. Verify: `grep -rn license-server .github bunfig.toml tsconfig.json .gitignore` prints nothing, and `grep -cE 'uses: [^@ ]+@[0-9a-f]{40} # v[0-9]' .github/workflows/ci.yml` prints the same count as on `main` minus 2.

## 3. The website

- [x] 3.1 Delete `site/buy-section.html`, `site/scripts/build.sh`, `site/test/build.test.ts` and `site/public/license/`, and the license page styles in `site/public/styles.css`. Restore `site/public/staticwebapp.config.json`, `site/scripts/deploy.sh`, `site/scripts/smoke-test.sh`, `site/playwright.config.ts`, `site/test/config.test.ts` and `site/test/static.test.ts` to their versions before `add-lifetime-license`. Verify: `bun test site/test` passes, and `grep -rn -i -E "checkout|stripe|apiRuntime|/license" site/public` prints nothing.
- [x] 3.2 Replace the pricing section with the free pricing note (`website-pages`, "Free pricing note") and its styles, using only existing tokens. Update `site/test/content.test.ts` and add the browser test `the joke price, then the free note, in both themes` at 1440 and 390 pixels to `site/e2e/site.pw.ts`. Verify: `bun test site/test` passes, `SITE_PORT=<free port> bun run site:e2e` passes, and `site/e2e/out/` holds `local-pricing-light-<width>.png` and `local-pricing-dark-<width>.png` for 1440 and 390. Attach the 1440 screenshots to the pull request.

## 4. Documents and the withdrawn change

- [x] 4.1 Delete `docs/licensing.md`. Update `README.md`, `VISION.md`, `docs/ROADMAP.md` (the dated row "2026-10-09 | relay is free: no paid features and no license. The add-lifetime-license change is withdrawn."), `docs/website.md`, `docs/architecture.md`, `docs/progress.md`, `docs/codebase-map.md` and `docs/first-version-index.md`. Move `openspec/changes/add-lifetime-license` to `openspec/changes/archive/2026-10-09-add-lifetime-license` and add the withdrawal line at the top of its `proposal.md`. Verify: `openspec validate make-relay-free` passes, and `grep -rn -i -E "license key|relay license|stripe|PAID_FEATURES|lifetime|buy" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=archive --exclude-dir=research` lists only lines that say the license was removed or withdrawn, the joke-price tests, other changes' history, and test secrets named `STRIPE_SECRET_KEY`.
