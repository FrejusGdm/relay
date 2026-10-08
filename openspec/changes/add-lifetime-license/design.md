# Design

## Context

See proposal.md ("Why"). The constraints that shape this design:

- `docs/ROADMAP.md`, "Decisions made": the core stays free; a one-time payment buys a lifetime license for the paid features; the payment provider is Stripe, built in test mode until Josué adds live keys; the website runs on Azure Static Web Apps in Josué's Azure subscription.
- `openspec/config.yaml`: no telemetry; tests never call real services; official generators and CLIs.
- `docs/research/prior-art-and-pricing.md` section 3.2: a signed key checked offline with a built-in public key; relay must keep working without a network.
- `add-cli-scaffold`: the command table, help template, golden files, exit-code ranges, `RELAY_HOME` safety checks and log rules. `add-website` (proposed in parallel, perhaps not merged yet) owns the site's folder, its deployment and `staticwebapp.config.json`.

Facts checked on 2026-10-07 (each decision cites the page it relies on):

- Stripe's current API version is `2026-09-30.endive`. The Node.js library `stripe` 23.0.0 (published 2026-09-30) pins it, needs Node.js 20 or later, and verifies webhook signatures with a default tolerance of 300 seconds (https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md, entry 23.0.0; `DEFAULT_TOLERANCE: 300` in `cjs/Webhooks.js` of that version). The `stripe-best-practices` skill named API version `2026-08-26.dahlia` and library 22.6.0; the npm registry shows 23.0.0 is newer, so this design uses 23.0.0.
- `@azure/functions` 4.16.5 is the current Azure Functions Node.js library (v4 programming model). It loads the module `@azure/functions-core`, which the Azure Functions Node.js worker provides at run time, so a bundle must leave that module out.
- Azure Static Web Apps managed functions support HTTP triggers only, run on the Consumption plan, are available on the Free and Standard plans, cannot use managed identity or Key Vault references, and are reached only through the site's `/api` route. Each API request may last at most 45 seconds. Supported Node.js versions include `node:20` and `node:22` (https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions, https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview, https://learn.microsoft.com/en-us/azure/static-web-apps/languages-runtimes, https://learn.microsoft.com/en-us/azure/static-web-apps/plans).
- Static Web Apps application settings are environment variables of the API, are encrypted at rest, can be set per environment, and may contain only letters, digits, `.` and `_` (https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings). `az staticwebapp appsettings set` accepts `--environment-name` (Azure CLI 2.91.0 help on the Omarchy machine).
- Static Web Apps can deploy an API that was built in an earlier step (`skip_api_build: true` with `apiRuntime` in `staticwebapp.config.json`; https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration). The SWA CLI 2.0.10 `swa deploy` accepts `--api-location`, `--api-language`, `--api-version` and `--env`.
- Bun 1.4.2 on the Omarchy machine creates Ed25519 key pairs, signs and verifies with `node:crypto`, and two signatures of the same message are identical (checked with a short script on 2026-10-07). Ed25519 is deterministic by definition (RFC 8032).

## Goals / Non-Goals

**Goals:**

- A buyer pays once with Stripe Checkout and gets a key on the license page within seconds.
- `relay` checks the key offline, with no personal data in the key.
- Every payment produces a key even when the buyer closes the page, because the webhook runs the same fulfillment.
- No database, no queue and no second Azure resource.
- Every automated test runs without Stripe, Azure or a network.

**Non-Goals:**

- Choosing the paid features, the price, the meaning of "lifetime", tax handling, refunds or email delivery (proposal.md, "Open questions for Josué").
- Online activation, device limits or revocation.
- Stopping a determined person from patching the binary. The research says to keep paid features modest and the price low enough that paying is simpler (section 3.2).

## The flow

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

The buyer starts on the website and is sent to Stripe's own payment page. When the payment succeeds, Stripe calls the webhook and sends the buyer back to the license page. The webhook and the license page both run the same fulfillment function, which reads the session from Stripe and signs the same key every time. The buyer then gives the key to `relay`, which checks it on the computer without any connection.

## Decisions

### 1. Where the server runs: the website's managed Functions API

Source: `docs/ROADMAP.md` ("The website: deployed to Azure Static Web Apps"); the Azure pages listed under Context.

The three functions run as the **managed Azure Functions API** of the same Static Web App that serves the website, from the folder `license-server/`, on `node:22`.

Why:

- The site and the API share one origin, so the license page calls `/api/license` without CORS rules, and the checkout form posts to `/api/checkout` without JavaScript.
- Managed functions are included in the Free plan; there is no second resource to create, pay for, monitor or deploy separately.
- Every function the design needs is an HTTP endpoint, which is the only trigger managed functions allow.
- Each request does at most two Stripe calls and finishes in well under the 45-second limit and Stripe's 10-second wait before redirecting the buyer (https://docs.stripe.com/checkout/fulfillment, "Configure a landing page URL").

The costs, accepted for now:

- Managed functions cannot use Key Vault references or managed identity, so the secrets are application settings (encrypted at rest) instead of Key Vault entries, which Stripe recommends for Azure (`stripe-best-practices` skill, security reference, "API keys"). Decision 2 limits the damage: a restricted key with two permissions, values only in the environment that needs them, and rotation steps.
- Managed functions accept only HTTP triggers, so Stripe's advice to process events through a queue (https://docs.stripe.com/webhooks, "Handle events asynchronously") is not followed. At relay's volume each event takes two short Stripe calls, and a failed call returns status 500 so Stripe retries.
- Logs are visible only if Application Insights is turned on for the site.

Alternatives considered:

