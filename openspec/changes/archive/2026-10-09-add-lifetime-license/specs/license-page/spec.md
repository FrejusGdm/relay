# Spec Delta

## Purpose

Defines the website parts of the license: the buy button and the license page that shows the key after payment.

## ADDED Requirements

### Requirement: Buy button
The website's buy section SHALL have `id="buy"` and a form that posts to `/api/checkout` with a button labelled `Buy a lifetime license`. The page SHALL describe the payment as a purchase with a price, never as a donation.

#### Scenario: Form works without JavaScript
- **WHEN** a browser with JavaScript turned off submits the buy form
- **THEN** the browser follows the 303 redirect to Stripe Checkout

### Requirement: License page states
`/license/` SHALL read `session_id` from its address, call `/api/license`, and show the texts of design decision 12 for the states loading, issued, pending, not found and error, and a `<noscript>` text. In the issued state it SHALL show the key, a `Copy key` button, the command `relay license activate <key>` and a `Copy command` button.

#### Scenario: Issued
- **WHEN** `/api/license` answers 200 with a key
- **THEN** the page shows the key and the activation command, both in IBM Plex Mono

#### Scenario: Pending
- **WHEN** `/api/license` answers 202
- **THEN** the page shows `Your payment is still processing. Your key appears on this page when the payment completes. Reload it later.`

#### Scenario: Not found
- **WHEN** `/api/license` answers 404, or the address has no `session_id`
- **THEN** the page shows `This link does not lead to a paid order. If you paid, write to the support address on your Stripe receipt.`

### Requirement: The license address is not shared
The website SHALL serve `/license/` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and the page SHALL load no script from another site.

#### Scenario: Headers on the deployed page
- **WHEN** `curl -sI https://<host>/license/` runs against the preview environment
- **THEN** the response has both headers
