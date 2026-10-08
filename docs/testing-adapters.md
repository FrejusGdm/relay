# Testing adapters with fake agents

Tests never start the real Claude Code or Codex. They start two fake programs instead,
`test/fakes/fake-claude.ts` and `test/fakes/fake-codex.ts`, which accept the command lines relay uses
and print the output formats of Claude Code 2.1.282 and Codex 0.160.0. A scenario file tells a fake
what to do in each turn. Code that only needs an adapter, and no process, uses the in-process fake
adapter in `test/fakes/fake-adapter.ts`, which follows the same scenario files.

This page describes the variables that select the fakes, the guard programs, the scenario format
with one example per step, what each fake prints, the record a fake writes, and the release check.
The design is decision 17 of `openspec/changes/add-provider-adapters/design.md`.

## Variables

| Variable | Read by | What it does |
|---|---|---|
| `RELAY_CLAUDE_BIN` | relay | The program relay starts instead of the `claude` found on `PATH`. Tests set it to the absolute path of `test/fakes/fake-claude.ts`. |
| `RELAY_CODEX_BIN` | relay | The same for `codex`. Tests set it to the absolute path of `test/fakes/fake-codex.ts`. |
| `RELAY_FAKE_SCENARIO` | the fakes | The scenario file a fake follows. Without it, every turn says one sentence and finishes. |
| `RELAY_FAKE_RECORD` | the fakes | A file where the fake writes what it received (see "The record"). |

relay starts a program by its absolute path, so a fake must be executable. Both fakes start with
`#!/usr/bin/env bun` and are committed with the executable bit.

relay removes every variable whose name starts with `RELAY_FAKE_` from an agent's environment,
unless the test harness sets `RELAY_KEEP_FAKE_ENV=1` (design decision 6). A test that starts a fake
through relay sets `RELAY_KEEP_FAKE_ENV=1`; a test that starts a fake directly passes the variables
itself.

## Guard programs

The test preload `test/setup.ts` puts `test/fixtures/fake-provider/guard-bin/` first on `PATH`. That
folder holds two scripts named `claude` and `codex`. A test that forgets to set `RELAY_CLAUDE_BIN` or
`RELAY_CODEX_BIN` therefore starts a guard program instead of a real agent. The guard prints
`Tests must not start the real claude. Use test/fixtures/fake-provider instead.` (or `codex`) to
standard error and exits with code 97, which fails the test. The preload also removes credential
variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and gives each test run its own home
folder and relay folder.

## Scenario files

A scenario is a JSON object. `test/fakes/scenario.ts` defines its type and checks it; a scenario
that does not pass the check stops the fake with exit code 2 and a message that names the turn and
the step, for example `Turn 1, step 2 is not a valid step: say must be text.`

```json
{
  "version": 1,
  "tool_version": "0.160.0",
  "startup_delay_ms": 0,
  "session_id": "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31",
  "auth": { "signed_in": true, "method": "ChatGPT" },
  "login": { "succeed": true },
  "rate_limits": {
    "primary": { "used_percent": 62, "window_minutes": 300, "resets_at": "2026-10-07T15:45:00Z" },
    "secondary": { "used_percent": 20, "window_minutes": 10080, "resets_at": "2026-10-12T16:00:00Z" },
    "reached": null,
    "ordinary_usage_allowed": true
  },
  "hooks_trusted": true,
  "app_server": "ok",
  "turns": [
    { "steps": [{ "say": "I will run the tests." }, { "run": "bun test", "exit_code": 0 }, { "finish": true }] },
    { "steps": [{ "limit": { "window": "primary", "resets_at": "2026-10-07T15:45:00Z" } }] }
  ]
}
```

Every field except `version` and `turns` is optional.

