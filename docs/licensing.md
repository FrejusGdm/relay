# The relay license

relay's core is free and stays free. A one-time payment buys a lifetime license for the paid
features. This page explains how the license is sold, delivered and checked. The OpenSpec change
`openspec/changes/add-lifetime-license/` holds every decision; its proposal lists the questions
that are still open, such as which features are paid and what the license costs.

Everything here runs in Stripe test mode until live keys are added. No automated test calls
Stripe or Azure.

## How a purchase works

```mermaid
sequenceDiagram
    participant B as Buyer's browser
    participant S as Website /api (license-server)
    participant St as Stripe
    participant R as relay on the buyer's computer
    B->>S: POST /api/checkout
    S->>St: Create Checkout Session (payment mode, one price, license ID in metadata)
    S-->>B: 303 redirect to Stripe Checkout
    B->>St: Pays on the Stripe-hosted page
    St->>S: POST /api/stripe-webhook (v1.checkout.session.completed, signed)
    S->>St: Retrieve the session; record the license on the PaymentIntent
    St-->>B: Redirect to /license/?session_id=cs_...
    B->>S: GET /api/license?session_id=cs_...
    S->>St: Retrieve the session
    S-->>B: The signed license key
    B->>R: relay license activate <key>
    R->>R: Check the signature with the built-in public key (no network)
```

The buyer starts on the website's buy form, which posts to `/api/checkout` and works without
JavaScript. The server creates a Stripe Checkout Session for one unit of one one-time price and
sends the buyer to Stripe's own payment page; relay's server never sees card details. When the
payment succeeds, Stripe calls the webhook and sends the buyer back to the license page. The
webhook and the license page run the same fulfillment function, which reads the session from
Stripe and signs the same key every time. The buyer then gives the key to `relay`, which checks
it on the computer without any connection.

The server is the folder `license-server/`, a separate Bun project. It runs as the managed Azure
Functions API of the website's Azure Static Web App, on Node.js 22, so the site and the API share
one address and need no CORS rules. It has three HTTP functions:

| Route | What it does |
|---|---|
| `POST /api/checkout` | Creates the Checkout Session and answers 303 to Stripe's page. A Stripe error gives a short page: `Payment could not start. Nothing was charged. Try again in a minute.` |
| `POST /api/stripe-webhook` | Checks the signature of a thin event from Stripe, then runs fulfillment for `v1.checkout.session.completed` and `v1.checkout.session.async_payment_succeeded`. It logs `v1.checkout.session.async_payment_failed` and accepts every other type. |
| `GET /api/license?session_id=...` | Runs fulfillment for the license page: 200 with the key, 202 while a delayed payment is processing, 404 when the session is not a paid relay order, 503 when the settings are wrong or Stripe fails. |

### Fulfillment

The fulfillment function follows Stripe's guide (https://docs.stripe.com/checkout/fulfillment).
It retrieves the session with its line items and PaymentIntent, and it issues a key only when all
of these hold: the session is in payment mode, it belongs to the same mode (test or live) as the
server, its metadata says `relay_product=relay-lifetime` with a 16-character license ID, it has
exactly one line item of quantity 1 whose price is in `RELAY_LICENSE_PRICE_IDS`, its status is
`complete`, and its payment status is not `unpaid`. An unpaid session is "pending"; an open or
expired session is "not found".

It records the result on the PaymentIntent's metadata (`relay_license_issued` and
`relay_license_key_id`), so it shows in the Stripe Dashboard. The key is computed only from data
stored on the session, and Ed25519 signatures are deterministic, so running the function again,
even at the same moment, gives the same key and the same record. That is why the server needs no
database: a repeated webhook delivery and a license page request simply agree.

## The license key

A key is one line of about 220 characters:

```
relay1.<payload>.<signature>
```

`<payload>` is base64url, without padding, of this JSON, with exactly these keys in this order:

```json
{"v":1,"kid":"live-1","product":"relay-lifetime","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}
```

`<signature>` is base64url of the 64-byte Ed25519 signature of the text `relay1.<payload>`.

| Field | Meaning |
|---|---|
| `v` | The format version, 1 |
| `kid` | The ID of the signing key, so relay can pick the right public key and keys can be rotated |
| `product` | `relay-lifetime`, so a key for another product does not unlock this one |
| `license` | The license ID, created before payment and stored in the Checkout Session's metadata |
| `issued` | The UTC date of the purchase, so a later "updates until" rule needs no new keys |