- **Bring your own Azure Functions app** (Standard plan and a separate Functions resource). It allows Key Vault references and managed identity, but adds a monthly plan fee, a second deployment and a second resource. This is the upgrade path if sales grow or a security review asks for Key Vault; the handlers in decision 11 do not change.
- **A different host** (for example Cloudflare Workers or Vercel). Rejected: it adds a vendor that holds the secrets and a second origin, against the decision to host on Azure.
- **Keygen or a merchant of record's built-in license keys.** Rejected: the roadmap chose Stripe, and Stripe has no license keys (`prior-art-and-pricing.md` section 3.3).

### 2. Settings and secrets

Source: https://docs.stripe.com/keys, https://docs.stripe.com/keys-best-practices, https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings.

The server reads seven application settings. None of their names uses a prefix that Azure reserves.

| Setting | Value | Secret |
|---|---|---|
| `STRIPE_API_KEY` | A restricted key, `rk_test_...` or `rk_live_...` | Yes |
| `STRIPE_WEBHOOK_SECRET` | The event destination's signing secret, `whsec_...` | Yes |
| `RELAY_STRIPE_PRICE_ID` | The one-time price that new checkouts sell, `price_...` | No |
| `RELAY_LICENSE_PRICE_IDS` | Every one-time price that has ever sold a license, separated by commas, for example `price_A,price_B` | No |
| `RELAY_LICENSE_SIGNING_KEY` | The Ed25519 private key, PKCS #8 DER, base64 on one line | Yes |
| `RELAY_LICENSE_KEY_ID` | The signing key ID, for example `live-1` or `test-1` | No |
| `RELAY_SITE_URL` | The site's address without a final `/`, for example `https://relay.example` | No |

`src/core/settings.ts` `loadSettings(env)` returns either the settings with `mode: "test" | "live"` or the list of setting **names** that are missing or wrong. The rules:

- `STRIPE_API_KEY` must start with `rk_test_` (mode `test`) or `rk_live_` (mode `live`). An `sk_` key is refused, because Stripe recommends restricted keys and a secret key can do anything on the account.
- `RELAY_LICENSE_KEY_ID` must match `^(test|live)-[0-9]+$`, and its prefix must equal the mode. This stops a live payment from being signed with a test key, and the reverse.
- `RELAY_LICENSE_SIGNING_KEY` must decode to an Ed25519 private key.
- `RELAY_SITE_URL` must start with `https://`. In test mode `http://localhost:<port>` is also accepted, for the local smoke test.
- `STRIPE_WEBHOOK_SECRET` must start with `whsec_`; `RELAY_STRIPE_PRICE_ID` and every entry of `RELAY_LICENSE_PRICE_IDS` must start with `price_`.
- `RELAY_LICENSE_PRICE_IDS` must contain `RELAY_STRIPE_PRICE_ID`.

Why two price settings: the checkout sells only the current price, but fulfillment must keep accepting every price that ever sold a license. Otherwise, after Josué changes the price (for example from a founding price to the regular one), earlier buyers would get "not found" on their license page, and a delayed payment started at the old price could never be fulfilled. To change the price, Josué adds the new price ID to `RELAY_LICENSE_PRICE_IDS` and then sets `RELAY_STRIPE_PRICE_ID` to it; he never removes an old price ID from the list.

When the settings are wrong, every function answers status 503 with `{"error":"not_configured"}` and logs `settings invalid` with the setting names only. No function ever logs, returns or echoes a setting's value.

Environments: test values (`rk_test_`, `test-1`) are set only on the preview environment used for the test-mode run (`--environment-name licensetest`); live values only on the production environment. A check command in "What Josué must do" confirms that no preview environment holds an `rk_live_` value.

The restricted key gets exactly two permissions: **Checkout Sessions: Write** (create, and retrieve with expanded line items) and **PaymentIntents: Write** (read the expanded PaymentIntent and update its metadata). Everything else is **None**. If the test-mode run gets a 403 that names another resource, add only that resource as **Read**, and record it in `docs/licensing.md`; this follows Stripe's own advice for building a restricted key from test-mode errors (`stripe-best-practices` skill, security reference, "Restricted API keys").

### 3. The Stripe library and API version

Source: https://docs.stripe.com/get-started/checklist/go-live ("Set the API version"); stripe-node 23.0.0 changelog.

`license-server/src/core/stripe-client.ts` creates one client per function instance:

```ts
new Stripe(settings.apiKey, {
  apiVersion: "2026-09-30.endive",
  maxNetworkRetries: 2,
  timeout: 8000,
  telemetry: false,
  appInfo: { name: "relay-license-server", version: "0.1.0" },
});
```

`telemetry: false` stops the library from sending request timing data to Stripe, in line with relay's no-telemetry rule. The same file exports the interface the rest of the code uses, so tests can pass a fake:

```ts
export interface StripeApi {
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session>;   // expand: ["line_items", "payment_intent"]
  recordLicense(paymentIntentId: string, metadata: Record<string, string>, idempotencyKey: string): Promise<void>;
  parseEventNotification(rawBody: Buffer, signature: string): { id: string; type: string; livemode: boolean; relatedObjectId: string | null };
}
```

`parseEventNotification` wraps the library's `client.parseEventNotification(rawBody, signature, settings.webhookSecret)`, which verifies the signature before it parses anything.

### 4. The Checkout Session

Source: https://docs.stripe.com/api/checkout/sessions/create; the `stripe-best-practices` skill ("Integration routing": one-time payments use Checkout Sessions; never pass `payment_method_types`; pass `integration_identifier` on `2026-03-25.dahlia` or later); https://docs.stripe.com/payments/checkout/custom-success-page.

`POST /api/checkout` accepts a plain HTML form post with no fields. It creates a license ID, 16 lowercase hexadecimal characters from `crypto.randomBytes(8)`, and creates exactly this session:

