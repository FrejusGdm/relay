# Spec Delta

## Purpose

Claude Code and Codex release new versions almost every day, and their output formats change. This capability defines the shared tests every adapter must pass and the recorded fixture files that make a format change fail a test instead of breaking a person's work.

## ADDED Requirements

### Requirement: One shared contract suite
Every adapter SHALL pass the same contract suite, run with `bun test test/adapters`. The suite SHALL check, for each adapter: session ID first, failure reasons with reset times, tolerance of unknown and broken lines, interrupt, resume, send or its refusal, standard input, working directory, environment cleaning, invisible-character removal, and that declared capabilities match behaviour.

#### Scenario: A new adapter joins the suite
- **WHEN** an adapter is registered in `test/adapters/registry.ts` with its fake program and fixtures
- **THEN** `bun test test/adapters` runs every contract check against it without new test code

#### Scenario: Declared capability not honoured
- **WHEN** an adapter declares `cleanInterrupt` true but its interrupt kills the process instead of ending the turn
- **THEN** the contract check "interrupt ends the turn and keeps the process" fails for that adapter

### Requirement: Fixture layout
Each fixture SHALL be a folder `test/fixtures/providers/<provider>/<transport>/<name>/` holding `output.jsonl` (the lines the tool printed, or for the app server each message with its direction), `expected-events.json` (the worker events the adapter must emit) and `meta.json` with `provider`, `transport`, `tool_version`, `recorded_at`, `source` (`recorded` or `documentation`), `command` and `redactions`.

#### Scenario: A documentation fixture is labelled
- **WHEN** a fixture was written from the shapes quoted in the provider's documentation rather than recorded
- **THEN** its `meta.json` has `"source": "documentation"` and the test output names it as a documentation fixture

### Requirement: Fixtures replay to the expected events
For every fixture, the adapter's parser SHALL produce exactly the events in `expected-events.json`, compared after removing times that the adapter adds itself.

#### Scenario: Codex usage-limit fixture
- **WHEN** the fixture `codex/app-server/usage-limit` is replayed
- **THEN** the adapter emits `turn_failed` with reason `usage_limit`, the `retryAt` given by the fixture's `account/rateLimits/read` answer, and source `provider_api`

#### Scenario: A format change breaks a test
- **WHEN** a new Claude Code version renames the field `session_id` in its `system` `init` event and a fixture recorded from it is added
- **THEN** the replay of that fixture fails with a message naming the fixture and the first event that differs

### Requirement: Required fixtures
Each adapter SHALL have at least these fixtures for each headless transport: a normal turn with a command and a file edit, a usage limit with a reset time, an authentication failure, an interrupted turn and a resumed session. The Codex adapter SHALL also have a rate-limit reading and a hook list with trust statuses.

#### Scenario: Missing fixture
- **WHEN** the folder `test/fixtures/providers/claude/print/usage-limit` does not exist
- **THEN** `bun test test/adapters` fails with "claude/print is missing the required fixture usage-limit."

### Requirement: Recording real fixtures is opt-in
`bun run scripts/record-fixture.ts <provider> <transport> <name>` SHALL run the real tool only when `RELAY_RECORD=1` is set, in a new temporary git repository, with a short fixed prompt, and SHALL print how the recording may use the person's plan before it starts. It SHALL never run as part of `bun test` or CI.

#### Scenario: Recording without permission
- **WHEN** the person runs `bun run scripts/record-fixture.ts claude print normal-turn` without `RELAY_RECORD=1`
- **THEN** the script prints "Recording runs the real claude program and uses your plan. Set RELAY_RECORD=1 to continue." and exits 2 without starting any program

### Requirement: Recordings are redacted and scanned
Before writing a recorded fixture, the script SHALL replace the home folder path with `/home/user`, replace email addresses and the fields `accountId`, `email`, `organization_id` and `account_uuid` with `"redacted"`, list every replacement in `meta.json` `redactions`, and run the secret scanner on the result. A finding SHALL stop the script with nothing written.

#### Scenario: An email in the output
- **WHEN** the recorded output contains `josue@example.com`
- **THEN** `output.jsonl` contains `redacted` in its place and `meta.json` lists one email redaction

### Requirement: Tested versions follow the fixtures
Each adapter SHALL keep `src/adapters/<provider>/tested-versions.json` listing the tool versions that have recorded fixtures, and the suite SHALL fail when a recorded fixture's `tool_version` is missing from that list. The oldest listed version is the oldest version relay accepts.

#### Scenario: New recording for a new version
- **WHEN** a fixture recorded with Codex 0.161.0 is added and `tested-versions.json` lists only `0.160.0`
- **THEN** the suite fails with "codex fixture normal-turn was recorded with 0.161.0, which is not in tested-versions.json."

### Requirement: Codex protocol drift check
`bun run scripts/check-codex-protocol.ts` SHALL run `codex app-server generate-json-schema --out <temporary folder>` with the installed Codex and check that every method, field and enumeration value the Codex adapter uses still exists, listing any that are missing. It SHALL be run by hand before relay is used with a new Codex version, not in CI.

#### Scenario: A field was renamed
- **WHEN** the installed Codex no longer has the field `developerInstructions` in `ThreadStartParams`
- **THEN** the script prints "Missing in Codex <version>: ThreadStartParams.developerInstructions" and exits 1
