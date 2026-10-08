# Spec Delta: t3-thread-actions

## Purpose

When a `switch` rule is crossed, the work running on that account in T3 Code should move to the other provider without the person being awake, without cutting an agent off in the middle of a step when it can be avoided, and only in projects the person chose.

## ADDED Requirements

### Requirement: Enabling a project
`relay t3 enable <folder>` SHALL require a connection, find the T3 project whose `workspaceRoot` is that folder (after resolving symbolic links), and, for each account named by a `switch_to` rule that is not on the allow list of the folder's `[[projects]]` entry, ask the first-handoff question of `provider-allow-list` (creating the entry with the T3 instance accounts if none exists). It SHALL then add the folder to `t3.projects` and print `relay now watches the T3 threads of <title>. In T3 Code, also turn on Settings → Auto-resume limited threads, so that threads continue when a limit resets.` `relay t3 disable <folder>` SHALL remove it.

#### Scenario: Enable with a new target
- **WHEN** the weekly rule of `claude:personal` switches to `codex:personal`, which is not on the folder's allow list, and the person answers `y`
- **THEN** `codex:personal` is added to the allow list with a `provider_allowed` event whose `how` is `terminal`, and the folder is in `t3.projects`

#### Scenario: Not a T3 project
- **WHEN** no T3 project has that folder as `workspaceRoot`
- **THEN** standard error shows `relay: T3 Code has no project in <folder>. Add the folder in T3 Code first.` and relay exits with code 2

#### Scenario: Answer no
- **WHEN** the person answers no to the first-handoff question
- **THEN** the folder is still enabled, the rule is marked blocked for it, and relay prints `relay will not move this project's threads to codex:personal. Run relay t3 enable <folder> again to change that.`

### Requirement: Which threads a switch applies to
While a `switch` rule of an account is crossed, the daemon SHALL list the threads of every enabled project every 60 seconds and SHALL apply the rule to each thread whose `providerInstanceId` maps to that account and whose current turn is active (`preparing`, `queued`, `starting`, `running` or `waiting`) or whose latest turn ended after the crossing was recorded. Threads of other projects, threads on other accounts, and idle threads whose latest turn ended before the crossing SHALL NOT be touched. A rule whose target is not on the project's allow list SHALL NOT act on that project's threads.

#### Scenario: Idle thread left alone
- **WHEN** a thread on `claude:personal` finished its last turn an hour before the crossing
- **THEN** relay does not change it

#### Scenario: A turn starts later
- **WHEN** after the crossing the person or a scheduled task starts a new turn in a thread on `claude:personal`
- **THEN** relay applies the rule to that thread when that turn ends

### Requirement: Waiting for the turn to end
For a thread with an active turn, relay SHALL wait for the turn to end, checking its status with `t3_thread_read` every 60 seconds. If the turn is still `running` 15 minutes after relay first saw it under the crossing, relay SHALL interrupt it with `t3_thread_interrupt` and the reason `relay: <account> passed its <window> threshold`, with `<window>` written as in `limit-rules`. A turn in status `waiting` (waiting for the person) SHALL never be interrupted.

#### Scenario: Turn ends by itself
- **WHEN** the thread's turn completes 4 minutes after the crossing
- **THEN** relay switches the thread after it completes and does not interrupt anything

#### Scenario: Long turn
- **WHEN** the turn is still running 15 minutes after relay first saw it
- **THEN** relay calls `t3_thread_interrupt` once for that turn and switches the thread after the turn ends

### Requirement: Switching the thread
After the turn ends, relay SHALL call `t3_thread_configure` with the thread ID and a `modelSelection` whose `instanceId` is the T3 instance mapped to `switch_to` and whose `model` is that instance's `model` setting, or the first model `orchestrator_capabilities` lists for it. relay SHALL then append a `t3_thread_switched` event with the thread ID, project, from and to accounts, window and percentage. relay SHALL switch each thread at most once per crossing.

#### Scenario: Claude to Codex
- **WHEN** a thread on instance `claude` finishes its turn while the weekly rule of `claude:personal` switches to `codex:personal`, mapped to instance `codex` with `model = "gpt-6.1-sol"`
- **THEN** relay calls `t3_thread_configure` with `{"instanceId":"codex","model":"gpt-6.1-sol"}` once, and a `t3_thread_switched` event is appended

### Requirement: Sending continue
After switching, relay SHALL send the message `continue` with `t3_thread_send`, mode `auto`, and a `clientRequestId` derived from the thread ID and the ended turn's run ID, only when relay interrupted that turn or the turn ended with status `failed`. relay SHALL append a `t3_thread_continued` event. A turn that ended with `completed` or `cancelled` SHALL be switched without a message. relay SHALL never send any text other than `continue`.

#### Scenario: Turn cut off by the limit
- **WHEN** the switched thread's last turn ended with status `failed`
- **THEN** relay sends `continue` once, and a retry of the same call uses the same `clientRequestId`

#### Scenario: Turn completed
- **WHEN** the switched thread's last turn ended with status `completed`
- **THEN** relay sends no message

### Requirement: Actions are visible and safe
Every T3 call relay makes SHALL be logged in `logs/t3.log` under `RELAY_HOME` with the tool name, thread ID and result status, and never with message text, thread titles or the token. relay SHALL never call a T3 tool that changes permission modes, creates, deletes, archives or merges threads or projects, or answers a pending request. A failed call SHALL be retried at most twice, 30 seconds apart, and then recorded as `t3_action_failed` and shown in `relay t3 status`.

#### Scenario: T3 closed during a switch
- **WHEN** T3 stops answering between `t3_thread_configure` and `t3_thread_send`
- **THEN** relay retries the send twice, records `t3_action_failed` with the thread ID, and `relay t3 status` shows `Could not send "continue" to <thread link>. Open the thread and send it yourself.`
