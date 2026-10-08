# Spec Delta

## Purpose

The Codex adapter drives the Codex program the person installed, through the Codex app server first and `codex exec` as a fallback, and reads Codex's own usage windows and reset times, so relay knows when a Codex account stops and when it comes back.

## ADDED Requirements

### Requirement: App server is the default headless transport
For a headless worker the adapter SHALL start `codex app-server` with the account's environment and the job root as working directory, send `initialize` with `clientInfo` `{"name":"relay","title":"relay","version":"<relay version>"}` and `capabilities` `{"experimentalApi":false,"requestAttestation":false}`, then the `initialized` notification, and send no other request before `initialize` is answered.

#### Scenario: Handshake
- **WHEN** relay starts a headless worker on `codex:personal`
- **THEN** the first message `fake-codex app-server` receives is `initialize` with `clientInfo.name` `relay`, and the second is the `initialized` notification

### Requirement: Starting a thread and a turn
The adapter SHALL call `thread/start` with `cwd`, `sandbox` (`workspace-write` for `edit-in-workspace`, `read-only` for `read-only`), `approvalPolicy` `never`, `developerInstructions` set to relay's instructions, and `model` when given, then `turn/start` with `threadId` and `input` `[{"type":"text","text":<prompt>,"text_elements":[]}]`. The thread's `id` SHALL be the provider session ID.

#### Scenario: Session ID from the thread
- **WHEN** `thread/start` answers with `thread.id` `0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31`
- **THEN** the adapter emits `session_started` with that ID before sending `turn/start`

### Requirement: App-server notifications become worker events
The adapter SHALL map `item/completed` items of type `agentMessage` to `message`, `commandExecution` to `tool` with its `command`, `exitCode` and status, and `fileChange` to `tool` with the changed paths; `item/started` of type `commandExecution` to `tool` with status `started`; `turn/completed` to `turn_completed` or `turn_failed`; and `account/rateLimits/updated` to `limit_update`. An `error` notification with `willRetry` true SHALL be logged only.

#### Scenario: A command and an edit
- **WHEN** the app server sends `item/completed` with `{"type":"commandExecution","command":"bun test","exitCode":0,"status":"completed"}` and then `{"type":"fileChange","changes":[{"path":"src/a.ts","kind":"update","diff":"..."}],"status":"completed"}`
- **THEN** the adapter emits `tool` with command `bun test` and exit code 0, then `tool` with paths `["src/a.ts"]`

#### Scenario: A retried error is not a failure
- **WHEN** the app server sends `error` with `willRetry` true and later `turn/completed` with status `completed`
- **THEN** the adapter emits `turn_completed` and no `turn_failed`

### Requirement: Failed turns and the usage-limit error
For `turn/completed` with status `failed`, the adapter SHALL map `turn.error.codexErrorInfo` `usageLimitExceeded` to `usage_limit`, `rateLimitExceeded` to `rate_limit`, `serverOverloaded` to `overloaded`, `unauthorized` to `auth`, `contextWindowExceeded` to `context_full`, and any other value to `other`. Status `interrupted` SHALL map to `interrupted`.

#### Scenario: Usage limit reached
- **WHEN** a turn completes with status `failed` and `codexErrorInfo` `usageLimitExceeded`
- **THEN** the adapter calls `account/rateLimits/read` once and emits `turn_failed` with reason `usage_limit`, source `provider_api`, and `retryAt` from that answer

### Requirement: Reset time after a limit
The `retryAt` of a Codex limit SHALL be the latest `resetsAt` among the windows of `rateLimits` whose `usedPercent` is 100 or more. When no window is at 100 percent, `retryAt` SHALL be absent; relay SHALL NOT guess a reset time from lower percentages.

#### Scenario: Weekly window full
- **WHEN** `primary` has `usedPercent` 40 and `resetsAt` 1791387900, and `secondary` has `usedPercent` 100 and `resetsAt` 1791820800
- **THEN** `retryAt` is 1791820800 (Unix seconds)

### Requirement: Codex availability from the app server
For an account's availability the adapter SHALL start `codex app-server` with that account's environment, call `account/rateLimits/read`, and stop the process within 10 seconds. A non-null `rateLimitReachedType` or `ordinaryUsageAllowed` false SHALL give `quota_exhausted`; `ordinaryUsageAllowed` true SHALL give `available`; `ordinaryUsageAllowed` null SHALL give `unknown`. Windows SHALL always be reported.

#### Scenario: Usage allowed
- **WHEN** the answer has `ordinaryUsageAllowed` true, `rateLimitReachedType` null, and `primary` at 62 percent with `windowDurationMins` 300
- **THEN** availability is `available` with a window named `five_hour` (300 minutes) at 62 percent and source `provider_api`

#### Scenario: Server does not say
- **WHEN** the answer has `ordinaryUsageAllowed` null and `rateLimitReachedType` null
- **THEN** availability is `unknown` with the detail "Codex did not say whether usage is allowed." and the windows it returned

