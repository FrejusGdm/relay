# Spec Delta: resume-at-reset

## Purpose

When an agent that relay runs headless stops at its account's usage limit, the job should continue
by itself after the limit resets, on the same account and in the same session, with every wait
visible and cancellable.

## ADDED Requirements

### Requirement: Arming resume at reset
`relay run --headless --resume-at-reset` SHALL create the job's wait file in the state `watching`
before the agent starts and record a `resume_at_reset_on` event. `--resume-at-reset` without
`--headless` SHALL be refused with exit code 2 and `relay: --resume-at-reset works only with
--headless.` `--max-resumes <n>` SHALL accept a whole number from 1 to 20, default 3, and only with
`--resume-at-reset`. When the first agent ends without a usage limit, relay SHALL delete the wait
file, record `resume_at_reset_ended` with that outcome, and exit as `relay run` does today.

#### Scenario: Not headless
- **WHEN** the person runs `relay run claude:work --resume-at-reset`
- **THEN** relay exits with code 2 and starts no agent

#### Scenario: The task ends without a limit
- **WHEN** the agent completes its turn
- **THEN** relay exits with code 0, no wait file is left, and the event log holds `resume_at_reset_on` and `resume_at_reset_ended` with `outcome` `finished`

### Requirement: Recording the stop and the reset time
When the agent of an armed job stops with `usage_limit` or `rate_limit`, relay SHALL write the wait
in the state `waiting` with the worker, the account, the provider session ID, the reason, the reset
time and its source, and the next check time, and SHALL record `resume_at_reset_waiting`. The reset
time SHALL be taken, in this order, from the stop's `turn_failed` event, from the account's
recorded availability when it is `quota_exhausted` or `rate_limited` with a reset time after the
stop, and from a live reading that spends no usage (Codex's rate limits, Claude Code's
`claude -p "/usage" --no-session-persistence`). The next check SHALL be 60 seconds after the reset
time plus a random delay of up to 30 seconds.

#### Scenario: Known reset time
- **WHEN** Claude Code reports a rejected `rate_limit_event` with `resetsAt` at 15:47 and the turn fails with `rate_limit`
- **THEN** the wait holds `reset_at` 15:47 with source `stream_event`, `next_check_at` is between 15:48:00 and 15:48:30, and `relay run` prints `Waiting for claude:work's limit to reset at 15:47, then continuing.`

#### Scenario: Reset time from the status line
- **WHEN** the stop carries no reset time and the account's availability, recorded from the status line, is `quota_exhausted` until 16:00
- **THEN** the wait holds `reset_at` 16:00 with source `status_line`

### Requirement: Unknown reset times
When no reset time is known, the next check SHALL be 15 minutes later plus a random delay of up to
60 seconds, and relay SHALL never check sooner. A check SHALL read the account's availability: a
future reset time makes relay wait for it; `quota_exhausted` without a time makes relay check again
after another 15 minutes; `available`, `unknown` or a reset time that has passed makes relay
resume. Each check SHALL be recorded as `resume_at_reset_checked`. A wait without a known reset
time SHALL end after 7 days with `outcome` `gave_up` and exit code 23.

#### Scenario: Still limited
- **WHEN** a check finds the account `quota_exhausted` with no reset time
- **THEN** relay records `resume_at_reset_checked` with `result` `still_limited` and the next check is at least 15 minutes later

#### Scenario: A check learns the reset time
- **WHEN** a check finds a reset time 40 minutes away
- **THEN** relay records `result` `reset_known` and waits until 60 to 90 seconds after it

### Requirement: Resuming the same session on the same account
At the next check time, the daemon SHALL resume the recorded provider session on the recorded
account, headless, with the job's recorded permission level and model, relay's fixed instructions
and the prompt `The usage limit has reset. Continue the task from where you stopped.` It SHALL
record `resume_at_reset_resumed` with the new worker. It SHALL NOT resume, and SHALL end the wait
with `outcome` `cancelled` and `reason` `job_moved_on`, when another process holds the job's worker
lock, when the job's newest worker is not the one that stopped, or when the job's folder no longer
holds the job. relay SHALL never use another account or provider in this feature.