The key holds no email address, no hash of one and no name.

## What relay checks

`relay license activate <key>` checks the key with `verifyLicenseKey` in `src/license/key.ts` and
saves it in `RELAY_HOME/license.key` with mode 0600. `relay license status` shows the saved
license and the paid features, and `relay license remove` deletes the file. `docs/cli.md` lists
the exact messages; the exit codes are 50 (the key is not valid) and 51 (no license is active).
The proposal first named 40 and 41, which `add-t3-limit-rules` already uses.

The check removes all whitespace, then looks at the format, the key ID, the signature and the
product, in that order, and reports the first problem. A key whose key ID starts with `test-`
always fails inside `relay`, because test-mode keys must never unlock a release. The public keys
are built into the program in `src/license/public-keys.ts`; no flag, setting or environment
variable can add one. The table is empty until the live signing key exists, and while it is
empty `relay license activate` and `status` exit with 69.

`relay license` never opens a network connection, and the key text is never written to a log.

The paid features are one list, `PAID_FEATURES` in `src/license/features.ts`. It is empty, so
nothing in relay is locked yet. `featureUnlocked` decides whether a feature is unlocked: today,
any valid license unlocks every paid feature.

## Settings

The server reads seven application settings of the Static Web App. Azure encrypts them at rest,
and each environment has its own values. No function ever logs, returns or echoes a value; when a
setting is missing or wrong, every function answers 503 with `{"error":"not_configured"}` and logs
the setting names only.

| Setting | Value | Secret |
|---|---|---|
| `STRIPE_API_KEY` | A restricted key, `rk_test_...` or `rk_live_...`. A secret key (`sk_...`) is refused. Its prefix sets the mode. | Yes |
| `STRIPE_WEBHOOK_SECRET` | The event destination's signing secret, `whsec_...` | Yes |
| `RELAY_STRIPE_PRICE_ID` | The one-time price that new checkouts sell, `price_...` | No |
| `RELAY_LICENSE_PRICE_IDS` | Every one-time price that has ever sold a license, separated by commas. It must contain `RELAY_STRIPE_PRICE_ID`. | No |
| `RELAY_LICENSE_SIGNING_KEY` | The Ed25519 private key, PKCS #8 DER in base64, on one line | Yes |
| `RELAY_LICENSE_KEY_ID` | The signing key ID, for example `live-1` or `test-1`; its prefix must match the mode | No |
| `RELAY_SITE_URL` | The site's address without a final `/`; `https://` only, except `http://localhost:<port>` in test mode | No |

To change the price, add the new price ID to `RELAY_LICENSE_PRICE_IDS` first, then set
`RELAY_STRIPE_PRICE_ID` to it. Never remove an old price ID from the list, or earlier buyers would
see "not found" on their license page.

### The restricted key's permissions

The restricted key needs exactly two permissions: **Checkout Sessions: Write** (create, and
retrieve with expanded line items) and **PaymentIntents: Write** (read the expanded PaymentIntent
and update its metadata). Everything else is **None**. If the test-mode run gets a 403 that names
another resource, add only that resource as **Read**, and list it here.

Extra permissions found in the test-mode run: none yet (the run has not happened).

## Signing keys

`license-server/scripts/keygen.ts <kid>` creates an Ed25519 key pair. It writes the private key to
`./<kid>.signing-key` with mode 0600, refuses to overwrite an existing file, and prints only the
public key line for `src/license/public-keys.ts`, with a `// gitleaks:allow` comment because the
value is public. `.gitignore` keeps `*.signing-key` files out of git.

```sh
cd license-server
bun scripts/keygen.ts live-1
```

If a private key may have leaked: run the script with the next ID (`live-2`), add the new public
key to the table, release relay, then set `RELAY_LICENSE_SIGNING_KEY` and `RELAY_LICENSE_KEY_ID`
to the new values. Keys signed with `live-1` keep working while `live-1` stays in the table.
Removing it withdraws every key it signed, so do that only for a confirmed leak; buyers then
reopen their license page, which signs the same license with the current key and moves the
PaymentIntent's record to the new key ID.