| Field | Meaning |
|---|---|
| `version` | Always 1. |
| `tool_version` | The version that `--version` prints, for example `2.1.100` to test a version that is too old. Default: `2.1.282` for `fake-claude`, `0.160.0` for `fake-codex`. |
| `startup_delay_ms` | The fake waits this long before its first output. |
| `session_id` | The session or thread ID the fake reports. For `fake-claude` it wins over `--session-id`, so a test can make the fake report another ID than relay passed. |
| `auth` | What `claude auth status` and `codex login status` report. Default: signed in. |
| `login` | Whether `claude auth login` and `codex login` succeed. Default: they succeed. |
| `rate_limits` | What Codex's `account/rateLimits/read` returns before any limit step. `primary` is the five-hour window and `secondary` the seven-day window. |
| `hooks_trusted` | Whether `fake-codex` treats the hooks in `hooks.json` as trusted: `true`, `false`, or `"modified"` for hooks that changed after the person trusted them. Codex runs only trusted hooks. Default: not trusted. |
| `app_server` | How `fake-codex app-server` behaves: `ok`, `exit_immediately` (exits with code 2 before reading anything), `no_answer` (reads but never answers) or `method_not_found` (answers `thread/start` with error code -32601). |
| `turns` | One entry per turn, in order. Turn 1 runs for the first user message, turn 2 for the second, and so on. A turn the list does not have says `I finished the task.` and finishes. |

A turn ends at a `finish`, `limit` or `error` step, or after its last step. A turn that ends
without a limit or an error ends successfully.

## Steps

Each step is a JSON object with one of the keys below. The examples are checked by
`test/docs/testing-doc.test.ts`.

`say` prints an assistant message.

```json
{ "say": "I fixed the failing test." }
```

`run` reports a command and its exit code (default 0) after `delay_ms` (default 0). The fakes do
not run the command.

```json
{ "run": "bun test", "exit_code": 1, "delay_ms": 200 }
```

`write` writes a file, relative to the worker's working directory, and reports an edit. A path that
leaves the working directory, also through a symbolic link, stops the fake.

```json
{ "write": "src/a.ts", "content": "export const a = 1;\n" }
```

`limit` ends the turn at a usage limit that resets at `resets_at`. `window` is `primary` or
`five_hour` for the five-hour window, `secondary` or `seven_day` for the seven-day window. With
`"kind": "rate"` the fake reports a short rate limit instead, without a reset time.

```json
{ "limit": { "window": "primary", "resets_at": "2026-10-07T15:45:00Z", "kind": "usage" } }
```

`error` ends the turn with an API error: `authentication_failed`, `overloaded`, `billing_error` or
`server_error`.

```json
{ "error": "overloaded" }
```

`crash` makes the fake kill itself with `SIGKILL` or `SIGSEGV`, without a final result.

```json
{ "crash": { "signal": "SIGKILL" } }
```

After a `SIGSEGV`, the system may write a core dump of the whole Bun process, which took 26 seconds
on the build machine. A test that uses `SIGSEGV` should start the fake with core dumps
turned off: `Bun.spawn(["sh", "-c", 'ulimit -c 0; exec "$@"', "sh", fakePath, ...args])`. `exec`
keeps the process ID, so the test still holds the fake itself.

`exit` makes the fake exit with the given code at once, without a final result.

```json
{ "exit": 3 }
```

`hang` makes the fake print nothing more until the turn is interrupted: `SIGINT` for `fake-claude`
and for `fake-codex exec` and interactive mode, `turn/interrupt` for `fake-codex app-server`.

```json
{ "hang": true }
```

`finish` ends the turn successfully; later steps of the turn do not run.

```json
{ "finish": true }
```

`stderr` prints a line to standard error.

```json
{ "stderr": "warning: something odd happened" }
```

`raw` prints exactly this text and a newline to standard output, for parser tests.

```json
{ "raw": "{not json" }
```

`approval` makes the agent ask for permission to run a command or to change a file (exactly one of
`command` and `path`). See the table below for what each fake does with it.

```json
{ "approval": { "command": "rm -rf build" } }
```

`ignore_sigterm` makes the fake ignore `SIGTERM` from then on, so a test can check that relay sends
`SIGKILL` when its time limit passes.

```json
{ "ignore_sigterm": true }
```

`status_line` runs Claude Code's status line with these usage percentages and reset time. Only
interactive `fake-claude` runs it; the other modes ignore the step.

```json
{ "status_line": { "five_hour": 20, "seven_day": 100, "resets_at": "2026-10-12T16:00:00Z" } }
```

`notification` runs Claude Code's Notification hook with this `notification_type`. `fake-codex`
ignores it, because Codex has no such hook.

```json
{ "notification": "quota_auto_resume_fired" }
```