#### Scenario: Resume after the reset
- **WHEN** the reset time passes and the daemon's check is due
- **THEN** a new worker runs `claude -p --resume <the same session ID>` with the account's own profile folder, and its worker record has `resumed_from` set to that session

#### Scenario: The person started another agent meanwhile
- **WHEN** the person ran `relay run codex:personal` in the job while it waited
- **THEN** the daemon does not resume and records `resume_at_reset_ended` with `reason` `job_moved_on`

### Requirement: When resuming ends
A resumed agent that completes its turn SHALL end the wait with `outcome` `finished` and exit code
0. A resumed agent that stops at a usage limit again SHALL wait again as above; after `max_resumes`
resumes in a row that stopped at a limit again, the wait SHALL end with `outcome` `gave_up` and
exit code 23. A resume made without a known reset time SHALL NOT count. A stop with
`credits_required`, an approval request, a crash or any failure that is not a usage limit SHALL end
the wait at once with `outcome` `stopped` and that run's exit code.

#### Scenario: The limit is hit again three times
- **WHEN** each of three resumes, made after known reset times, stops at the usage limit again
- **THEN** the wait ends with `gave_up`, exit code 23, and `relay run` prints `relay stopped after 3 resumes in a row that hit the limit again.`

#### Scenario: Credits required
- **WHEN** Claude Code's rejected `rate_limit_event` has `errorCode` `credits_required`
- **THEN** relay does not wait, prints `Claude Code stopped: this account has used its included usage and needs usage credits to continue. relay does not wait for this.` and exits with code 23

#### Scenario: Another failure after a resume
- **WHEN** the resumed agent stops because the service is overloaded
- **THEN** the wait ends with `stopped` and exit code 24

### Requirement: The daemon owns the wait
The daemon SHALL read every job's wait file at start and at least every 5 seconds, so a wait
continues after the terminal closes and after the daemon restarts. When the daemon stops while a
resumed agent runs, it SHALL stop the agent and set the wait back to `waiting` with the next check
at once, and that resume SHALL NOT count. `relay run` SHALL print what happens to the job until the
wait ends and then exit with the wait's exit code; SIGHUP and SIGTERM SHALL end only `relay run`.

#### Scenario: The terminal closes
- **WHEN** the terminal of the waiting `relay run` closes
- **THEN** the daemon still resumes the session after the reset

#### Scenario: The daemon stops a resumed agent
- **WHEN** the daemon stops while a resumed agent runs, and starts again
- **THEN** the new daemon resumes the same session again, and does not end the wait as `job_moved_on`

#### Scenario: The daemon restarts during the wait
- **WHEN** the daemon is stopped and started again before the reset
- **THEN** the new daemon resumes the session after the reset, once

### Requirement: Seeing and cancelling the wait
`relay status` SHALL show `Waiting for <account>'s limit to reset at <time>, then continuing` for a
waiting job (`Waiting for <account>'s limit to reset, checking again at <time>` when the reset time
is unknown, and `Resumed on <account> after its limit reset` while a resumed agent runs), with or
without the daemon, and `--json` SHALL include the wait. `relay resume-at-reset off [--job <id>]`
SHALL cancel the wait of the named job, or of the job in this folder, record `resume_at_reset_ended`
with `outcome` `cancelled` and `reason` `person`, print `Cancelled resume at reset for job <id>.`,
and exit with 0; with no wait it SHALL print `Job <id> has no resume at reset to cancel.` and exit
with 1. Ctrl+C in a waiting `relay run` SHALL cancel the wait the same way and exit with 130. An
agent the daemon already resumed SHALL finish its turn; no later resume follows.

#### Scenario: Cancel while waiting
- **WHEN** the person runs `relay resume-at-reset off --job a1b2c3d4` before the reset
- **THEN** no resume happens, the waiting `relay run` prints `Cancelled.` and exits with code 23

#### Scenario: Two jobs on one account
- **WHEN** two jobs on `claude:work` wait for the same reset
- **THEN** each job resumes its own session once after the reset, and cancelling one leaves the other waiting
