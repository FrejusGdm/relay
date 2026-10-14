# Spec Delta: t3-resume-at-reset

## Purpose

T3 Code threads that stop at a usage limit should continue in the same thread, on the same
account, after the limit resets, without relying on T3's own resume and without ever disturbing a
thread that is busy.

## ADDED Requirements

### Requirement: Turning it on
`[t3.resume_at_reset]` in `config.toml` SHALL accept `accounts` (a list of relay accounts, each
mapped to a T3 instance in `[t3.instances.<id>]`), `threads` (a list of T3 thread IDs) and
`max_resumes` (1 to 20, default 3). An account that is not mapped SHALL be a settings error (exit
code 78) with `T3 Code has no provider mapped to <account>. Map it in [t3.instances.<id>].`
Without the table, or with both lists empty, the daemon SHALL make no T3 call for this feature.

#### Scenario: Every thread on an account
- **WHEN** `accounts = ["claude:personal"]` and `[t3.instances.claude] account = "claude:personal"`
- **THEN** the daemon watches every T3 thread whose `providerInstanceId` is `claude`

#### Scenario: Nothing turned on
- **WHEN** `config.toml` has no `[t3.resume_at_reset]` table
- **THEN** the daemon calls no T3 tool

### Requirement: Recognising a limit stop
Every 60 seconds, when the feature is on and relay is connected to T3, the daemon SHALL list the
`failed` threads of each T3 project and, for each chosen thread whose newest run it has not
classified, read the last 25 `activity` items once. It SHALL call the stop a usage limit only when
the thread has no active run and an `error` item of the newest run matches Claude Code's or Codex's
usage limit message. The reset time SHALL come from that message, then from the account's recorded
availability or a reading that spends no usage (Claude Code's `/usage` command, Codex's rate
limits); without one, relay SHALL check every 15 minutes plus up to 60 seconds. When no reading
exists at all, relay SHALL NOT send before 5 hours have passed since the stop. A time zone named in
the message SHALL be honoured. relay SHALL never store or log the message text or the thread
title.

#### Scenario: Claude limit with a reset time
- **WHEN** a thread's newest run failed with the error text `You've hit your session limit · resets 6:50pm (Europe/Berlin)`
- **THEN** relay records `limit_seen` and `waiting` in `RELAY_HOME/t3/actions.jsonl` with the reset time 18:50 Berlin time and the next check 60 to 90 seconds after it

#### Scenario: Another failure
- **WHEN** a thread's newest run failed with `Claude API is overloaded (529). Try again shortly.`
- **THEN** relay does nothing for that run and does not read it again

### Requirement: Sending continue
At the check time, relay SHALL read the thread again and send `The usage limit has reset. Continue
the task from where you stopped.` with `t3_thread_send`, `mode` `queue` and `clientRequestId`
`relay-resume-<threadId>-<runId>`, only when the thread has no active run and its newest run is the
run that stopped. When the newest run is another run, relay SHALL record `skipped` with `reason`
`thread_moved_on` and forget the stop. When the thread has an active run, relay SHALL record
`skipped` with `reason` `thread_busy` and check again 15 minutes later. relay SHALL record `sent`
in its state file before the call, and SHALL never send twice for the same run, also across daemon
restarts.

#### Scenario: Busy at reset time
- **WHEN** the person started a new turn in the thread before the reset
- **THEN** relay sends nothing and records `skipped` with `thread_moved_on`

#### Scenario: T3's own resume worked
- **WHEN** T3 continued the thread at the reset, 60 seconds before relay's check
- **THEN** relay sends nothing

#### Scenario: Daemon restart after sending
- **WHEN** the daemon stops right after relay sent and starts again
- **THEN** relay does not send again for that run

### Requirement: Stopping and cancelling
relay SHALL count sends in a row whose next run stopped at a usage limit again, and after
`max_resumes` of them SHALL record `gave_up` and stop sending to that thread until a run completes.
relay SHALL NOT start a new wait for that thread, also when later runs stop at the limit again,
until one of its runs completes. `relay resume-at-reset off --thread <id>` SHALL cancel a thread's
wait, record `cancelled`, and
print `Cancelled resume at reset for T3 thread <id>.` `relay status` SHALL list each T3 wait as
`T3 thread <id> on <account>: waiting for the limit to reset at <time>, then continuing`.

#### Scenario: A manual retry after relay gave up
- **WHEN** relay gave up on a thread and the person's own retry stops at the limit again
- **THEN** relay sends nothing, until a run of the thread completes

#### Scenario: Cancel a thread's wait
- **WHEN** the person runs `relay resume-at-reset off --thread thread-1` before the reset
- **THEN** relay sends nothing to `thread-1` for that stop
