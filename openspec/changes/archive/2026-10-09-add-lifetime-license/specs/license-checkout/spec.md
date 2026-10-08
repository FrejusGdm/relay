# Spec Delta

## Purpose

Defines `POST /api/checkout`, the license server function that starts a Stripe Checkout payment for one lifetime license.

## ADDED Requirements

### Requirement: One-time Checkout Session
`POST /api/checkout` SHALL create a Stripe Checkout Session with `mode` `payment`, one line item with the price `RELAY_STRIPE_PRICE_ID` and quantity 1, `success_url` `<RELAY_SITE_URL>/license/?session_id={CHECKOUT_SESSION_ID}`, `cancel_url` `<RELAY_SITE_URL>/#buy`, `submit_type` `pay`, the metadata `relay_product=relay-lifetime` and `relay_license_id=<16 lowercase hexadecimal characters>` on both the session and `payment_intent_data`, and `integration_identifier` `relay-lifetime-checkout-qhvbtmzr`. It SHALL then answer 303 with `Location` set to the session's URL.

#### Scenario: Buyer starts a payment
- **WHEN** the browser posts the buy form to `/api/checkout`
- **THEN** the fake Stripe client receives exactly the parameters above, with a new license ID
- **AND** the response is 303 with the session's URL in `Location`

#### Scenario: Two clicks
- **WHEN** the form is posted twice
- **THEN** two sessions are created with two different license IDs

### Requirement: Parameters relay never sends
The Checkout Session SHALL NOT include `payment_method_types`, `customer`, `customer_creation`, `automatic_tax` or `allow_promotion_codes`, and it SHALL NOT use subscription mode.

#### Scenario: Request body checked
- **WHEN** a test inspects the parameters given to the fake Stripe client
- **THEN** none of those keys is present and `mode` is `payment`

### Requirement: Errors and other methods
A method other than `POST` SHALL get 405. Wrong settings SHALL get 503 with `{"error":"not_configured"}`. A Stripe error SHALL get 502 with the page text `Payment could not start. Nothing was charged. Try again in a minute.`

#### Scenario: GET request
- **WHEN** a browser opens `/api/checkout` with GET
- **THEN** the response is 405

#### Scenario: Stripe unavailable
- **WHEN** the fake Stripe client throws a connection error
- **THEN** the response is 502 with that text and no secret appears in it