## Finding a buyer's key again

A buyer who lost the page writes to the support address on the Stripe receipt. In the Stripe
Dashboard, find the payment (by email, or by the license ID in the metadata), open its Checkout
Session, and send the buyer `https://<site>/license/?session_id=<id>`. The page shows the same key
again. The license page and its API answer with `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`, because the session ID in the address is the buyer's access to the
key.

## The website parts

The buy section of `site/public/index.html` has `id="buy"` and a form that posts to
`/api/checkout`. `site/public/license/index.html` and `license.js` read `session_id` from the
address, ask `/api/license`, and show one of five states: loading, issued (the key, a `Copy key`
button, the `relay license activate <key>` command and a `Copy command` button), pending, not
found and error. Without JavaScript the page says that it needs JavaScript.

`site/public/staticwebapp.config.json` sets the API runtime to `node:22` and gives every address
that starts with `/license` the headers above and a Content-Security-Policy that allows
`connect-src 'self'`, so the page can call its own API. The site-wide policy allows forms to post
to the site itself and to `https://checkout.stripe.com`, because browsers apply `form-action` to
the redirect that follows the buy form.

To see the license page without Stripe, run the preview server, which serves `site/public` on
port 7102 and answers `/api/license` with a made-up answer for the state named in `session_id`:

```sh
cd license-server
bun scripts/page-preview.ts
# then open http://127.0.0.1:7102/license/?session_id=issued  (or pending, not_found, error, loading)
```

## Building, testing and deploying

```sh
cd license-server
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build        # writes dist/: index.js, index.js.map, host.json, package.json
sh scripts/smoke.sh  # starts dist/ in Azure Functions Core Tools on Node.js 22, without Stripe values
```

The tests use `test/fakes/stripe.ts`, a fake Stripe client built from the shapes of Stripe's
Checkout Session and PaymentIntent objects, and every key, secret and restricted-key value is made
while the tests run. Webhook tests sign thin event bodies with the Stripe library's
`generateTestHeaderStringAsync`. The asynchronous form is needed because Bun loads the library's
worker build, whose Web Crypto provider cannot sign or verify synchronously; for the same reason
the server verifies events with `parseEventNotificationAsync`. In the root project,
`test/license/cross-check.test.ts` signs with the server's `sign.ts` and checks with relay's
`key.ts`.

`bash site/scripts/deploy.sh [environment]` builds `license-server/dist` and deploys it as the
site's API, with the API build skipped. Without an argument it deploys production; with one, for
example `license-test`, it deploys a preview environment. Azure keeps only the letters and digits
of a preview environment's name, so the environment `license-test` is called `licensetest` in
every `az staticwebapp` command:

```sh
az staticwebapp environment list --name <app> --query "[?name=='licensetest'].hostname" -o tsv
az staticwebapp appsettings list --name <app> --environment-name licensetest --query "keys(properties)"
```

## The test-mode run

The preview environment `licensetest` holds three settings today: `RELAY_LICENSE_KEY_ID=test-1`,
`RELAY_SITE_URL` and a test signing key. Its three functions answer 503 until the Stripe values
are added. The test-mode run then needs Josué's Stripe sandbox, a product and one-time price, a
restricted key with the two permissions above, and a thin event destination for the three event
types at `https://<preview host>/api/stripe-webhook`. Design.md of the change, "What Josué must
do", lists the exact steps, including how to set the values without leaving them in shell history.

After a test purchase with the card `4242 4242 4242 4242`, check the key with:

```sh
cd license-server
bun scripts/verify-key.ts '<key>' --public-key '<test-1 public key>' --kid test-1
RELAY_TEST_LICENSE_KEY='<key>' RELAY_TEST_LICENSE_PUBLIC_KEY='<test-1 public key>' bun test test/license/test-mode-key.test.ts
```

The first prints `valid: license <id>, issued <date>`. The second runs `relay license activate`
with that public key and expects exit 50 and the test-mode message, which proves that a real
test-mode key never unlocks relay.

## Going live

Live mode is not built by an agent. Josué generates the live signing key, creates the live
product, price, restricted key and event destination, and sets the production settings, as
design.md of the change lists under "What Josué must do". The live public key line is then added
to `src/license/public-keys.ts` in a pull request, and a release follows.
