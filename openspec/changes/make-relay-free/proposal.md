# Proposal

Approved by Josué in chat on 2026-10-09.

## Why

On 2026-10-07 Josué chose a one-time lifetime license for paid features, and `add-lifetime-license` built it in Stripe test mode: the `relay license` command, an offline key check, a license server for the website's API, a buy form and a license page. No feature was ever locked, and no live key exists. On 2026-10-09 Josué decided that relay is free, in his words: "let's make it all free and not gatekeep something". Nothing is paid and nothing is locked, so the license system has no purpose and only adds code, settings and a server to maintain. Source: Josué in chat, 2026-10-09; `docs/ROADMAP.md`, "Decisions made".

For the website he asked for a playful price: show "$19.99", then an underlined line saying it is a joke, then that relay is free and open source. On 2026-10-10 he also asked for a link to the GitHub repository with its star count in the navigation, as open-source projects usually have.

## What Changes

- **Remove the license from the `relay` program.** Delete `src/cli/commands/license.ts`, its entry in the command registry and its help line, `src/license/`, the `licensePublicKeys` field of the command context, and every license test. `relay` then has sixteen commands. Remove the exit codes 50 (`LicenseInvalid`) and 51 (`LicenseMissing`); every other exit code keeps its number, and the reserved row of `docs/cli.md` says that 50 and 51 are free again.
- **Remove the license server.** Delete `license-server/`, the `license-server` job of `.github/workflows/ci.yml` and the security job's step that audited the license server's dependencies (that step would fail without the folder), the `bunfig.toml` entry that kept the folder out of `bun test`, the `tsconfig.json` exclusion and the two `.gitignore` lines for the signing key and the server's build output.
- **Remove the buying parts of the website.** Delete the buy section (`site/buy-section.html`), the switch that added it (`site/scripts/build.sh` and its test), the `/license/` page and its script and styles, the `/license*` route, the `apiRuntime` platform setting, and the deployment of an API. The Content-Security-Policy goes back to `form-action 'none'`, which `add-website` designed; the policy never had `connect-src` outside the license page. `site/scripts/deploy.sh`, `site/scripts/smoke-test.sh` and `site/playwright.config.ts` go back to their versions before `add-lifetime-license`, so the deploy script deploys `site/public` to production only, as `add-website` designed.
- **Add the free pricing note.** The pricing section gets the heading "What relay costs." and one small box: the joke price `$19.99`, the underlined line "I’m joking.", then "relay is free and open source." and "You already paid for the agents." It uses only the existing fonts and colour tokens and works in the light and dark themes. The site's file tests and browser tests check the note, check that no buy form or license link exists, and save screenshots of the note in both themes.
- **Add a GitHub link with the star count.** The navigation gets the GitHub mark (Octicons `mark-github-16`, MIT License, credited in a comment) and the star count beside "Get relay", following the pattern of shadcn/ui's header: a quiet button with the mark and a short count such as `1.2k`. A new `site/public/github.js` reads the count from GitHub's public API without cookies or referrer, keeps it in `localStorage` for an hour, and shows no number when the request fails or the repository is private. The width of the count is kept free so nothing moves, and phones show the mark only. The Content-Security-Policy gains `connect-src https://api.github.com` and nothing else.
- **Update the documents.** Delete `docs/licensing.md`. Update `README.md` (relay is free and open source, with no paid features; Josué also asked on 2026-10-09 for the line "Early preview, built and maintained by one person; expect rough edges." under the first description, merged with the existing status line), the business section of `VISION.md`, the decision log of `docs/ROADMAP.md`, `docs/cli.md`, `docs/website.md`, `docs/architecture.md`, `docs/progress.md`, `docs/codebase-map.md` and `docs/first-version-index.md`.
- **Withdraw `add-lifetime-license`.** Move it to `openspec/changes/archive/2026-10-09-add-lifetime-license/` without applying its specs, with a line at the top of its proposal that says it was withdrawn.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `website-pages` (from `add-website`): the section list names the new pricing heading, the requirement "Pricing copy without a checkout" is removed, and the requirements "Free pricing note" and "GitHub link with the star count" are added.
- `website-security` (from `add-website`): the Content-Security-Policy allows `connect-src https://api.github.com`, and the storage and network rule allows `github.js`'s one request and its one `localStorage` entry.
- `license-keys`, `license-command`, `license-checkout`, `license-fulfillment` and `license-page` (from the withdrawn `add-lifetime-license`): every requirement is removed. These capabilities were never archived into `openspec/specs/`, so the removals record the decision rather than change a main spec.

## Out of scope

- Azure and Stripe accounts. This change does not run the deploy script and does not touch the Azure preview environment or the Stripe sandbox; Josué removes the preview environment himself.
- Any other change to the website's design. The other website work in progress keeps its own pull request.
- Donations, sponsorships and cloud features.
- The research in `docs/research/`, which records what was known when it was written.

## Security

Most of the change removes code. Removing the license server removes the only server-side code relay had and its Stripe secret settings. The website's Content-Security-Policy goes back to `form-action 'none'`, and the `/license*` route with its own policy disappears. The one addition is the star count: a visitor's browser asks `api.github.com` for public data at most once an hour, so GitHub sees the visitor's address, as it does for any page that shows a GitHub count. The request carries no cookie and no referrer, the policy allows only that host, and the answer is shown as text, never as HTML. No secret is committed; the license tests that built fake keys at run time are deleted with the code they tested.