## fake-claude

| Command line | What the fake does |
|---|---|
| `--version` | Prints `2.1.282 (Claude Code)`, or the scenario's `tool_version`. |
| `auth status --json` | Prints JSON with `loggedIn`, `authMethod`, `email` and `configDirectory`; exits 0 when signed in, 1 when not. |
| `auth login` | Prints `Login successful.` and exits 0, or exits 1 when the scenario says the login fails. |
| `-p --input-format stream-json --output-format stream-json --verbose …` | Headless mode: reads one JSON user message per line and prints stream JSON. Without `--verbose` it prints Claude Code's own error and exits 1. |
| anything else | Interactive mode: reads plain text lines (tests use a pipe, not a terminal) and prints plain text. |

Both modes accept `--session-id`, `--resume`, `--permission-mode`, `--permission-prompts`,
`--append-system-prompt`, `--model` and one prompt argument, and refuse any other option, so a
bypass flag such as `--dangerously-skip-permissions` fails at once.

In headless mode the fake prints `system`/`init` when the first turn starts, then for each step:

| Step | Stream JSON lines |
|---|---|
| `say` | an `assistant` event with a text block |
| `run` | an `assistant` event with a `Bash` `tool_use` block, then a `user` event with a `tool_result` (`is_error` true when the exit code is not 0) |
| `write` | a `Write` `tool_use` block with the absolute `file_path`, then its `tool_result` |
| `approval` | a `tool_use` block, a `tool_result` with `is_error` true, and an entry in the result's `permission_denials` (headless Claude Code denies anything that would prompt) |
| `limit` | `rate_limit_event` with status `rejected`, `resetsAt` in Unix seconds and `rate_limit_type`; an `assistant` event with `"error":"rate_limit"` and the text `You've hit your session limit · resets 3:45pm` (or `weekly … Mon 12:00am`) in local time; a `result` with `is_error` true |
| `error` | an `assistant` event with that `error` value, then a `result` with `is_error` true |
| end of the turn | a `result` with `subtype` `success`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage` and `permission_denials` |

`SIGINT` during a turn ends it with a `user` message `[Request interrupted by user]` and a result
with subtype `error_during_execution`; the fake then waits for more input, as Claude Code does.
`SIGTERM` ends the fake at once with exit code 143 and no result. At the end of standard input the
fake exits with code 1 when its last result was an error, otherwise 0.

The fake reads `settings.json` in `CLAUDE_CONFIG_DIR` (or `~/.claude`) and runs the command hooks for
SessionStart, Stop, StopFailure, Notification and SessionEnd with the JSON inputs Claude Code
documents: `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name`, plus
`source` for SessionStart, `last_assistant_message` for Stop, `error`, `error_details` and
`last_assistant_message` for StopFailure, `message` and `notification_type` for Notification, and
`reason` for SessionEnd. A limit or an error runs StopFailure instead of Stop, and an interrupted turn
runs neither. In interactive mode the fake also runs the `statusLine` command with `rate_limits`
for each `status_line` step.

## fake-codex

| Command line | What the fake does |
|---|---|
| `--version` | Prints `codex-cli 0.160.0`, or the scenario's `tool_version`. |
| `login status` | Prints `Logged in using ChatGPT` (or the scenario's method) and exits 0, or prints `Not logged in` and exits 1. |
| `login` | Exits 0, or 1 when the scenario says the login fails. |
| `app-server` | JSON-RPC over standard input and output, one message per line, without a `jsonrpc` field. |
| `exec --json -C <root> -s <sandbox> -c <key=value> [-m <model>] <prompt>` | Prints `codex exec --json` events. Without a prompt argument it reads the prompt from standard input. |
| `exec resume <id> --json -c <key=value> <prompt>` | The same for a resumed session. `-C` and `-s` are refused here, as in Codex 0.160.0. |
| `[resume <id>] -C <root> -c <key=value> [<prompt>]` | Interactive mode: reads plain text lines and prints plain text. |

Unknown options such as `--full-auto` or `--dangerously-bypass-approvals-and-sandbox` stop the fake
with exit code 2, as Codex's argument parser does.

The app server answers `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
`turn/interrupt`, `account/rateLimits/read` and `hooks/list`. A request sent before `initialize`
gets the error `Not initialized`. For each step it sends:

| Step | App-server notifications | `codex exec --json` lines |
|---|---|---|
| `say` | `item/started`, `item/agentMessage/delta` and `item/completed` of an `agentMessage` | `item.completed` with an `agent_message` |
| `run` | `item/started` and `item/completed` of a `commandExecution` with `command`, `exitCode` and `status` | `item.started` and `item.completed` with a `command_execution` |
| `write` | `item/started` and `item/completed` of a `fileChange` with `changes` | `item.completed` with a `file_change` |
| `approval` | the request `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`; the turn waits for an answer | a `command_execution` with status `declined` or a failed `file_change` (exec never asks) |
| `limit` | `account/rateLimits/updated`, an `error` notification, then `turn/completed` with status `failed` and `codexErrorInfo` `usageLimitExceeded` | an `error` line and `turn.failed` with `You’ve hit your usage limit. … try again at 3:45 PM.` |
| `error` | an `error` notification and a failed `turn/completed` with `codexErrorInfo` `unauthorized`, `serverOverloaded`, `other` or `internalServerError` | an `error` line and `turn.failed` |
| end of the turn | `thread/tokenUsage/updated`, then `turn/completed` with status `completed` | `turn.completed` with `usage` |

After a `limit` step, `account/rateLimits/read` shows that window at 100 percent with the step's
reset time and `ordinaryUsageAllowed` false. `hooks/list` lists the command hooks of `hooks.json` in
`CODEX_HOME` (or `~/.codex`) with `trustStatus` `trusted`, `untrusted` or `modified` from
`hooks_trusted`.
When the hooks are trusted, the fake runs SessionStart, Stop, Interrupt and SessionEnd hooks in
every mode, with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `turn_id` and `model`,
plus `source` for SessionStart.

`codex exec` exits with code 1 after a failed or interrupted turn and 0 otherwise.

## The record

When `RELAY_FAKE_RECORD` names a file, a fake writes a JSON record there as soon as it starts and
rewrites it each time it reads a line. `test/fakes/record.ts` writes and reads it.

| Field | Content |
|---|---|
| `argv` | The fake's arguments. |
| `cwd` | Its working directory. |
| `env_names` | The names of its environment variables, sorted. The values are never written. |
| `env` | The values of `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `RELAY_JOB` and `RELAY_TARGET`, or null. |
| `stdin` | `terminal`, `pipe` or `eof`: what its standard input was when it started. |
| `input` | Every line it read from standard input, in order: user messages, or JSON-RPC requests, notifications and responses. |

## The in-process fake adapter

`createFakeAdapter({ provider, scenario, clock })` returns an object that implements
`ProviderAdapter` from `src/adapters/types.ts` for `claude` or `codex` without starting any process.
Its workers turn the scenario's steps into worker events directly: a `limit` step gives
`limit_update` and `turn_failed` with reason `usage_limit` and the reset time, a `hang` step waits for
`interrupt()` or `stop()`, and so on. `availability()` reports the last reading, and reports
`unknown` once the clock passes a recorded reset time. The clock is the one the test injects, or
relay's own `now()` from `src/platform/clock.ts`, which a test can set with `setClock()`. Tests of code that uses adapters
build an adapter registry with it, for example
`createAdapterRegistry({ claude: createFakeAdapter({ provider: "claude", scenario }) })` from
`src/adapters/registry.ts`.

## The release check

`bash scripts/check-release-binary.sh` builds relay with the release flags into `dist/relay` and
searches the program's text for `fake-claude`, `fake-codex` and `RELAY_FAKE_SCENARIO`. It exits 1
when it finds any of them, so a fake can never ship. CI runs it after each release build.

## What is not verified

The fakes follow the formats that Claude Code's and Codex's documentation and Codex's generated
protocol types describe (`docs/research/provider-control-surfaces.md` sections 1 and 2). Some
details are not documented and were chosen for the fakes: the exact fields of
`claude auth status --json`, the text of `codex login status`, the fields of Codex's `hooks/list`
answer other than `trustStatus`, the texts of API errors, and the token numbers. Fixtures recorded
from the real tools (task 10.3) will show where the fakes differ, and the fakes will then be changed
to match.
