# Spec Delta

## Purpose

Defines how the license server turns a paid Checkout Session into a license key: its settings, the webhook, the fulfillment function and the license endpoint.

## ADDED Requirements

### Requirement: Server settings
The server SHALL read `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `RELAY_STRIPE_PRICE_ID`, `RELAY_LICENSE_PRICE_IDS`, `RELAY_LICENSE_SIGNING_KEY`, `RELAY_LICENSE_KEY_ID` and `RELAY_SITE_URL`. `STRIPE_API_KEY` SHALL be a restricted key (`rk_test_` or `rk_live_`), which sets the mode. The prefix of `RELAY_LICENSE_KEY_ID` SHALL equal the mode. `RELAY_LICENSE_PRICE_IDS` SHALL be a comma-separated list of price IDs that contains `RELAY_STRIPE_PRICE_ID`. When any setting is missing or wrong, every function SHALL answer 503 with `{"error":"not_configured"}` and log only the names of the wrong settings.

#### Scenario: Secret key refused
- **WHEN** `STRIPE_API_KEY` starts with `sk_test_`
- **THEN** every function answers 503 and the log names `STRIPE_API_KEY` without its value

#### Scenario: Mixed modes refused
- **WHEN** `STRIPE_API_KEY` starts with `rk_live_` and `RELAY_LICENSE_KEY_ID` is `test-1`
- **THEN** every function answers 503

#### Scenario: Current price missing from the list
- **WHEN** `RELAY_STRIPE_PRICE_ID` is `price_B` and `RELAY_LICENSE_PRICE_IDS` is `price_A`
- **THEN** every function answers 503 and the log names `RELAY_LICENSE_PRICE_IDS`

### Requirement: Webhook signature check
`POST /api/stripe-webhook` SHALL verify every request with the Stripe library's `parseEventNotification`, using the raw request bytes, the `Stripe-Signature` header and `STRIPE_WEBHOOK_SECRET`, with a timestamp tolerance of 300 seconds, before reading anything from the body. A request that fails SHALL get 400 with `{"error":"invalid_signature"}` and SHALL cause no Stripe call.

#### Scenario: Valid event
- **WHEN** a `v1.checkout.session.completed` notification signed with the right secret arrives for a paid session
- **THEN** the fulfillment function runs and the response is 200 with `{"received":true}`

#### Scenario: Forged or changed event
- **WHEN** the body is signed with another secret, or one byte of a signed body is changed, or the header is missing
- **THEN** the response is 400 and the fake Stripe client saw no call

#### Scenario: Old event
- **WHEN** the signature's timestamp is 301 seconds old
- **THEN** the response is 400

### Requirement: Events handled
The webhook SHALL run fulfillment for `v1.checkout.session.completed` and `v1.checkout.session.async_payment_succeeded`, log and accept `v1.checkout.session.async_payment_failed`, and accept and ignore every other type. An event whose `livemode` differs from the settings' mode SHALL be accepted with 200 and logged. A Stripe error during fulfillment SHALL get 500, so that Stripe retries.

#### Scenario: Delayed payment succeeds later
- **WHEN** `v1.checkout.session.completed` arrives while the session is unpaid, and later `v1.checkout.session.async_payment_succeeded` arrives after it is paid
- **THEN** the first delivery issues nothing and the second issues the key

#### Scenario: Stripe unavailable
- **WHEN** retrieving the session throws a connection error
- **THEN** the response is 500

### Requirement: Fulfillment rules
`fulfillCheckout` SHALL retrieve the Checkout Session with `line_items` and `payment_intent` expanded, and SHALL issue a key only when the session's `mode` is `payment`, its `livemode` matches the settings' mode, its metadata `relay_product` is `relay-lifetime` and `relay_license_id` has 16 lowercase hexadecimal characters, it has exactly one line item whose price is in `RELAY_LICENSE_PRICE_IDS` and whose quantity is 1, its `status` is `complete`, and its `payment_status` is not `unpaid`. The issue date SHALL be the UTC date of the session's `created` time.

#### Scenario: Paid session
- **WHEN** the session is complete and paid
- **THEN** the result is `issued` with a key for the session's license ID and creation date

#### Scenario: Another product in the same Stripe account
- **WHEN** the session has no `relay_product` metadata, or its price is not in `RELAY_LICENSE_PRICE_IDS`
- **THEN** the result is `rejected` and no key is issued

#### Scenario: Bought at an earlier price
- **WHEN** a paid session's price is `price_A`, `RELAY_LICENSE_PRICE_IDS` is `price_A,price_B` and `RELAY_STRIPE_PRICE_ID` is now `price_B`
- **THEN** the result is `issued`

#### Scenario: Unpaid
- **WHEN** the session is complete with `payment_status` `unpaid`
- **THEN** the result is `pending`

#### Scenario: Expired or not finished
- **WHEN** the session's `status` is `expired` or `open`
- **THEN** the result is `not_found`

#### Scenario: Malformed session ID
- **WHEN** the session ID is `cs_live_x` while the settings are in test mode, or does not start with `cs_`
- **THEN** the result is `not_found` and no Stripe call is made

### Requirement: Safe to repeat
Running `fulfillCheckout` any number of times, including at the same moment, for the same session SHALL return the same key and leave the same record. The record SHALL be the PaymentIntent metadata `relay_license_issued` and `relay_license_key_id`, written when either field differs from the current values, with the idempotency key `relay-license-<session ID>-<key ID>`.

#### Scenario: Duplicate deliveries
- **WHEN** the same event is delivered three times, and the license page asks once
- **THEN** all four results hold the same key
- **AND** every metadata update the fake Stripe client recorded has the same values and the idempotency key `relay-license-<session ID>-live-1`

#### Scenario: After a signing key rotation
- **WHEN** the PaymentIntent records `relay_license_issued=2026-10-07` and `relay_license_key_id=live-1`, the settings now use `live-2`, and the license page asks again
- **THEN** the returned key is signed with `live-2`
- **AND** the fake Stripe client recorded one metadata update with `relay_license_key_id=live-2` and the idempotency key `relay-license-<session ID>-live-2`

### Requirement: License endpoint
`GET /api/license?session_id=<id>` SHALL run `fulfillCheckout` and answer 200 with `{"state":"issued","key":...,"license":...,"issued":...}`, 202 with `{"state":"pending"}`, 404 with `{"state":"not_found"}` for `not_found` and `rejected`, or 503 when the settings are wrong or Stripe fails. Every response SHALL carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

#### Scenario: Buyer returns from Checkout
- **WHEN** the license page asks for a paid session
- **THEN** the response is 200 with the key and the three headers

#### Scenario: Rejected session hidden
- **WHEN** the session belongs to another product
- **THEN** the response is 404 with `{"state":"not_found"}`, the same as a missing session

### Requirement: Nothing secret leaves the server
No response and no log line SHALL contain a setting's value, the raw webhook body, the buyer's email address or, in logs, the license key text.

#### Scenario: Planted values
- **WHEN** the tests run every handler path with secrets built at run time
- **THEN** none of those secrets, and no email address from the fake session, appears in any response body or captured log line
