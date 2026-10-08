# Spec Delta

## Purpose

Defines relay's own log files: where they are, the JSON-lines format every relay log uses, which events the command line records, how files rotate, and what relay must never write to a log.

## ADDED Requirements

### Requirement: Log file locations
relay SHALL write its logs under `<relay folder>/logs/`: `cli.log` for every command except `relay hook`, and `hook.log` for `relay hook`. The `logs` folder SHALL be created with mode 0700 and each log file SHALL be created with mode 0600. Help, version and usage errors SHALL write no log, except usage errors of `relay hook`, which go to `hook.log`.

#### Scenario: First command
- **WHEN** the relay folder is empty and the person runs `relay status`
- **THEN** `logs/` exists with mode 0700 and `logs/cli.log` exists with mode 0600

#### Scenario: Help writes nothing
- **WHEN** the person runs `relay status --help`
- **THEN** no file under `logs/` is created or changed

### Requirement: Line format
Each log entry SHALL be one JSON object on one line, ended by a newline. Every entry SHALL start with the keys `ts` (UTC time in ISO 8601 with milliseconds), `level` (`debug`, `info`, `warn` or `error`), `msg` (a short plain-English event name), `pid`, `invocation` (8 lowercase hexadecimal characters shared by every entry of one run) and `version`, followed by the event's own fields.

#### Scenario: Parsing a line
- **WHEN** a test reads any line of `cli.log` and parses it as JSON
- **THEN** the object has `ts` matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, a `level` from the four values, a non-empty `msg`, a numeric `pid`, an `invocation` matching `^[0-9a-f]{8}$` and a `version` equal to the package version

### Requirement: Command events
Every command that gets past argument checking SHALL log `command started` with `command`, `options` (the names of the options given, without values) and `arguments` (how many). It SHALL log `settings loaded` with `path`, `exists`, `accounts` and `projects` (counts), or `settings invalid` at level `warn` with `path` and `problems` (a count). It SHALL end with `command finished` with `exit_code` and `duration_ms`.

#### Scenario: A command that is not built yet
- **WHEN** the person runs `relay checkpoint -m "secret plan"` with one account and no projects
- **THEN** `cli.log` gains `command started` with `"command":"checkpoint"`, `"options":["message"]` and `"arguments":0`
- **AND** it gains `settings loaded` with `"exists":true`, `"accounts":1` and `"projects":0`
- **AND** it gains `command finished` with `"exit_code":69`
- **AND** the text `secret plan` does not appear in the file

### Requirement: Unexpected errors are logged
An error that no command handles SHALL be logged as `unexpected error` at level `error` with `error_name` and `stack`, before relay exits with code 70. `stack` SHALL hold only the stack frames. relay SHALL NOT log the error message, neither as a field nor as the first line of the stack, because later adapters may throw errors that quote a command line or a provider's output.

#### Scenario: A thrown error
- **WHEN** a command throws `TypeError: x is undefined`
- **THEN** `cli.log` gains an `unexpected error` entry with `"error_name":"TypeError"` and a `stack` made of stack frames
- **AND** the text `x is undefined` does not appear in any file under `logs/`

### Requirement: Log levels
relay SHALL write an entry only when its level is at or above the active log level, in the order `debug`, `info`, `warn`, `error`. The active level is chosen as the relay-config capability describes.

#### Scenario: Warn level
- **WHEN** the active level is `warn` and the person runs `relay status` with valid settings
- **THEN** `cli.log` gains no `command started` entry

### Requirement: What logs never contain
relay SHALL NOT write to any log file: environment variables or their values, argument or option values, values from `config.toml`, the content of standard input, error messages, or provider credentials. Only names, counts, paths of relay's own files, exit codes and times SHALL be logged. The one exception is `relay hook`, which SHALL log its provider argument only when it is a supported provider, and its event argument only when it is one of the hook event names relay knows for that provider, and `null` otherwise.

#### Scenario: Planted credential
- **WHEN** `ANTHROPIC_API_KEY=sk-ant-test-123` and `OPENAI_API_KEY=sk-test-456` are set and the person runs `relay status`, `relay switch codex:personal` and `relay hook claude Stop`
- **THEN** neither `sk-ant-test-123` nor `sk-test-456` appears in any file under `logs/`

#### Scenario: Unknown hook event
- **WHEN** an agent runs `relay hook claude` followed by a word that is not a Claude Code hook event
- **THEN** `hook.log` gains `"event":null` and the word does not appear in any file under `logs/`

#### Scenario: Hook input
- **WHEN** `relay hook claude Stop` receives `{"session_id":"abc-123"}` on standard input
- **THEN** `abc-123` does not appear in any file under `logs/`

### Requirement: Rotation
Before writing an entry that would make a log file larger than 10 MB (10,485,760 bytes), relay SHALL rename the file to `<name>.1`, shift older files up to `<name>.5`, delete the oldest, and start a new file with mode 0600. At most 5 older files SHALL be kept per log.

#### Scenario: Full log
- **WHEN** `cli.log` is 10,485,700 bytes and relay writes a 100-byte entry
- **THEN** the old content is in `cli.log.1`, `cli.log` holds only the new entry, and no `cli.log.6` exists

### Requirement: Logging failures do not change the outcome
If relay cannot create or write a log file, it SHALL print `relay: could not write to the log <file>: <reason>. Continuing without it.` once to standard error, except in `relay hook`, which stays silent. It SHALL then finish the command with the exit code it would have had.

#### Scenario: Read-only logs folder
- **WHEN** `logs/` has mode 0500 and the person runs `relay status` with valid settings
- **THEN** standard error shows the warning once and the "not built yet" message
- **AND** relay exits with code 69
