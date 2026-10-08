# Spec Delta

## Purpose

Claude Code and Codex can run a command when something happens in a session, such as a turn ending
or a rate limit. `relay hook` is that command. It records what happened for relay without ever
slowing down or changing the agent.

## ADDED Requirements

### Requirement: Hook command contract
`relay hook <provider> <event>`, built by `add-provider-adapters` and extended here with delivery to the daemon, SHALL accept `claude` or `codex` as provider and an event name matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, read JSON from standard input, always exit with code 0, write nothing to standard output or standard error, and record its own failures in `logs/hook.log`.

#### Scenario: Unknown provider
- **WHEN** a hook runs `relay hook cursor Stop`
- **THEN** the command exits 0 with no output and `logs/hook.log` gains a line saying the provider is not supported

#### Scenario: Invalid JSON
- **WHEN** standard input is not valid JSON
- **THEN** the command exits 0 with no output and nothing is recorded except a line in `logs/hook.log`

### Requirement: Hooks never block the agent
`relay hook` SHALL stop reading standard input after 200 ms or 1 MiB, SHALL give the daemon 150 ms to accept the event, and SHALL exit 0 no later than 500 ms after it started, whatever happens.

#### Scenario: The daemon hangs
- **WHEN** something accepts connections on the socket but never answers
- **THEN** `relay hook claude Stop` exits 0 within 500 ms and the event is written to the spool file

#### Scenario: Standard input never closes
- **WHEN** the hook's standard input stays open without data
- **THEN** the command exits 0 within 500 ms

### Requirement: Spool when the daemon is down
When the daemon does not accept the event in time, `relay hook` SHALL append it as one JSON line in the spool format of `add-provider-adapters` (`v`, `received_at`, `provider`, `event`, `relay_job`, `relay_target`, `relay_worker`, `profile`, `fields`) to `spool/hooks.jsonl` under `RELAY_HOME` (mode `0600`, directory `0700`), unless that file is larger than 10 MB. When the daemon starts it SHALL rename the spool, wait 1 second, process each line in order, and delete it.

#### Scenario: Limit reached while the daemon is down
- **WHEN** no daemon is running and `relay hook claude StopFailure` receives `{"error":"rate_limit", ...}` from a worker with `RELAY_TARGET=claude:work`
- **THEN** the spool holds the event, and after the daemon starts, `claude:work` shows `rate_limited`

#### Scenario: Spooled while the daemon runs
- **WHEN** the daemon runs but did not answer a hook within 150 ms, so the hook spooled its event
- **THEN** the daemon processes the line within a few seconds, after the next hook event it accepts or its next 2-second check, without waiting for a restart

### Requirement: Interactive workers see their hook events
An interactive worker SHALL see the hook events of its session whether or not the daemon runs: it SHALL read the spool and the `hook` events of its job's `events.jsonl`, which keep `received_at`, `relay_worker`, the provider, the event and the allowed fields, and SHALL handle an event that moved from the spool to `events.jsonl` once.

#### Scenario: Limit with the daemon running
- **WHEN** an interactive Claude Code worker's agent hits a rate limit and its `StopFailure` hook is accepted by the daemon
- **THEN** the worker reports `turn_failed` with reason `rate_limit`, and the spool holds no line for it

#### Scenario: Limit without the daemon
- **WHEN** the same happens with no daemon running
- **THEN** the worker reports `turn_failed` with reason `rate_limit` from the spool line

### Requirement: Only allow-listed fields are kept
The hook SHALL keep only the input fields `session_id`, `cwd`, `hook_event_name`, `error`, `notification_type`, `reason`, `source`, `model` and `turn_id` (the list of `add-provider-adapters`), plus `RELAY_JOB`, `RELAY_TARGET`, `RELAY_WORKER` and the `profile` (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, or `default`). It SHALL NOT keep `error_type`, which Claude Code does not document. All other fields SHALL be dropped before the event is sent, spooled or logged.

#### Scenario: Tool input is dropped
- **WHEN** a `PostToolUse` hook payload contains `tool_input` and `tool_response`
- **THEN** neither field appears in the spool, the daemon's database, `events.jsonl` or any log

### Requirement: Linking hooks to jobs and accounts
The daemon SHALL attribute a hook event to the worker, job and account named by `RELAY_WORKER`, `RELAY_JOB` and `RELAY_TARGET`. Without them it SHALL use the worker whose provider session ID equals `session_id`, then the job whose project root contains `cwd`. An event with no account SHALL NOT change any availability.

#### Scenario: Agent started by relay
- **WHEN** an agent started by relay with `RELAY_WORKER=a41c7b09`, `RELAY_JOB=3f9a2c1d` and `RELAY_TARGET=claude:work` fires `SessionStart`
- **THEN** worker `a41c7b09` of job `3f9a2c1d` records the hook's `session_id` as its provider session ID

#### Scenario: Agent started outside relay
- **WHEN** a `StopFailure` hook arrives with no `RELAY_TARGET` and a `session_id` that no worker has
- **THEN** the event is appended to the matching job's event log if `cwd` is inside a known project, and no account's availability changes

### Requirement: Availability from hook events
The daemon SHALL update the account's availability from these events and no others: Claude `StopFailure` with `error` `rate_limit` sets `rate_limited`; with `billing_error`, `authentication_failed`, `oauth_org_not_allowed` or `account_on_hold` it sets `unavailable`; a Claude `Notification` with `notification_type` `quota_auto_resume_fired` and a Claude or Codex `Stop` set `available`. The reading's source SHALL be `hook`.

#### Scenario: Rate limit
- **WHEN** `relay hook claude StopFailure` receives `error` `rate_limit` for `claude:work`
- **THEN** `claude:work` becomes `rate_limited` with reason "Claude Code reported a rate limit", `retry_at` `null` and source `hook`

#### Scenario: Signed out
- **WHEN** `relay hook claude StopFailure` receives `error` `authentication_failed` for `claude:home`
- **THEN** `claude:home` becomes `unavailable` with reason "Claude Code is signed out of this account"

#### Scenario: A turn finishes normally
- **WHEN** `relay hook codex Stop` arrives for `codex:personal`
- **THEN** `codex:personal` becomes `available` with reason "The last turn finished normally"

#### Scenario: A server error is not a limit
- **WHEN** `relay hook claude StopFailure` receives `error` `server_error`
- **THEN** the event is recorded in the job's event log and the account's availability does not change