```ts
await stripe.createCheckoutSession({
  mode: "payment",
  line_items: [{ price: settings.priceId, quantity: 1 }],
  success_url: `${settings.siteUrl}/license/?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${settings.siteUrl}/#buy`,
  submit_type: "pay",
  metadata: { relay_product: "relay-lifetime", relay_license_id: licenseId },
  payment_intent_data: {
    metadata: { relay_product: "relay-lifetime", relay_license_id: licenseId },
  },
  integration_identifier: "relay-lifetime-checkout-qhvbtmzr",
});
```

On success it answers 303 with `Location` set to the session's `url`. Any other method gets 405. A Stripe error gets status 502 with a short HTML page: `Payment could not start. Nothing was charged. Try again in a minute.` and a link back to `/#buy`.

Choices inside the call:

- No `payment_method_types`: Stripe chooses the payment methods from the Dashboard settings (dynamic payment methods). Some of them confirm the payment later, which is why decision 5 handles `async_payment_succeeded`.
- No `customer` and no `customer_creation`: the default `if_required` creates no Customer object for a one-time payment, so Stripe keeps the buyer's email on the session and payment only. relay's server never reads or stores it.
- No `automatic_tax` and no `allow_promotion_codes` until Josué decides (proposal.md, open questions 2 and 4). The `stripe-best-practices` skill warns that turning on `automatic_tax` without an active registration collects nothing.
- The license ID is created before payment and stored in the session's metadata and the PaymentIntent's metadata. That makes the key a pure function of the session, and lets Josué search for a license ID in the Dashboard.
- `{CHECKOUT_SESSION_ID}` is Stripe's literal placeholder; Stripe replaces it during the redirect.
- The `#buy` anchor is the buy section that `add-website` must provide (decision 12).

Alternative considered: a **Payment Link** made in the Dashboard. Stripe lists it first for simple products and it would remove this function. Rejected because the website would need a different link for test and live mode, and the license ID could not be stored per session; with the API, the environment's settings alone decide test or live mode.

### 5. The webhook

Source: https://docs.stripe.com/webhooks; https://docs.stripe.com/events/how-events-work ("For new integrations, use thin events"); https://docs.stripe.com/api/v2/core/events/event-types (the thin event types `v1.checkout.session.completed`, `v1.checkout.session.async_payment_succeeded` and `v1.checkout.session.async_payment_failed`); https://docs.stripe.com/checkout/fulfillment.

The event destination uses **thin** events, because Stripe recommends them for new integrations and the handler fetches the session anyway. It subscribes to exactly three types: `v1.checkout.session.completed`, `v1.checkout.session.async_payment_succeeded` and `v1.checkout.session.async_payment_failed`.

`POST /api/stripe-webhook`, `handleWebhook(request, deps)`:

1. Any method other than `POST` gets 405. A body over 65,536 bytes gets 413.
2. Wrong settings give 503, so Stripe retries after Josué fixes them.
3. Use the body as raw bytes (`Buffer.from(request.body)`: the Azure wrapper in `src/index.ts` reads the bytes with `await request.arrayBuffer()` before calling the handler); never parse it first, because any change to the raw body breaks the signature check. Call `parseEventNotification` with the `Stripe-Signature` header. If it throws (bad signature, missing header, timestamp older than 300 seconds), answer 400 `{"error":"invalid_signature"}` and log `webhook rejected` with no body.
4. If the event's `livemode` differs from the settings' mode, answer 200 and log a warning. Retrying cannot fix it.
5. For `v1.checkout.session.completed` and `v1.checkout.session.async_payment_succeeded`, run `fulfillCheckout(relatedObjectId)` (decision 6). Results `issued`, `pending`, `not_found` and `rejected` all answer 200 `{"received":true}`; `rejected` is logged as an error for Josué. If a Stripe call throws, answer 500 so Stripe retries (up to three days in live mode, three times over a few hours in a sandbox).
6. For `v1.checkout.session.async_payment_failed`, log `payment failed` with the session ID and answer 200. Nothing was issued, so nothing is undone.
7. Any other type answers 200 and is ignored.

Logged fields: `event_id`, `event_type`, `session_id`, `outcome`, `license_id`. Never the body, the buyer's email, the key or a secret.

Duplicate events need no event-ID table: the fulfillment function is safe to repeat (decision 6). Stripe's own advice for duplicates is to log processed event IDs; that would need a database, and repeating fulfillment gives the same result without one.

Stripe also recommends allowing only Stripe's IP addresses at the webhook. Managed functions have no IP rules, and checking a forwarded header in code would be easy to fake, so this design relies on the signature check, which Stripe calls the strong guarantee.

If Josué's account cannot create a thin destination for these event types, the fallback is a snapshot destination for `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, with `client.webhooks.constructEvent` in step 3. Only `parseEventNotification` in `stripe-client.ts` changes.

### 6. The fulfillment function

Source: https://docs.stripe.com/checkout/fulfillment ("Create a fulfillment function"); https://docs.stripe.com/api/idempotent_requests; https://docs.stripe.com/api/payment_intents/update.

`fulfillCheckout(sessionId, deps): Promise<FulfillResult>` in `license-server/src/core/fulfill.ts`:

```ts
type FulfillResult =
  | { state: "issued"; key: string; licenseId: string; issued: string }
  | { state: "pending" }
  | { state: "not_found" }
  | { state: "rejected"; reason: "mode" | "livemode" | "product" | "license_id" | "line_items" };
```

