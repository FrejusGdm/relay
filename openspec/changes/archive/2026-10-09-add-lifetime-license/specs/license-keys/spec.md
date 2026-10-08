# Spec Delta

## Purpose

Defines the relay license key: its format, how the license server signs it, and how the `relay` program checks it offline with a built-in public key.

## ADDED Requirements

### Requirement: Key format
A license key SHALL be the text `relay1.<payload>.<signature>`. `<payload>` SHALL be base64url without padding of a JSON object with exactly the keys `v`, `kid`, `product`, `license` and `issued`, in that order and without spaces. `<signature>` SHALL be base64url without padding of the 64-byte Ed25519 signature of the ASCII bytes `relay1.<payload>`. The key SHALL hold no email address, no hash of an email address and no name.

#### Scenario: Payload of a live key
- **WHEN** the server signs license `3f9a2c1d5e7b9a01` issued on 2026-10-07 with key ID `live-1`
- **THEN** the decoded payload is exactly `{"v":1,"kid":"live-1","product":"relay-lifetime","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}`
- **AND** the key starts with `relay1.` and its last part has 86 characters

#### Scenario: No personal data
- **WHEN** a key is signed for a session whose buyer entered an email address
- **THEN** neither the email address nor any hash of it appears in the decoded payload

### Requirement: Deterministic signing
The server SHALL sign keys with Ed25519 through `node:crypto`. Signing the same license ID, issue date and key ID with the same private key SHALL produce the same key text every time.

#### Scenario: Same input, same key
- **WHEN** `signLicenseKey` runs twice with the same arguments
- **THEN** both results are byte for byte identical

### Requirement: Offline check
`verifyLicenseKey` SHALL check a key without any network access. It SHALL remove all whitespace first, then check the format, the key ID, the signature and the product, in that order, and report the first problem as one of `format`, `test_key`, `unknown_key`, `signature` or `product`.

#### Scenario: Valid key with line breaks
- **WHEN** a valid key is passed with a line break and spaces inside it
- **THEN** the result is valid, with the license ID and issue date from the payload

#### Scenario: Changed payload
- **WHEN** one character of the payload part of a valid key is changed so that it still decodes to valid JSON
- **THEN** the problem is `signature`

#### Scenario: Not a key
- **WHEN** the text is `hello`, or longer than 1,024 characters after removing whitespace
- **THEN** the problem is `format`

#### Scenario: Unknown signing key
- **WHEN** a key is signed with key ID `live-9`, which the public key table does not hold
- **THEN** the problem is `unknown_key`

#### Scenario: Another product
- **WHEN** a correctly signed key has `product` set to `relay-cloud`
- **THEN** the problem is `product`

### Requirement: Test keys never unlock relay
A key whose key ID starts with `test-` SHALL be rejected with `test_key`, unless the caller passes `allowTestKeys: true`. The `relay` command SHALL never pass it. The public key table built into `relay` SHALL contain only `live-` key IDs.

#### Scenario: Test key in the relay command
- **WHEN** a key signed with key ID `test-1` is checked by `relay license activate`
- **THEN** the problem is `test_key`, even when the table passed by a test contains `test-1`

#### Scenario: Built-in table
- **WHEN** a test reads `LICENSE_PUBLIC_KEYS`
- **THEN** every key ID in it starts with `live-`

### Requirement: Signer and checker agree
A test in the `relay` project SHALL sign keys with the license server's `signLicenseKey` and check them with `verifyLicenseKey`, using key pairs generated at run time.

#### Scenario: Round trip
- **WHEN** a key pair `live-1` is generated at run time and a key is signed and then checked with its public key
- **THEN** the result is valid
