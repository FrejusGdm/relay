# Spec Delta

## Purpose

The Claude Code adapter drives the `claude` program the person installed, headless through `claude -p` in stream-JSON mode and interactively in the person's own terminal, and reads the limit signals Claude Code documents, so relay knows when a Claude account stops and when it resets.

## ADDED Requirements

### Requirement: Headless command line
For a headless worker the adapter SHALL run `claude -p --input-format stream-json --output-format stream-json --verbose --session-id <id> --permission-mode <mode> --permission-prompts none --append-system-prompt <instructions>`, adding `--model <name>` when given. The mode SHALL be `acceptEdits` for `edit-in-workspace` and `dontAsk` for `read-only`.

#### Scenario: Default headless start
- **WHEN** relay starts a headless worker on `claude:work` at the default permission level
- **THEN** `fake-claude` receives exactly those flags with `--permission-mode acceptEdits`, and `--verbose` is present

### Requirement: Session ID chosen in advance
The adapter SHALL create a random UUID version 4 for every new Claude session, pass it with `--session-id`, record it before the process starts, and check that the `session_id` of the `system` `init` event matches it.

#### Scenario: Known before the first event
- **WHEN** a headless or interactive Claude worker starts
- **THEN** the worker record holds the provider session ID before the agent prints anything

#### Scenario: Claude reports a different ID
- **WHEN** the `init` event carries a `session_id` different from the one relay passed
- **THEN** relay records the ID from the event, and the worker log notes the mismatch

### Requirement: Stream events become worker events
The adapter SHALL map `system` `init` to `session_started`; `assistant` text blocks to `message`; `assistant` `tool_use` blocks to `tool` with status `started` (with `input.command` for Bash and `input.file_path` for Edit, Write, MultiEdit and NotebookEdit); `user` `tool_result` blocks to `tool` with status `completed` or, when `is_error` is true, `failed`; `result` to `turn_completed` or `turn_failed`; and each `permission_denials` entry of `result` to `permission_denied`.

#### Scenario: A successful result
- **WHEN** the stream ends a turn with `{"type":"result","subtype":"success","is_error":false,"session_id":"…","num_turns":3,"duration_ms":41000,"total_cost_usd":0.21,"usage":{…}}`
- **THEN** the adapter emits `turn_completed` with the token usage, `durationMs` 41000 and `costUsd` 0.21, marked as an estimate

### Requirement: Limit signals in the stream
The adapter SHALL emit `limit_update` for each `rate_limit_event`, using `rate_limit_info.status`, `resetsAt`, `utilization` and `rate_limit_type` when present. A failed turn SHALL get its reason from the last `assistant` `error`: `rate_limit` gives `usage_limit` when a reset time is known from a `rejected` `rate_limit_event` or the limit message, and `rate_limit` otherwise; `overloaded`, `authentication_failed` and `billing_error` give `overloaded`, `auth` and `billing`.

#### Scenario: Rejected with a reset time
- **WHEN** the stream holds `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791387900,"rate_limit_type":"five_hour"}}`, then an `assistant` event with `"error":"rate_limit"`, then a `result` with `is_error` true
- **THEN** the adapter emits `limit_update` with a `five_hour` window, then `turn_failed` with reason `usage_limit`, `retryAt` 2026-10-07T15:45:00Z and source `stream_event`

#### Scenario: Temporary limit on Anthropic's side
- **WHEN** the last `assistant` error is `overloaded`
- **THEN** `turn_failed` has reason `overloaded`, and the account's availability does not become `quota_exhausted`

### Requirement: Reset times in either unit
A numeric `resetsAt` or `resets_at` below 1000000000000 SHALL be read as Unix seconds and any larger number as Unix milliseconds; a string SHALL be read as an ISO 8601 time. A value that cannot be read SHALL leave `retryAt` absent.

#### Scenario: Milliseconds
- **WHEN** `resetsAt` is 1791387900000
- **THEN** `retryAt` is 2026-10-07T15:45:00Z

### Requirement: Limit message as a last resort
When no structured reset time exists, the adapter SHALL read the reset time from result or assistant text matching "You've hit your <session|weekly|Opus|Sonnet> limit · resets <time>" (straight or curly apostrophe), taking the next occurrence of that local time, and SHALL mark the reading's source as `message_text`.

#### Scenario: Weekly limit text
- **WHEN** the result text is "You've hit your weekly limit · resets Mon 12:00am" on Saturday 2026-10-10
- **THEN** `retryAt` is Monday 2026-10-12 at 00:00 local time with source `message_text`

### Requirement: Sending and ending headless input
The adapter SHALL send each message as one line `{"type":"user","message":{"role":"user","content":<text>},"parent_tool_use_id":null}` ending in a newline, and SHALL close standard input when a turn has finished and no message is waiting.