1. If `sessionId` does not match `^cs_(test|live)_[A-Za-z0-9]{10,240}$`, or its `test`/`live` part differs from the settings' mode, return `not_found` without calling Stripe.
2. Retrieve the session with `expand: ["line_items", "payment_intent"]`. A Stripe `resource_missing` error returns `not_found`. Any other error is thrown.
3. Check, in this order, and return `rejected` with the first failing reason: `mode` (the session's `mode` is not `payment`), `livemode` (the session's `livemode` differs from the settings' mode), `product` (`metadata.relay_product` is not `relay-lifetime`), `license_id` (`metadata.relay_license_id` does not match `^[0-9a-f]{16}$`), `line_items` (not exactly one line item, or its price ID is not in `RELAY_LICENSE_PRICE_IDS`, or its quantity is not 1). The check uses the list of every price ever sold, not the current checkout price, so a buyer from an earlier price keeps getting the key.
4. If the session's `status` is not `complete`, return `not_found` (the buyer did not finish paying, or the session expired). If `payment_status` is `unpaid`, return `pending` (a delayed payment method has not succeeded yet). Otherwise (`paid` or `no_payment_required`) continue, as Stripe's guide says: fulfill when the payment status is not `unpaid`.
5. `issued` is the UTC date (`YYYY-MM-DD`) of the session's `created` time. Sign the key with `signLicenseKey({ kid, privateKey, licenseId, issued })` (decision 8).
6. If the session has a PaymentIntent and its metadata `relay_license_issued` differs from `issued` **or** its `relay_license_key_id` differs from the current `kid`, call `recordLicense(paymentIntent.id, { relay_license_issued: issued, relay_license_key_id: kid }, "relay-license-" + session.id + "-" + kid)`. This is the fulfillment record that Stripe's guide asks for, visible in the Dashboard. Comparing both fields matters after a key rotation (decision 13): when a buyer reopens the license page after `live-1` was replaced by `live-2`, the key is signed with `live-2`, the issue date is unchanged, and the record must move to `live-2`. The key ID is part of the idempotency key because Stripe returns the saved result for a reused idempotency key for at least 24 hours, so an update for `live-2` under the key used for `live-1` would be ignored (https://docs.stripe.com/api/idempotent_requests).
7. Return `issued` with the key.

Why this is safe to run many times, even at the same moment: steps 1 to 5 only read, and their result depends only on the session and the current signing key; Ed25519 gives the same signature for the same message; step 6 writes the same values each time, under one idempotency key per session and signing key. So two webhook deliveries and a license page request for the same session all return the same key and leave the same metadata.

### 7. The license endpoint

Source: https://docs.stripe.com/checkout/fulfillment ("Trigger fulfillment on your landing page"); https://docs.stripe.com/payments/checkout/custom-success-page.

`GET /api/license?session_id=<id>`, `handleLicense(request, deps)`:

| Result | Status | Body |
|---|---|---|
| `issued` | 200 | `{"state":"issued","key":"relay1....","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}` |
| `pending` | 202 | `{"state":"pending"}` |
| `not_found` or `rejected` | 404 | `{"state":"not_found"}` |
| Wrong settings | 503 | `{"error":"not_configured"}` |
| A Stripe error | 503 | `{"state":"error"}` |
| Another method | 405 | `{"error":"method_not_allowed"}` |

Every response has `Content-Type: application/json`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The session ID is a long random value that only the buyer's browser receives from Stripe, so it acts as the buyer's access to the key; step 1 of decision 6 rejects malformed IDs before any Stripe call, so random requests cost no Stripe calls.

A buyer who lost the page writes to the support address on the Stripe receipt. Josué finds the payment in the Dashboard (searching by email or by the license ID in the metadata), opens its Checkout Session, and sends the buyer `https://<site>/license/?session_id=<id>`. The page shows the same key again.

### 8. The license key format

Source: `prior-art-and-pricing.md` section 3.2; RFC 8032 (Ed25519).

A key is one line:

```
relay1.<payload>.<signature>
```

- `<payload>` is base64url without padding of this JSON, written with exactly these keys in this order and no spaces:
  `{"v":1,"kid":"live-1","product":"relay-lifetime","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}`
- `<signature>` is base64url without padding of the 64-byte Ed25519 signature of the ASCII bytes `relay1.<payload>` (the prefix, the dot and the encoded payload). Signing the prefix ties the signature to this format version.
- A typical key is about 220 characters.

What the key holds and why:

| Field | Meaning | Why it is there |
|---|---|---|
| `v` | Format version, 1 | A later format can be told apart |
| `kid` | Signing key ID | Lets relay pick the public key, and allows key rotation |
| `product` | `relay-lifetime` | A key for any later product does not unlock this one |
| `license` | The license ID from the Checkout Session | Support lookups, and a later list of withdrawn IDs |
| `issued` | UTC date of the purchase | A later "updates until" rule needs no new keys |

No email, no email hash and no name. An email hash would add nothing to an offline check, and email addresses are easy to guess, so a hash of one is not private.

`license-server/src/core/sign.ts` exports `signLicenseKey({ kid, privateKey, licenseId, issued }): string`, using `crypto.sign(null, message, privateKey)` from `node:crypto`. It imports nothing else, so the `relay` tests can import it to prove that the signer and the checker agree.

### 9. Checking a key inside relay

Source: `openspec/config.yaml` ("No telemetry"); `docs/research/security.md` section 9.

`src/license/public-keys.ts`:

```ts
// Public keys only; the private keys live in the website's settings.
export const LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = {};
```

Each value is the 32-byte Ed25519 public key in base64url (the `x` value of its JWK). The table is empty until Josué generates the live signing key (decision 13); then it holds `"live-1": "<43 characters>"` with a `// gitleaks:allow` comment, because the value is public and the secret scan in CI must not stop on it.

`src/license/key.ts` exports:

```ts
export type KeyProblem = "format" | "test_key" | "unknown_key" | "signature" | "product";
export interface License { licenseId: string; issued: string; kid: string }
export function verifyLicenseKey(
  text: string,
  publicKeys: Readonly<Record<string, string>> = LICENSE_PUBLIC_KEYS,
  options: { allowTestKeys?: boolean } = {},
): { ok: true; license: License } | { ok: false; problem: KeyProblem };
```

Steps, in order:

1. Remove every whitespace character (mail programs and terminals sometimes wrap long lines). More than 1,024 characters left is `format`.
2. Match `^relay1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$`, decode the payload and parse it as a JSON object. Require `v` equal to 1, `kid` matching `^(test|live)-[0-9]+$`, `product` a string, `license` matching `^[0-9a-f]{16}$`, and `issued` a real date in the form `YYYY-MM-DD`. Any failure is `format`. Unknown extra fields are ignored.
3. A `kid` starting with `test-` is `test_key`, unless `options.allowTestKeys` is true. Only the development script `license-server/scripts/verify-key.ts` and tests pass it; the `relay` command never does.
4. A `kid` missing from `publicKeys` is `unknown_key`.
5. `crypto.verify(null, asciiBytes("relay1." + payload), publicKey, signature)` false is `signature`. The public key is built with `createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })`.
6. `product` other than `relay-lifetime` is `product`.

`src/license/features.ts`:

```ts
export interface PaidFeature { id: string; name: string }
// Josué decides which features are paid (proposal.md, open question 1).
export const PAID_FEATURES: readonly PaidFeature[] = [];
export function featureUnlocked(feature: PaidFeature, license: License | null): boolean {
  return license !== null;
}
```

A lifetime license unlocks every paid feature, so `featureUnlocked` only checks that a valid license exists; it is one function so that a later "updates until" rule changes one place. `relay license status` calls it for each paid feature.

The gate for a paid command, added by the first change that puts a feature in `PAID_FEATURES` (not built here, because no command is paid yet): that command calls `requirePaidFeature(ctx, feature)` in `src/license/gate.ts`, which reads the saved key, verifies it, and, when `featureUnlocked` is false, prints `relay: <feature name> needs a relay license. Run "relay license status" to see yours.` and returns exit code 51.

### 10. The `relay license` command

Source: `add-cli-scaffold` design decisions 3 to 6 (command table, run flow, exit codes, help template).

Command table entry (`src/cli/commands/registry.ts`):

| Command | Usage | Arguments | Own options | Built by |
|---|---|---|---|---|
| license | `relay license <activate\|status\|remove> [<key>]` | 1 to 2 | none | `add-lifetime-license` |

Summary `Add, check or remove your relay license`. Details: `relay checks the key on this computer. It never sends it anywhere.` Examples: `relay license activate relay1.eyJ2IjoxLCJraWQiOiJsaXZlLTEi...`, `relay license status`, `relay license remove`. `built: true`.

Top-level help gains, after the `doctor` row:

```
  license             Add, check or remove your relay license
```

The golden file `test/cli/golden/license.txt` is exactly:

```
Usage
  relay license <activate|status|remove> [<key>]

Add, check or remove your relay license.
relay checks the key on this computer. It never sends it anywhere.

Examples
  relay license activate relay1.eyJ2IjoxLCJraWQiOiJsaXZlLTEi...
  relay license status
  relay license remove

Options
  -h, --help               Show this help
      --log-level <level>  How much to log: debug, info, warn or error
```

Argument rules (exit 2, on standard error):

- First argument not one of the three: `relay: license needs activate, status or remove, not "<value>".`
- A second argument after `status` or `remove`: `relay: license <action> takes no other argument.`
- `activate` with no key and standard input is a terminal: `relay: license activate needs a key. Run "relay license activate <key>", or pipe the key into it.` When standard input is not a terminal, relay reads at most 4,096 bytes from it as the key.

The saved key: `RELAY_HOME/license.key`, one line with the key and a newline, mode 0600, written to `RELAY_HOME/tmp-license-<random>` and renamed over the file. Reading uses `checkPrivateFile(path, uid, 4096)` from `add-cli-scaffold`, so a file owned by another user or writable by others is a settings error (exit 78).

Outputs. `<file>` is the absolute path of `license.key`.

| Situation | Stream | Text | Exit |
|---|---|---|---|
| `activate`, valid key | out | `License activated.` / `License ID: <id>` / `Issued: <date>` / `relay keeps the key in <file> and checks it on this computer only.` | 0 |
| `activate`, valid key replacing a different saved one | out | first line becomes `License activated. It replaces license <old id>.` | 0 |
| `status`, valid saved key | out | `License: active` / `License ID: <id>` / `Issued: <date>` / `Paid features: <list>` | 0 |
| `status`, no saved key | out | `License: none` / `relay's core is free and stays free. A license unlocks the paid features.` / `Paid features: <list>` | 51 |
| `status`, saved key not valid | err | `relay: the saved license in <file> is not valid: <reason>` / `Run "relay license remove", then activate your key again.` | 50 |
| `remove`, saved key | out | `License removed.` | 0 |
| `remove`, no saved key | out | `No license was saved. Nothing changed.` | 0 |
| `activate` or `status` while `LICENSE_PUBLIC_KEYS` is empty | err | `relay: this version of relay cannot check license keys yet.` | 69 |
| `activate`, key not valid | err | `relay: <reason>` | 50 |

`<list>` is the paid feature names joined by `, `, or `none yet` while `PAID_FEATURES` is empty. A `/` in the table separates printed lines. The `<reason>` texts:

| Problem | Reason |
|---|---|
| `format` | `this is not a relay license key. Copy the whole key; it starts with "relay1.".` |
| `test_key` | `this license key comes from Stripe test mode and does not unlock relay.` |
| `unknown_key` | `this license key was signed with a key that this version of relay does not know. Update relay and try again.` |
| `signature` | `this license key failed its signature check. Copy it again from your license page.` |
| `product` | `this license key is for another product.` |

Exit codes added to `src/cli/exit-codes.ts`, `docs/cli.md` and `docs/first-version-index.md`. This design first used 40 and 41; on 2026-10-08 they became 50 and 51, because `add-t3-limit-rules` already uses 40 to 42:

| Code | Constant | Meaning |
|---|---|---|
| 50 | `LicenseInvalid` | The license key is not valid: wrong format, a test key, an unknown signing key, a failed signature check, or another product. |
| 51 | `LicenseMissing` | No license is active (from `relay license status`, and later from a paid feature). |

The command reads the public key table from its command context, `ctx.licensePublicKeys`, which `src/cli/run.ts` fills with `LICENSE_PUBLIC_KEYS`. Only tests replace it, through the `licensePublicKeys` option of `runRelayInProcess` (`test/helpers/cli.ts`); no flag, setting or environment variable can change it in a built `relay`. This lets tests run the real command against key pairs made at run time, and lets the test-mode run check a real test-mode key (task 8.2) while the built-in table is still empty.

Log events in `cli.log`: `license activated` and `license removed` with `license_id`, and `license check failed` with `problem`. The key text is never logged; the scaffold's rule that argument values are never logged already covers `activate <key>`.

The command never opens a network connection. The scaffold's `test/build/no-network.test.ts` covers `src/license/`, and `test/license/no-network.test.ts` replaces `globalThis.fetch` with a function that records calls and checks that `activate`, `status` and `remove` make none.

### 11. The server project

Source: `openspec/config.yaml` ("Use official generators and CLIs"); https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration ("Skip building the API").

`license-server/` is its own Bun project, created with `BUN_AGENT_RULE_DISABLED=1 bun init --yes` inside the folder, so its dependencies never enter the `relay` binary. It is built with Bun and runs on Node.js 22 in Azure.

```
license-server/package.json            name relay-license-server, private, packageManager bun@1.4.2
license-server/bun.lock
license-server/bunfig.toml             env = false; [test] root = "test"
license-server/tsconfig.json
license-server/host.json               {"version": "2.0"}
license-server/src/index.ts            registers the three functions with app.http (the only file importing @azure/functions)
license-server/src/handlers/checkout.ts      handleCheckout(request, deps)
license-server/src/handlers/webhook.ts       handleWebhook(request, deps)
license-server/src/handlers/license.ts       handleLicense(request, deps)
license-server/src/core/settings.ts    loadSettings(env)
license-server/src/core/stripe-client.ts     StripeApi and createStripeApi(settings)
license-server/src/core/fulfill.ts     fulfillCheckout(sessionId, deps)
license-server/src/core/sign.ts        signLicenseKey()
license-server/src/core/http.ts        json(), html(), the shared response headers
license-server/scripts/build.ts        the bundle (below)
license-server/scripts/keygen.ts       decision 13
license-server/scripts/verify-key.ts   checks a key against a given public key, test keys allowed
license-server/scripts/smoke.sh        the local runtime smoke test (task 5.3)
license-server/test/*.test.ts
license-server/test/fakes/stripe.ts    FakeStripeApi
```

Dependencies, exact: `stripe@23.0.0` and `@azure/functions@4.16.5`; development: `typescript@7.0.2` and `@types/node@22` (the Node.js line Azure runs). Scripts: `"typecheck": "tsc --noEmit"`, `"test": "bun test"`, `"build": "bun scripts/build.ts"`.

Handlers take a plain request (`{ method, url, headers, body: Uint8Array }`, where the Azure wrapper fills `body` with the raw bytes from `await request.arrayBuffer()`) and return `{ status, headers, body }`, so tests call them without the Azure runtime. `src/index.ts` registers:

```ts
app.http("checkout", { route: "checkout", methods: ["POST", "GET"], authLevel: "anonymous", handler: wrap(handleCheckout) });
app.http("stripe-webhook", { route: "stripe-webhook", methods: ["POST", "GET"], authLevel: "anonymous", handler: wrap(handleWebhook) });
app.http("license", { route: "license", methods: ["GET", "POST"], authLevel: "anonymous", handler: wrap(handleLicense) });
```

The other method is registered so that the handler, not the runtime, answers 405 with the documented body.

`scripts/build.ts` calls `Bun.build({ entrypoints: ["src/index.ts"], target: "node", format: "cjs", outdir: "dist", external: ["@azure/functions-core"], sourcemap: "linked" })`, copies `host.json` into `dist/`, and writes `dist/package.json` as `{"name":"relay-license-server","version":"0.1.0","private":true,"main":"index.js"}`. `dist/` is the folder Static Web Apps deploys with the API build skipped. `@azure/functions-core` stays external because the Azure Functions Node.js worker provides it.

### 12. The license page and the buy button

Source: `DESIGN.md` (rules, typography, voice); https://docs.stripe.com/payments/checkout/custom-success-page.

These files belong to the website and are added after `add-website` is merged, in its folder and style:

- The buy section has `id="buy"` and holds `<form method="post" action="/api/checkout"><button type="submit">Buy a lifetime license</button></form>`, with the price text next to it. The words are "Buy" and "price", never "donate" or "support" (`prior-art-and-pricing.md` section 3.4).
- `/license/index.html` reads `session_id` from the address, calls `/api/license`, and shows one of these states. The key and the command use IBM Plex Mono.

| State | Text |
|---|---|
| Loading | `Getting your license key…` |
| Issued | Heading `Your relay license`. The key in a block with a `Copy key` button. `Activate it in a terminal:` and the line `relay license activate <key>` with its own `Copy command` button. `Save this key somewhere safe. relay checks it on your computer and never sends it anywhere. This page shows the same key again if you open it later.` |
| Pending | `Your payment is still processing. Your key appears on this page when the payment completes. Reload it later.` |
| Not found | `This link does not lead to a paid order. If you paid, write to the support address on your Stripe receipt.` |
| Error | `Something went wrong on our side. Nothing was charged twice. Reload this page in a minute.` |
| No JavaScript | `This page needs JavaScript to show your key.` |

`staticwebapp.config.json` gains `"platform": { "apiRuntime": "node:22" }` and a route for `/license/*` with the headers `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The deployment that `add-website` sets up names `license-server/dist` as the API folder with the API build skipped: either `api_location: "license-server/dist"` and `skip_api_build: true` in the GitHub Actions workflow, or `swa deploy <site output> --api-location license-server/dist --api-language node --api-version 22` from the Omarchy machine, whichever `add-website` uses, after `bun run build` in `license-server/`.

### 13. Signing keys: creating and rotating them

`license-server/scripts/keygen.ts <kid>` (for example `bun scripts/keygen.ts live-1`):

1. Refuses a `kid` that does not match `^(test|live)-[0-9]+$`, and refuses to overwrite an existing file.
2. Creates an Ed25519 key pair with `generateKeyPairSync("ed25519")`.
3. Writes the private key, PKCS #8 DER in base64, to `./<kid>.signing-key` with mode 0600. It never prints it.
4. Prints one line for `src/license/public-keys.ts`: `"<kid>": "<x>", // gitleaks:allow`.

`.gitignore` gains `*.signing-key` and `license-server/dist/`.

Rotation, if a private key may have leaked: run the script with the next ID (`live-2`), add the new public key to the table, release relay, then set `RELAY_LICENSE_SIGNING_KEY` and `RELAY_LICENSE_KEY_ID` to the new values. Keys signed with `live-1` keep working while `live-1` stays in the table; removing it later withdraws every key it signed, so do that only for a confirmed leak, and reissue keys through the license page (decision 7), which signs with the current key.

### 14. Tests

Source: https://docs.stripe.com/automated-testing ("simulate the output of our interfaces and API requests using mock data"); `openspec/config.yaml` ("Tests never call real providers").

- No automated test calls Stripe or Azure. `test/fakes/stripe.ts` implements `StripeApi` from recorded shapes of Checkout Session and PaymentIntent objects (the response examples in https://docs.stripe.com/api/checkout/sessions/retrieve), with switches for `unpaid`, `no_payment_required`, `expired`, `resource_missing` and network errors, and it counts calls. stripe-mock is not used: its responses are fixed fixtures that cannot express "paid" against "unpaid", and the fake is simpler.
- Webhook tests build a thin event notification body and sign it with the Stripe library's `stripe.webhooks.generateTestHeaderString({ payload, secret })`, using a secret built at run time (`"whsec_" + "test" + random`). They cover a valid signature, a wrong secret, a changed body, a missing header and a timestamp 301 seconds old.
- Every Ed25519 key pair is generated at run time. No key, secret or `rk_` value is committed. Fake Stripe keys are built at run time (`"rk_" + "test_" + "fake"`).
- `test/license/cross-check.test.ts` in the `relay` project signs with `license-server/src/core/sign.ts` and verifies with `src/license/key.ts`, so the two sides cannot drift apart.
- The real runtime is checked twice without Stripe: locally with Azure Functions Core Tools 4.15.2 on Node.js 22 (task 5.3), and on a preview environment of the website without Stripe settings (task 7.3). Both only send requests that end before any Stripe call.
- The test-mode run (task group 8) is the only step that talks to Stripe, in Josué's sandbox, by hand, because Stripe Checkout blocks automated testing.

### 15. Documents

- `docs/licensing.md`: the flow diagram from this file with its explanation; the key format; what `relay` checks and that it never connects; the settings table; the restricted key's permissions; key generation and rotation; how Josué finds a buyer's key again; and the test-mode run.
- `docs/cli.md`: the `license` command and the exit codes 50 and 51.
- `docs/first-version-index.md`: the new command, exit codes, source folders and capabilities.
- `README.md`: one sentence that the core is free and a one-time license unlocks the paid features, linking to `docs/licensing.md`.
- `docs/codebase-map.md`, if it exists by then: `src/license/` and `license-server/`.

## What Josué must do

No agent does these steps. Values never go into chat, the repository or a pull request.

**For the test-mode run (task group 8):**

1. In the Stripe Dashboard, create a sandbox for relay (account picker, **Sandboxes**, **Create**). Stripe recommends a separate sandbox for new integrations (https://docs.stripe.com/sandboxes).
2. In the sandbox, create a product named `relay lifetime license` with one **one-time** price in the currency and amount you choose. Copy the price ID (`price_...`).
3. In the sandbox, create a restricted key named `relay license server` with **Checkout Sessions: Write** and **PaymentIntents: Write**, everything else **None**. Copy it (`rk_test_...`).
4. In Workbench, **Webhooks**, create an event destination: **Your account**, payload **Thin**, events `v1.checkout.session.completed`, `v1.checkout.session.async_payment_succeeded` and `v1.checkout.session.async_payment_failed`, endpoint URL `https://<preview environment host>/api/stripe-webhook` (task 8.1 prints the host). Reveal and copy the signing secret (`whsec_...`).
5. On the Omarchy machine, set the three Stripe values on the preview environment without leaving them in shell history:

   ```sh
   read -rs RK && read -rs WH && read -r PRICE
   az staticwebapp appsettings set --name <app> --environment-name licensetest \
     --setting-names STRIPE_API_KEY="$RK" STRIPE_WEBHOOK_SECRET="$WH" RELAY_STRIPE_PRICE_ID="$PRICE" \
     RELAY_LICENSE_PRICE_IDS="$PRICE" -o none
   unset RK WH PRICE
   ```

**For live mode:**

1. Generate the live signing key on the Omarchy machine: `cd license-server && bun scripts/keygen.ts live-1`. Keep `live-1.signing-key` in your password manager. Give the printed public key line to the loop (it is public), which adds it to `src/license/public-keys.ts` and releases relay.
2. In the Stripe Dashboard in **live** mode, create the product and its one-time price as in test step 2, and copy the live price ID.
3. In live mode, create the restricted key as in test step 3 (`rk_live_...`).
4. In live mode, create the event destination as in test step 4, with the URL `https://<your domain>/api/stripe-webhook`, and copy its signing secret.
5. Set the production settings:

   ```sh
   read -rs RK && read -rs WH && read -r PRICE
   az staticwebapp appsettings set --name <app> --setting-names \
     STRIPE_API_KEY="$RK" STRIPE_WEBHOOK_SECRET="$WH" RELAY_STRIPE_PRICE_ID="$PRICE" \
     RELAY_LICENSE_PRICE_IDS="$PRICE" \
     RELAY_LICENSE_KEY_ID=live-1 RELAY_SITE_URL=https://<your domain> \
     RELAY_LICENSE_SIGNING_KEY="$(cat live-1.signing-key)" -o none
   unset RK WH PRICE && rm live-1.signing-key
   ```

6. Check that only names are visible and that no preview environment holds a live key: `az staticwebapp appsettings list --name <app> --query "keys(properties)"`, and `az staticwebapp appsettings list --name <app> --environment-name licensetest -o json | grep -c rk_live_` must print `0`.
7. In the Dashboard, set the public support email (it appears on receipts, and the license page points buyers to it), and turn on email receipts for successful payments if you want them.
8. Walk through Stripe's go-live checklist (https://docs.stripe.com/get-started/checklist/go-live), make one real purchase with your own card, activate the key with the released `relay`, and refund the purchase in the Dashboard.

## Risks / Trade-offs

- [Secrets are application settings, not Key Vault entries] → a restricted key with two permissions, values only in the environment that needs them, the check in "What Josué must do" step 6, and the rotation steps in decision 13 and https://docs.stripe.com/keys. Moving to a bring-your-own Functions app with Key Vault is possible without changing the handlers.
- [Bundling `@azure/functions` for Node.js may fail at run time] → task 5.3 starts the bundle in the real Functions runtime on the Omarchy machine before any deployment.
- [Static Web Apps or the Functions host might change the webhook's raw body] → the handler reads raw bytes, and the test-mode run (task 8.3) proves real deliveries pass the signature check.
- [Thin event destinations might not be available for these types on Josué's account] → the snapshot fallback in decision 5 changes one function.
- [A key can be shared or the check patched out] → accepted, as the research advises (section 3.2): modest paid features and a fair price.
- [A refund does not switch a key off] → accepted for now (proposal.md, open question 5).
- [The license link gives the key to anyone who has the link] → the link only exists in the buyer's browser after payment and in Josué's support replies, and it is never cached or sent as a referrer.

## Migration Plan

Nothing to migrate. Rolling back means reverting the pull requests and removing the seven application settings. A buyer's `RELAY_HOME/license.key` is ignored by an older `relay`.

## Open Questions

See proposal.md, "Open questions for Josué". None of them blocks building this change in test mode.

## Changes made while building (2026-10-08)

Building task groups 1 to 7 found these points where the design above was out of date or
incomplete. The code and `docs/licensing.md` follow this list.

- **Exit codes.** 50 and 51 instead of 40 and 41, which `add-t3-limit-rules` already uses (decision 10).
- **Verifying webhook signatures.** `StripeApi.parseEventNotification` returns a promise and wraps
  the library's `parseEventNotificationAsync`; the tests sign bodies with
  `generateTestHeaderStringAsync`. Under Bun, stripe 23.0.0 loads its worker build, whose Web
  Crypto provider cannot sign or verify synchronously, so the synchronous calls of decisions 3 and
  14 throw in the tests. The asynchronous calls work with every provider, also on Node.js in Azure.
- **Reading the saved key.** The scaffold's function is `readPrivateFile(path, uid, maxBytes)`;
  there is no `checkPrivateFile` (decision 10).
- **The license page's headers.** The route is `/license*`, not `/license/*`: Static Web Apps does
  not match `/license` (without the final slash) to `/license/*`. The add-website
  Content-Security-Policy had `form-action 'none'` and no `connect-src`, which would block the buy
  form and the license page's call to `/api/license`. The site-wide policy now has
  `form-action 'self' https://checkout.stripe.com` (browsers also check the redirect that follows a
  form), and the `/license*` route adds `connect-src 'self'` (decision 12).
- **The preview environment's name.** Azure keeps only the letters and digits of a preview
  environment's name: `swa deploy --env license-test` creates the environment `licensetest`, and
  every `az staticwebapp ... --environment-name` command uses `licensetest` (tasks 7.2 and 8.1, and
  "What Josué must do", test step 5). `site/scripts/deploy.sh` takes the environment as an optional
  argument and deploys `license-server/dist` as the API.
- **The local smoke test.** On the build machine `mise exec node@22` leaves the system Node.js 26
  first in `PATH`, and Core Tools then fails its first-time setup, so `scripts/smoke.sh` puts Node.js
  22 first in `PATH` itself (task 5.3).
- **Root tests.** The root `bunfig.toml` sets `pathIgnorePatterns = ["license-server/**"]`, because
  its test root is the whole repository and `license-server/` has its own dependencies.
- **Paid features in tests.** The command is built by `licenseCommand(features)`, and the registry
  passes `PAID_FEATURES`, so a test can pass a list with one feature (license-command, "A feature
  added later") without changing the constant.
- **Preview server for the page.** The license page sends only `session_id`, so
  `scripts/page-preview.ts` takes the state from the request's `state` value or else from its
  `session_id` value (task 7.1).
