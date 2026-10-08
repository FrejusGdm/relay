# Proposal

## Why

On 2026-10-07 Josué decided the business model: relay's core stays free, and a one-time payment buys a lifetime license for the paid features. He also chose Stripe as the payment provider, to be built in Stripe test mode until he adds live keys (`docs/ROADMAP.md`, "Decisions made"). relay needs a way to sell that license, deliver it to the buyer, and check it inside the `relay` program. The check must work without a network connection, because relay exists to keep working when other services fail, and because relay sends no telemetry (`openspec/config.yaml`, "No telemetry"; `docs/research/security.md` section 9).

## What Changes

- Add a **license key**: a short text that holds a license ID, the product name and the issue date, signed with an Ed25519 private key. The key holds no email address, no name and no other personal data. The `relay` program checks the signature with a public key built into the program, without any network access. Source: `docs/research/prior-art-and-pricing.md` section 3.2 ("A design that fits relay").
- Add the command `relay license <activate|status|remove>`. `activate` checks a key and saves it in `RELAY_HOME/license.key`; `status` shows the saved license and the paid features; `remove` deletes the saved key. The list of paid features is one constant, `PAID_FEATURES` in `src/license/features.ts`. It is empty in this change, because which features are paid is still Josué's decision (see "Open questions for Josué").
- Add two exit codes: 50 (the license key is not valid) and 51 (no license is active). This proposal first named 40 and 41; they were renumbered on 2026-10-08 because `add-t3-limit-rules` already uses 40 to 42.
- Add a small server, `license-server/`, that runs as the managed Azure Functions API of the website's Azure Static Web App (the website is proposed in `add-website`). It has three HTTP functions:
  - `POST /api/checkout` creates a Stripe Checkout Session in `payment` mode for one unit of one one-time price, and redirects the buyer to Stripe's hosted payment page.
  - `POST /api/stripe-webhook` receives Stripe's `v1.checkout.session.completed` and `v1.checkout.session.async_payment_succeeded` events, verifies their signature, and runs the fulfillment function.
  - `GET /api/license?session_id=...` runs the same fulfillment function and returns the license key to the buyer's license page.
- The fulfillment function follows Stripe's guide "Fulfill orders": it retrieves the Checkout Session with its line items, issues a key only when the payment status is not `unpaid`, records the result on the PaymentIntent's metadata, and gives the same result however often and however concurrently it runs. The key is computed only from data stored on the Checkout Session, and Ed25519 signatures are deterministic, so a repeated run produces the same key and needs no database. Source: https://docs.stripe.com/checkout/fulfillment.
- Add a license page on the website (`/license/`), which Stripe Checkout redirects to after payment. It shows the key, a copy button and the exact `relay license activate` command. The key is not sent by email in this change.
- Build and test only with Stripe test mode. Automated tests never call Stripe or Azure: they use fake Stripe responses and keys generated at run time. A final test-mode run on a preview environment of the website waits for Josué's Stripe sandbox keys. Live mode waits for Josué's live keys; design.md lists exactly what he must do.
- Add `docs/licensing.md`, which explains the flow with a diagram, the key format, the settings and how to rotate the signing key.

## Capabilities

### New Capabilities

- `license-keys`: the license key format, how the server signs a key, how `relay` verifies it offline, the built-in public key table and signing key IDs.
- `license-command`: the `relay license` command, the saved key file, the `PAID_FEATURES` constant, the messages and the exit codes 50 and 51.
- `license-checkout`: the `POST /api/checkout` function and the exact Checkout Session it creates.
- `license-fulfillment`: the webhook function, the fulfillment function, the `GET /api/license` function, idempotency, and the server settings.
- `license-page`: the website's license page and the buy button.

### Modified Capabilities

None. No specs exist yet in `openspec/specs/`. This change builds on capabilities proposed in `add-cli-scaffold` (`cli-commands`, `relay-config`, `build-and-ci`) and `add-website`. The points where it extends them are listed under Impact.

## Open questions for Josué

This proposal does not decide these. Each one changes a constant or a setting, not the design.

1. **Which features are paid.** `docs/ROADMAP.md` decides that a license unlocks "the paid features" but not which ones. The research lists candidates (automatic failover, use on several machines, a dashboard) and suggests keeping manual switching, checkpoints and rollback free (`docs/research/prior-art-and-pricing.md`, "Decisions only the founder can make", item 2). Until Josué decides, `PAID_FEATURES` is empty and nothing in relay is locked.
2. **The price and currency.** The research mentions founding prices of $79, $119 and $149 (`VISION.md`, "Business"). The price lives only in Stripe, as the price that `RELAY_STRIPE_PRICE_ID` names, and in the website's text. Changing it later only adds a price ID to `RELAY_LICENSE_PRICE_IDS`, so earlier buyers keep their license page.
3. **What "lifetime" covers.** The research describes two meanings: all future updates, or one year of updates with the last version kept forever (section 3.1). This change enforces no expiry. The key holds its issue date, so a later rule such as "covers versions released within 12 months of the issue date" needs no new keys.
4. **Sales tax and VAT.** With plain Stripe, Josué is the seller and owes the tax filings; Stripe Tax needs an active registration before it collects anything, and Stripe Managed Payments is Stripe's merchant of record option (section 3.3). This change turns no tax feature on.
5. **Refunds.** A key is checked offline, so a refund cannot switch it off. The license ID in every key allows a later list of withdrawn license IDs inside relay releases, if Josué wants one.
6. **Email delivery of the key.** This change shows the key on the license page only. Sending it by email needs an email provider (for example Azure Communication Services Email), its own settings and a sender domain.
7. **The product's name on the page and in Stripe.** The notes use "relay Pro". This change uses the product ID `relay-lifetime` inside keys and the words "relay lifetime license" in text until Josué chooses.

