# Spec Delta

## Purpose

Tests must never call a real provider. This capability defines the fake agent programs and the in-process fake adapter that imitate Claude Code and Codex closely enough that relay's real adapters, parsers and commands are tested instead of bypassed.

## ADDED Requirements

### Requirement: Fake programs speak the real formats
The test suite SHALL include `fake-claude` and `fake-codex`, programs that accept the same command lines relay uses with the real tools and print the same formats: Claude Code's stream JSON for `-p` mode, Codex's app-server JSON-RPC messages, and `codex exec --json` lines. Tests select them with `RELAY_CLAUDE_BIN` and `RELAY_CODEX_BIN`.

#### Scenario: The real adapter runs against the fake
- **WHEN** a test sets `RELAY_CLAUDE_BIN` to `fake-claude` and starts a headless Claude worker
- **THEN** the Claude Code adapter's own stream parser reads the fake's output and emits `session_started` with the fake's session ID

#### Scenario: Version and status commands
- **WHEN** the adapter runs `fake-codex --version` and `fake-codex login status`
- **THEN** the fake prints `codex-cli 0.160.0` and a signed-in status taken from the scenario file, and exits 0

### Requirement: Scenario files
A fake program SHALL follow the scenario file named by `RELAY_FAKE_SCENARIO`. A scenario holds a list of turns, and each turn a list of steps: `say`, `run` (a command and its exit code), `write` (a file path and content, written into the working directory), `limit`, `crash`, `exit`, `hang`, `finish`, `stderr`, `raw`, `approval` and `ignore_sigterm`. Without a scenario the fake finishes each turn with one sentence.

#### Scenario: Writing a file
- **WHEN** a scenario step is `{"write":"src/a.ts","content":"export const a = 1;\n"}`
- **THEN** the file `src/a.ts` in the worker's working directory holds that content, and the fake prints the tool events the real tool would print for an edit

#### Scenario: Raw output for parser tests
- **WHEN** a scenario step is `{"raw":"{not json"}`
- **THEN** the fake prints exactly `{not json` followed by a newline

### Requirement: Simulated usage limit with a reset time
A `limit` step SHALL make the fake end the turn the way the real tool does at a usage limit, including the reset time given in the step: Claude's `rate_limit_event` with status `rejected` and `resetsAt`, an assistant event with `error` `rate_limit` and a failed result; Codex's `turn/completed` with status `failed` and `codexErrorInfo` `usageLimitExceeded`, and `account/rateLimits/read` answers that show the window at 100 percent with that `resetsAt`.

#### Scenario: Codex limit
- **WHEN** a scenario step is `{"limit":{"window":"primary","resets_at":"2026-10-07T15:45:00Z"}}` and relay drives `fake-codex app-server`
- **THEN** relay receives `turn/completed` with `turn.status` `failed` and `turn.error.codexErrorInfo` `usageLimitExceeded`, and a following `account/rateLimits/read` returns `primary.usedPercent` 100 and `primary.resetsAt` 1791387900

### Requirement: Simulated refusal to stop
An `ignore_sigterm` step SHALL make the fake keep running when it receives `SIGTERM`, so tests can check the `SIGKILL` path of the adapter's `stop` operation.

#### Scenario: SIGTERM ignored
- **WHEN** a fake that ran an `ignore_sigterm` step receives `SIGTERM`
- **THEN** it keeps running until it receives `SIGKILL`

### Requirement: Simulated crash
A `crash` step SHALL make the fake kill itself with the given signal, and an `exit` step SHALL make it exit with the given code, without printing a final result.

#### Scenario: Crash in the middle of a turn
- **WHEN** a scenario step is `{"crash":{"signal":"SIGKILL"}}`
- **THEN** the fake process ends by `SIGKILL` and its last printed line is the step before the crash

### Requirement: Simulated slow start and hang
The scenario field `startup_delay_ms` SHALL delay the fake's first output by that many milliseconds. A `hang` step SHALL make the fake print nothing more until it receives an interrupt, which it SHALL handle the way the real tool does.

#### Scenario: Slow start
- **WHEN** `startup_delay_ms` is 3000
- **THEN** the fake's first line appears no sooner than 3 seconds after it started

#### Scenario: Interrupt during a hang
- **WHEN** `fake-claude -p` is in a `hang` step and receives `SIGINT`
- **THEN** it prints a result marking the turn as interrupted and waits for more input or end of input, as Claude Code does

### Requirement: The fake records what it received
When `RELAY_FAKE_RECORD` names a file, the fake SHALL write to it, as JSON, its arguments, its working directory, the names (never the values) of its environment variables, the values of `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `RELAY_JOB` and `RELAY_TARGET`, whether standard input was a terminal, a pipe or at end of file, and every input line or JSON-RPC request it read.

#### Scenario: Credential variables are checked
- **WHEN** relay starts a fake worker while its own environment holds `ANTHROPIC_API_KEY=sk-test-1`
- **THEN** the record's environment names do not include `ANTHROPIC_API_KEY`, and the text `sk-test-1` appears nowhere in the record

### Requirement: The fake runs installed hooks and status line
`fake-claude` SHALL read `settings.json` in its configuration folder and run the configured command hooks for SessionStart, Stop, StopFailure, Notification, SessionEnd and PreCompact, and the `statusLine` command, with the JSON inputs the real tool documents. `fake-codex` SHALL do the same for `hooks.json` hooks that its scenario marks as trusted.

#### Scenario: StopFailure reaches relay hook
- **WHEN** relay's hooks are installed in a fake profile and a scenario reaches a usage limit
- **THEN** the fake runs `relay hook claude StopFailure` with standard input containing `"hook_event_name":"StopFailure"` and `"error":"rate_limit"`, and the spool file gains that event

#### Scenario: Untrusted Codex hooks do not run
- **WHEN** relay's hooks are written to a fake Codex profile and the scenario does not mark them as trusted
- **THEN** `fake-codex` does not run them, and `hooks/list` reports their `trustStatus` as `untrusted`

### Requirement: In-process fake adapter
The test helpers SHALL provide a fake adapter that implements the full adapter interface in memory from the same scenario format, for tests of code that uses adapters. The release binary SHALL contain no fake adapter and no fake program.

#### Scenario: Later phases use the fake adapter
- **WHEN** a test builds an adapter registry with the fake adapter for `claude` and runs a scenario that reaches a limit
- **THEN** the code under test receives `turn_failed` with reason `usage_limit` without any process being started

#### Scenario: The release build has no fake
- **WHEN** the release binary is built with `bun build --compile`
- **THEN** the strings `fake-claude`, `fake-codex` and `RELAY_FAKE_SCENARIO` do not appear in it

### Requirement: Controlled clock
relay's code that compares times (reset times, log age, staleness) SHALL read the time through one clock that tests can set, so that a five-hour reset is tested in milliseconds.

#### Scenario: Moving past a reset
- **WHEN** a test sets the clock to 15:44, records a limit that resets at 15:45, then sets the clock to 15:46
- **THEN** the account's availability changes from `quota_exhausted` to `unknown` with no real waiting

### Requirement: Tests cannot reach real providers
The test setup SHALL make any attempt to run the real `claude` or `codex` program fail the test, and SHALL remove credential environment variables before any test runs.

#### Scenario: A test forgets the fake
- **WHEN** a test starts a Claude worker without setting `RELAY_CLAUDE_BIN`
- **THEN** the guard program first on `PATH` runs instead of Claude Code, prints "A test tried to run the real claude program.", and the test fails