#### Scenario: Not signed in
- **WHEN** the app server answers `account/rateLimits/read` with an error because the profile is not signed in
- **THEN** availability is `unavailable` with the detail "Codex is not signed in on this account. Run relay account login codex:<name>."

### Requirement: Sending, interrupting and resuming through the app server
The adapter SHALL send a message with `turn/steer` (with `expectedTurnId`) while a turn runs and with `turn/start` otherwise, interrupt with `turn/interrupt` and the current `threadId` and `turnId`, and resume with `thread/resume` passing `threadId`, `cwd`, `sandbox`, `approvalPolicy` and `developerInstructions` again.

#### Scenario: Interrupt
- **WHEN** relay interrupts a running Codex turn `turn_456` of thread `thr_123`
- **THEN** the app server receives `{"method":"turn/interrupt","id":<n>,"params":{"threadId":"thr_123","turnId":"turn_456"}}` and the adapter emits `turn_failed` with reason `interrupted` when `turn/completed` arrives with status `interrupted`

### Requirement: Approval requests are never answered by relay
When the app server sends `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` or `mcpServer/elicitation/request`, the adapter SHALL emit `approval_needed` and SHALL NOT send any decision. `relay run --headless` then interrupts the turn and stops the worker.

#### Scenario: Codex asks to run a command
- **WHEN** a headless Codex worker receives `item/commandExecution/requestApproval` for `rm -rf build`
- **THEN** relay prints "Codex is asking for permission: run rm -rf build. relay does not answer permission requests, so it stopped this run." and no response to that request is ever sent

### Requirement: codex exec fallback
When `codex app-server` exits before answering `initialize`, does not answer within 15 seconds, or answers `thread/start` with method-not-found, the adapter SHALL use `codex exec --json -C <root> -s <sandbox> -c developer_instructions=<TOML string> [-m <model>] <prompt>` with standard input at end of file. `RELAY_CODEX_TRANSPORT=exec` SHALL force this transport.

#### Scenario: App server unavailable
- **WHEN** `fake-codex app-server` exits with code 2 at once
- **THEN** relay prints "The Codex app server did not start, so relay is using codex exec. Reset times will not be available for this run." and starts `codex exec`

#### Scenario: exec events
- **WHEN** `codex exec --json` prints `thread.started` with `thread_id`, then `item.completed` with an `agent_message`, then `turn.completed` with `usage`
- **THEN** the adapter emits `session_started` with the `thread_id`, `message`, and `turn_completed` with the token usage

### Requirement: Limits in codex exec mode come from the message text
In `codex exec` mode the adapter SHALL report `usage_limit` when `turn.failed` or `error` contains "hit your usage limit" (with a straight or curly apostrophe before "ve"), with `retryAt` parsed from "try again at <time>" when it can be read, and source `message_text`. Exit code 1 without such text SHALL be `other`.

#### Scenario: Plus plan message
- **WHEN** `turn.failed` has the message "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM."
- **THEN** the adapter emits `turn_failed` with reason `usage_limit`, `retryAt` at the next 15:45 local time, and source `message_text`

### Requirement: Resuming in codex exec mode
In `codex exec` mode the adapter SHALL resume with `codex exec resume <session ID> --json -c sandbox_mode="<sandbox>" -c developer_instructions=<TOML string> <prompt>`, run with the job root as working directory and standard input at end of file.

#### Scenario: Resume command line
- **WHEN** relay resumes thread `0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31` with the exec transport
- **THEN** `fake-codex` receives the arguments `exec resume 0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31 --json` followed by the two `-c` settings and the prompt

### Requirement: Interactive Codex
For an interactive worker the adapter SHALL run `codex -C <root> -c developer_instructions=<TOML string> [<prompt>]` (or `codex resume <session ID>` with the same settings) attached to the person's terminal. The provider session ID SHALL come from the `session_id` of the first `SessionStart` hook event recorded for this worker, and SHALL stay unknown when no such event arrives.

#### Scenario: Hooks not trusted yet
- **WHEN** an interactive Codex worker ends and no `SessionStart` hook event was recorded for it
- **THEN** relay prints "relay could not learn the Codex session ID because its hooks are not active. Run relay hooks status codex:<name>." and the worker record has `provider_session_id` null

### Requirement: Codex hooks need the person's trust
After writing hooks for a Codex account, relay SHALL tell the person to trust them once in Codex's `/hooks` screen, and SHALL report their state from the app server's `hooks/list` `trustStatus` of relay's entries: `trusted`, `untrusted` or `modified`. relay SHALL never use `--dangerously-bypass-hook-trust`.

#### Scenario: After installation
- **WHEN** relay has just written its hooks to `codex:personal`'s `hooks.json`
- **THEN** relay prints "Codex asks you to trust new hooks once. Open Codex with this account (CODEX_HOME=<profile> codex), type /hooks, and trust the relay hooks."

#### Scenario: Status after trust
- **WHEN** `hooks/list` returns relay's five hooks with `trustStatus` `trusted`
- **THEN** `relay hooks status codex:personal` prints "Hooks: installed and trusted"