## Out of scope

- Live mode. No live key, live product or live webhook endpoint is created by an agent. Josué does these steps himself (design.md, "What Josué must do").
- Creating a Stripe account or sandbox. Agents never create Stripe accounts.
- Choosing the paid features, and locking any feature behind the license. The first change that makes a feature paid adds it to `PAID_FEATURES` and calls the gate described in design decision 9.
- Subscriptions, relay Cloud or Teams, donations and sponsorships.
- Sending email, a customer account area, a "find my key" form, and online license checks or activation limits.
- Revoking keys, refunds and disputes (handled by hand in the Stripe Dashboard).
- Stripe Tax and Stripe Managed Payments.
- The Mac menu-bar app's license view.
- The website's design beyond the license page and the buy button, which `add-website` owns.

## Security

This change handles payment provider keys, a private signing key and a webhook that anyone on the internet can call.

- **Secrets.** The Stripe restricted API key, the webhook signing secret and the Ed25519 private key live only in the Azure Static Web App's application settings, which Azure encrypts at rest, and only in the environment that needs them (test values in the preview environment, live values in production). They are never in the repository, never in logs, never in error messages and never sent to the browser. The server refuses an unrestricted secret key (`sk_`); it accepts only a restricted key (`rk_test_` or `rk_live_`) with the smallest permissions. Stripe recommends a secrets vault such as Azure Key Vault; managed functions cannot use Key Vault references, so design decision 2 explains this trade-off and the upgrade path. Sources: https://docs.stripe.com/keys, https://docs.stripe.com/keys-best-practices, https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions.
- **Webhook verification.** Every webhook request is checked with the Stripe SDK's `parseEventNotification`, using the raw request body, the `Stripe-Signature` header and the endpoint secret, with the SDK's default timestamp tolerance of 300 seconds. A request that fails the check gets status 400 and changes nothing. Source: https://docs.stripe.com/webhooks ("Verify events are sent from Stripe").
- **Replay and duplicates.** A replayed or duplicated event can only repeat the fulfillment function, which retrieves the session from Stripe again and gives the same result. Nothing is issued for a session that is unpaid, not created by relay's checkout function, for another price, or from the other mode (test against live).
- **Key storage on the buyer's computer.** `relay` saves the key in `RELAY_HOME/license.key` with mode 0600, using the same owner and permission checks as `config.toml`. The key is not secret in the way a password is: anyone holding it can use the license, as with any offline license.
- **Test keys never unlock a release.** The public key table built into `relay` holds only live keys. Tests generate their own key pairs at run time and pass them in, and `relay` rejects any key whose signing key ID starts with `test-`.
- **The license link.** The license page's address contains the Checkout Session ID, which acts as the buyer's access to the key. The page and the API response send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the address is not cached or passed to other sites.
- **No telemetry.** `relay license` never opens a network connection. A test proves it.

## Impact

- New files in the `relay` program: `src/license/key.ts`, `src/license/public-keys.ts`, `src/license/features.ts`, `src/license/store.ts`, `src/cli/commands/license.ts`, `test/license/*.test.ts` and `test/cli/golden/license.txt`.
- Changed files from `add-cli-scaffold`, all updated in the same pull request (task 3.2): `src/cli/commands/registry.ts` (the `CommandName` type and a seventeenth entry), `src/cli/exit-codes.ts` (codes 50 and 51), `test/cli/golden/top-help.txt` (one new command row), `test/cli/router.test.ts` (the argument count table), `docs/cli.md` (the command table and the exit-code table) and `docs/first-version-index.md` (the "Commands", "Exit codes", "Source code map" and "Capabilities by change" sections). The `cli-commands` spec of `add-cli-scaffold` lists exactly sixteen commands; when both changes are archived, its requirements "Command set", "Top-level help" and "Argument count checking" gain `license`, with one or two arguments.
- New folder `license-server/`, a separate Bun project that is bundled for Node.js 22 and never compiled into the `relay` binary.
- Changed files from `add-website`: the license page, the buy button, `staticwebapp.config.json` (API runtime and headers) and the deployment step that names the API folder. These tasks start only after `add-website` is merged.
- `.github/workflows/ci.yml` gains one job for `license-server/` (a protected path in the private task board).
- On a buyer's computer: one new file, `RELAY_HOME/license.key`.
