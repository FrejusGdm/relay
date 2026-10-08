# Spec Delta

## Purpose

Defines the `relay license` command: activating, showing and removing the license on one computer, the saved key file, the list of paid features, and the exit codes 50 and 51 (first proposed as 40 and 41, which `add-t3-limit-rules` already uses).

## ADDED Requirements

### Requirement: License command
`relay` SHALL accept the command `license` with one action, `activate`, `status` or `remove`, and, for `activate` only, an optional key. Any other action, or a second argument after `status` or `remove`, SHALL be a usage error with exit code 2. The top-level help SHALL list `license` after `doctor` with the summary `Add, check or remove your relay license`.

#### Scenario: Unknown action
- **WHEN** the person runs `relay license show`
- **THEN** standard error shows `relay: license needs activate, status or remove, not "show".` and relay exits with code 2

#### Scenario: Extra argument
- **WHEN** the person runs `relay license status relay1.abc`
- **THEN** standard error shows `relay: license status takes no other argument.` and relay exits with code 2

#### Scenario: Help
- **WHEN** the person runs `relay license --help`
- **THEN** standard output equals `test/cli/golden/license.txt` and relay exits with code 0

### Requirement: Activating a license
`relay license activate <key>` SHALL check the key with `verifyLicenseKey` and, when it is valid, save it to `RELAY_HOME/license.key` with mode 0600 by writing a temporary file and renaming it. When no key is given and standard input is not a terminal, relay SHALL read at most 4,096 bytes of standard input as the key. When no key is given and standard input is a terminal, it SHALL be a usage error.

#### Scenario: Valid key
- **WHEN** the person runs `relay license activate <valid key>` for license `3f9a2c1d5e7b9a01` issued 2026-10-07
- **THEN** standard output shows `License activated.`, `License ID: 3f9a2c1d5e7b9a01`, `Issued: 2026-10-07` and `relay keeps the key in <file> and checks it on this computer only.`
- **AND** `RELAY_HOME/license.key` holds the key with mode 0600
- **AND** relay exits with code 0

#### Scenario: Key from standard input
- **WHEN** the person runs `printf '%s\n' <valid key> | relay license activate`
- **THEN** relay saves the key and exits with code 0

#### Scenario: No key at a terminal
- **WHEN** the person runs `relay license activate` with standard input attached to a terminal
- **THEN** standard error shows `relay: license activate needs a key. Run "relay license activate <key>", or pipe the key into it.` and relay exits with code 2

#### Scenario: Replacing a key
- **WHEN** license `aaaaaaaaaaaaaaaa` is saved and the person activates a valid key for license `bbbbbbbbbbbbbbbb`
- **THEN** the first line of output is `License activated. It replaces license aaaaaaaaaaaaaaaa.`

#### Scenario: Invalid key
- **WHEN** the person runs `relay license activate hello`
- **THEN** standard error shows `relay: this is not a relay license key. Copy the whole key; it starts with "relay1.".`
- **AND** nothing is saved and relay exits with code 50

#### Scenario: Test key
- **WHEN** the person activates a correctly signed key with key ID `test-1`
- **THEN** standard error shows `relay: this license key comes from Stripe test mode and does not unlock relay.` and relay exits with code 50

### Requirement: License status
`relay license status` SHALL report the saved license and every paid feature. It SHALL exit 0 when a valid license is saved, 51 when none is saved, and 50 when the saved key is not valid.

#### Scenario: Active license
- **WHEN** a valid key is saved and `PAID_FEATURES` is empty
- **THEN** standard output is `License: active`, `License ID: <id>`, `Issued: <date>` and `Paid features: none yet`, and relay exits with code 0

#### Scenario: No license
- **WHEN** no key is saved
- **THEN** standard output is `License: none`, `relay's core is free and stays free. A license unlocks the paid features.` and `Paid features: none yet`
- **AND** relay exits with code 51

#### Scenario: Damaged saved key
- **WHEN** `license.key` holds a key whose signature check fails
- **THEN** standard error shows `relay: the saved license in <file> is not valid: this license key failed its signature check. Copy it again from your license page.` and `Run "relay license remove", then activate your key again.`
- **AND** relay exits with code 50

#### Scenario: Unsafe saved key file
- **WHEN** `license.key` has mode 0666
- **THEN** relay reports the settings error from the `relay-config` permission check and exits with code 78

### Requirement: Removing a license
`relay license remove` SHALL delete `RELAY_HOME/license.key` and exit 0, also when no key is saved.

#### Scenario: Remove a saved key
- **WHEN** a key is saved and the person runs `relay license remove`
- **THEN** standard output is `License removed.`, the file is gone, and relay exits with code 0

#### Scenario: Nothing to remove
- **WHEN** no key is saved
- **THEN** standard output is `No license was saved. Nothing changed.` and relay exits with code 0

### Requirement: Public key table from the command context
The `license` command SHALL read the public key table from its command context, which `runCli` fills with `LICENSE_PUBLIC_KEYS`. Only the `licensePublicKeys` option of the in-process test helper SHALL replace it; no flag, setting or environment variable SHALL change it.

#### Scenario: Real test-mode key in a test
- **WHEN** `RELAY_TEST_LICENSE_KEY` holds a key signed with `test-1` and `RELAY_TEST_LICENSE_PUBLIC_KEY` holds its public key, and `test/license/test-mode-key.test.ts` runs `relay license activate` in process with the table `{"test-1": <that public key>}`
- **THEN** relay exits with code 50 and prints the test-mode message, not code 69

#### Scenario: Environment cannot add a key
- **WHEN** the built `relay` runs with `RELAY_TEST_LICENSE_PUBLIC_KEY` set
- **THEN** its table is still `LICENSE_PUBLIC_KEYS`

### Requirement: Builds without a public key
While `LICENSE_PUBLIC_KEYS` is empty, `relay license activate` and `relay license status` SHALL print `relay: this version of relay cannot check license keys yet.` and exit with code 69.

#### Scenario: Empty table
- **WHEN** the command runs with an empty public key table
- **THEN** relay prints that message on standard error and exits with code 69

### Requirement: One list of paid features
The paid features SHALL be defined only by the constant `PAID_FEATURES` in `src/license/features.ts`, and whether a feature is unlocked SHALL be decided only by `featureUnlocked`. In this change the list SHALL be empty, and no relay behaviour SHALL depend on a license.

#### Scenario: A feature added later
- **WHEN** a test passes a list with one feature named `Automatic failover` and a valid license
- **THEN** `relay license status` prints `Paid features: Automatic failover`

#### Scenario: Nothing is locked
- **WHEN** no license is saved
- **THEN** every other relay command behaves exactly as it does with a license

### Requirement: No network and no secrets in logs
`relay license` SHALL never open a network connection, and SHALL never write the key text to a log file.

#### Scenario: No connection
- **WHEN** `activate`, `status` and `remove` run in a test that replaces `globalThis.fetch` with a recorder
- **THEN** the recorder saw no call

#### Scenario: Key not logged
- **WHEN** the person runs `relay license activate <valid key>`
- **THEN** `cli.log` contains `license activated` with the license ID and does not contain the key text

### Requirement: Exit codes 50 and 51
`src/cli/exit-codes.ts` SHALL define `LicenseInvalid` as 50 and `LicenseMissing` as 51, and `docs/cli.md` and `docs/first-version-index.md` SHALL list them.

#### Scenario: Table matches
- **WHEN** the exit-code test of `add-cli-scaffold` parses `docs/cli.md`
- **THEN** it finds 50 and 51 with the same names as the constants