#### Scenario: Second message before the first turn ends
- **WHEN** relay sends a second message while the first turn is running
- **THEN** the line is written at once, and standard input stays open until the turn for that message has finished

### Requirement: Interrupting a headless Claude turn
The adapter SHALL interrupt by sending `SIGINT` to its child. When no `result` arrives within 10 seconds it SHALL send `SIGTERM`, and when the process still runs 5 seconds later, `SIGKILL`. An exit with code 143 after relay's `SIGTERM` SHALL be reported as `interrupted`, and an exit by a signal relay did not send as `crashed`.

#### Scenario: Clean interrupt
- **WHEN** `fake-claude` answers `SIGINT` with an interrupted result
- **THEN** the adapter emits `turn_failed` with reason `interrupted`, sends no `SIGTERM`, and the process keeps running until its input is closed

### Requirement: Resuming a Claude session
The adapter SHALL resume with `--resume <session ID>` in place of `--session-id`, and SHALL pass every other flag of the original start again, because Claude Code does not restore them on resume. A session ID that is not a UUID SHALL be refused with "The session ID to resume is not a UUID, so relay did not start the agent." before any process starts.

#### Scenario: Headless resume
- **WHEN** relay resumes session `7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f` headless
- **THEN** `fake-claude` receives `--resume 7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f` and not `--session-id`

### Requirement: Interactive launch in the person's terminal
For an interactive worker the adapter SHALL run `claude --session-id <id> --append-system-prompt <instructions> [-- <prompt>]` (or `--resume <id>` in place of `--session-id`) with the person's terminal as standard input, output and error, and with no permission flag. A prompt that is one word SHALL get a space at its end, because Claude Code runs a subcommand whose name equals the first argument after `--`.

#### Scenario: Prompt that looks like an option or a command
- **WHEN** the prompt is `--permission-mode=bypassPermissions now`, or the one word `update`
- **THEN** `fake-claude` receives `--` followed by `--permission-mode=bypassPermissions now`, or by `update `, as the last argument, and runs it as the prompt

#### Scenario: Person types directly
- **WHEN** the person runs `relay run claude:work` in a terminal
- **THEN** Claude Code's own interface appears in that terminal, and relay prints nothing while it runs

### Requirement: Stop reasons of interactive sessions from hooks
While an interactive Claude worker runs, relay SHALL read hook events recorded for its session ID: `StopFailure` gives `turn_failed` with its `error` field mapped as in the stream, `Stop` gives `turn_completed`, and `Notification` with `notification_type` `quota_auto_resume_fired` marks the account available again.

#### Scenario: Interactive session hits its limit
- **WHEN** the hook spool receives `StopFailure` with `"error":"rate_limit"` and this worker's session ID
- **THEN** relay records `turn_failed` with reason `rate_limit` and source `hook`, and the account becomes `rate_limited`, with `retryAt` from the latest status-line reading when that reading shows a window at 100 percent

### Requirement: Status-line rate limits
When relay's status line is installed for an account, each reading SHALL update the account's windows from `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage` and `resets_at`). A window at 100 percent or more SHALL make the account `quota_exhausted` with that `resets_at`; otherwise the account SHALL be `available`. The source SHALL be `status_line`.

#### Scenario: Seven-day window full
- **WHEN** the status line receives `"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1791387900},"seven_day":{"used_percentage":100,"resets_at":1791820800}}`
- **THEN** the account is `quota_exhausted` with `retryAt` 1791820800 and two windows, `five_hour` at 20 percent and `seven_day` at 100 percent

### Requirement: Automatic wait at the limit is left alone
relay SHALL NOT change Claude Code's `autoContinueAtUsageLimit` setting or pass a setting that changes it. An interactive session waiting for its reset SHALL be shown as rate limited until a `Notification` hook with `quota_auto_resume_fired`, a status-line reading or a successful turn says otherwise.

#### Scenario: Claude continues by itself
- **WHEN** an interactive session waited at its limit and the spool receives `Notification` with `notification_type` `quota_auto_resume_fired`
- **THEN** the account becomes `available` with the detail "Claude Code continued after its reset."

### Requirement: No undocumented usage reading
The Claude Code adapter SHALL NOT call any web address directly and SHALL NOT read Claude Code's transcript or status files. Outside a running session its availability SHALL come only from readings recorded earlier by relay's hooks, status line or headless runs.

#### Scenario: Status with no recent reading
- **WHEN** the person runs `relay account status claude:home` and no reading was ever recorded for it
- **THEN** availability shows "unknown (no reading yet)" and no network request is made
