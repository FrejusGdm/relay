# Design

## Context

What is on `main` at commit `0522481` (2026-10-13):

- `relay run --headless` starts one agent through its adapter and exits with code 23
  (`LimitReached`) when the last turn failed with `usage_limit` or `rate_limit`
  (`src/run/run.ts`, `outcome()`). The `turn_failed` event already carries `retry_at` and the
  source of the reading.
- `src/adapters/claude/stream.ts` reads a rejected `rate_limit_event` and its `resetsAt`, and the
  reset time in the text "You've hit your session limit · resets 3:45pm". `src/adapters/codex/`
  reads `usageLimitExceeded` and then `account/rateLimits/read` (app server), or the text "try
  again at 3:45 PM" (`codex exec`). `src/hooks/` records the `StopFailure` hook and the status line
  numbers in the account's `availability.json`.
- `JobSupervisor` in `src/run/run.ts` runs agents both for `relay run` and inside the daemon
  (`src/daemon/engines.ts`, the switch endpoint), and `HeadlessWorkers` in `src/daemon/workers.ts`
  lists and stops the agents the daemon started.
- `src/t3/client.ts` (the MCP client with its tool allow list), `src/t3/oauth.ts` (the sign-in),
  `src/t3/secrets.ts` and `src/t3/connection.ts` exist. No command calls the sign-in yet.

What the documents say, read on 2026-10-13:

- Claude Code: `claude -p --resume <session_id>` continues a session in print mode.
  `SDKRateLimitEvent.rate_limit_info` has `status` (`allowed`, `allowed_warning`, `rejected`),
  `resetsAt`, `utilization` and, from version 2.1.181, `errorCode: "credits_required"` when "the
  session cannot continue until the user buys usage credits". The assistant error and the
  `StopFailure` matcher use `rate_limit`. `autoContinueAtUsageLimit` makes an interactive session
  wait and continue; nothing does that for `-p`.
- Codex: `codex exec resume <SESSION_ID>` continues a session; the exec JSON output has no reset
  time, so the app server's `account/rateLimits/read` stays the source.
- T3 Code (source at `80664d5`): the MCP tools have no limit status and no reset time. A thread's
  `status` is its active run's status, else its newest run's status, else `idle`; a thread stopped
  by a limit shows `failed` with `activeRunId: null`. Its timeline (`t3_thread_read`, view
  `activity`) holds an `error` item whose text is the provider's failure message, such as
  "You've hit your session limit · resets 6:50pm (Europe/Berlin)" for Claude or Codex's "You've
  hit your usage limit ... try again at 6:50 PM." `t3_thread_send` with `mode: "queue"` starts an
  idle thread and never steers an active turn, and `clientRequestId` makes a retry idempotent.

## Goals / Non-Goals

**Goals:** continue a job or a T3 thread on the same account and in the same session after its
usage limit resets, without the person, with every wait visible and cancellable.

**Non-Goals:** another account or provider, interactive runs, starting the daemon at login, buying
credits (see the proposal's "Out of scope").

## Decisions

### 1. The wait is a file the daemon reads

A job's wait is `RELAY_HOME/jobs/<job>/resume-at-reset.json`, mode 0600, written through a
temporary file and a rename while relay holds `RELAY_HOME/locks/<job>.resume.lock`. Every
change (relay run arming it, the daemon resuming, `relay resume-at-reset off`) is a read, a change
and a write under that lock, so a cancel and a resume cannot both win.

```json
{
  "schema_version": 1, "job_id": "a1b2c3d4", "root": "/path/to/worktree",
  "account": "claude:work", "provider": "claude", "session_id": "7c1e9a52-…",
  "permission": "edit-in-workspace", "model": null, "max_resumes": 3,
  "state": "waiting",
  "stop": { "worker_id": "5d2e8f01", "at": "…", "reason": "usage_limit", "reset_at": "…", "source": "stream_event" },
  "next_check_at": "…", "resumes": 1, "resumes_in_a_row": 1, "waiting_since": "…",
  "worker_id": null, "updated_at": "…"
}
```

`state` is `watching` (the first agent runs; nothing to wait for yet), `waiting`, or `resuming` (a
resumed agent runs in the daemon). The file is deleted when the wait ends; the event log keeps the
history. The daemon looks at every job's file every 5 seconds instead of being told over the
socket, so no new endpoint is needed, a file written while the daemon is down is found when it
starts, and a resume can be at most 5 seconds late, which does not matter next to a reset that is
hours away.

Alternative considered: `relay run` waits in the terminal and the daemon takes over only when the
terminal closes. Two owners need a handover protocol, and a crash between them loses the wait.

### 2. Where the reset time comes from

relay takes the first of these that gives a time after the stop:

1. the `turn_failed` event of the stop (Claude Code's `rate_limit_event` `resetsAt`, or the reset
   time in the limit message; Codex's rate limit reading or message);
2. the account's recorded availability (`availability.json`: the status line's `resets_at`, the
   `StopFailure` hook, readings of other sessions on the same account), when its state is
   `quota_exhausted` or `rate_limited`;
3. a live reading that spends no usage: for Codex, `account/rateLimits/read` through
   `adapter.availability()`; for Claude Code, `claude -p "/usage" --no-session-persistence` with the
   account's profile folder (`src/usage/claude.ts`, the command of `add-t3-limit-rules`'
   `usage-readings` spec, which `docs/research/t3-outside-access.md` confirmed spends no usage). The
   reading is recorded as the account's availability with the source `usage_command`.

A reset time written with a time zone in parentheses, as Claude Code writes it ("resets 6:50pm
(Europe/Berlin)"), is read in that zone (`resetTimeInZone` in `src/adapters/reset-time.ts`).

relay resumes 60 seconds after the reset time, plus a random delay of up to 30 seconds, because
providers round reset times to the minute and the reported minute can move by one between readings
(`docs/research/t3-outside-access.md`, "Checked later").

### 3. An unknown reset time is checked every 15 minutes

Without a reset time, the next check is 15 minutes later plus a random delay of up to 60 seconds,
and never sooner. A check reads the account's availability as in decision 2. A future reset time
makes relay wait for it; `quota_exhausted` without a time means another 15 minutes; `available`,
`unknown` or a reset time that has passed makes relay resume. A resume at a limit that is still in
force costs no usage, because the provider refuses the first request, and its stop often brings
the reset time that was missing. For a T3 Code thread the person sees every message, so when no
reading exists at all relay does not try a send that would only fail there: it checks every 15
minutes and sends once 5 hours have passed since the stop, the longest a session limit lasts.

### 4. When relay stops trying

relay counts resumes in a row that end at a usage limit again. When the count reaches
`max_resumes` (default 3, `--max-resumes` from 1 to 20), the wait ends and the job's exit code is
23. A resume made without a known reset time (decision 3) does not count, because it was a check,
not a promise; instead a wait without a known reset time ends after 7 days, the length of the
longest usage window. A stop for any other reason ends the wait at once with that run's exit code:
`credits_required` (23, with its own message), an approval request, a crash, an authentication or
billing error (24), or a turn that relay itself stopped. A completed turn ends the wait with 0.

### 5. The daemon resumes through a job supervisor

At the time, the daemon takes the job's resume lock, checks that the wait is still `waiting`, and
refuses the resume (ending the wait with the reason `job_moved_on`) when another process holds the
job's worker lock or when the job's newest worker is not the one that stopped. It then creates a
`JobSupervisor` with `signals` off, as the switch endpoint does, and starts a headless worker with
`resume` set to the recorded session, the recorded account, permission and model, relay's fixed
instructions, and the prompt "The usage limit has reset. Continue the task from where you
stopped." The worker is added to `HeadlessWorkers`, so `GET /v1/version` lists it and the daemon
stops it when it stops. When it ends, the supervisor saves a checkpoint as `relay run` does, and
the daemon applies decision 4 using the new `lastEnd` the supervisor records.

When the daemon stops while a resumed agent runs, it stops the agent as today and puts the wait
back to `waiting` with `next_check_at` set to now, so the next daemon resumes the same session.
This resume does not count toward `max_resumes`. The wait then expects the agent it stopped as the
job's newest worker, so the next daemon does not take relay's own resumed agent for another agent.
A daemon that died without recording the end does the same with the newest worker that resumed the
wait's session on the wait's account. The daemon starts each resume on its own: a long resumed
agent never holds up the resumes of other jobs or the daemon's shutdown.

`relay run --resume-at-reset` refuses with exit code 6 when another process uses the job's wait (a
`relay run` whose agent works, or the daemon running a resumed agent), and a run that fails before
its agent ends only its own wait.

### 6. `relay run` follows the job until it ends

After the first agent stops at a limit, `relay run` writes the wait, releases the worker lock,
makes sure the daemon runs, prints

```
Claude Code stopped: usage limit, resets 15:47.
Waiting for claude:work's limit to reset at 15:47, then continuing.
You can close this terminal. To cancel, run relay resume-at-reset off --job a1b2c3d4
```

and then reads the job's event log every half second, printing a line for each wait, resume,
command, changed file and finished turn, until the wait ends, when it exits with the code the wait
ended with. It asks for the daemon again every minute, so a daemon that died is started again.
Ctrl+C cancels the wait and exits with 130; an agent the daemon already resumed finishes its turn.
SIGHUP or SIGTERM ends only `relay run`: the wait stays, and the daemon continues.

### 7. Two jobs on one account

Each job has its own wait. At a reset both resume, each with its own random delay. relay does not
order them: the account's limit applies to both, and a second job that hits the limit again simply
waits again.

### 8. `credits_required` is its own failure reason

`src/adapters/claude/stream.ts` sets the reason `credits_required` when the rejected
`rate_limit_event` has `errorCode: "credits_required"`. `relay run` exits with 23 and prints
"Claude Code stopped: this account has used its included usage and needs usage credits to
continue. relay does not wait for this." Availability is `quota_exhausted`, as before.

### 9. Events

Job events in `.relay/events.jsonl`, none with message text:

| Event | Data |
|---|---|
| `resume_at_reset_on` | `worker_id`, `target`, `max_resumes` |
| `resume_at_reset_waiting` | `worker_id` (the one that stopped), `target`, `provider_session_id`, `reason`, `reset_at`, `source`, `next_check_at`, `resumes_in_a_row` |
| `resume_at_reset_checked` | `target`, `result` (`reset_known`, `still_limited`, `resuming`), `reset_at`, `next_check_at` |
| `resume_at_reset_resumed` | `worker_id` (the new one), `target`, `provider_session_id`, `resume`, `counted` |
| `resume_at_reset_ended` | `outcome` (`finished`, `gave_up`, `stopped`, `cancelled`), `reason`, `exit_code`, `resumes` |

`relay status` reads the wait file directly, with or without the daemon.

### 10. T3 threads: finding a stop

The setting is

```toml
[t3.resume_at_reset]
accounts = ["claude:personal"]      # every thread T3 runs on this account
threads = ["thread_01J…"]           # and these threads, on any mapped account
```

Every 60 seconds, when the table names something and `RELAY_HOME/t3/connection.json` exists and
has not expired, the daemon:

1. lists T3's projects and, in each, the threads with status `failed`;
2. keeps a thread when its ID is in `threads`, or its `providerInstanceId` maps (through
   `[t3.instances.<id>]`) to an account in `accounts`; a thread in `threads` whose instance maps to
   no account is skipped, because relay could not know whose limit it waits for;
3. for a thread whose newest run relay has not classified yet, reads the thread once to learn
   `itemCount`, then reads the last 25 `activity` items, and calls the stop a usage limit when an
   `error` item of that run matches Claude Code's or Codex's limit message
   (`/hit your (session|weekly|Opus|Sonnet|usage) limit/i` or `/usage limit/i` with `try again`).
   The classification is kept per run, so each failed run is read once.

The reset time comes from the message text (`resetTimeFromText`), then from the account's
availability as in decision 2; without one, decision 3 applies. The text is never logged or
stored; only the reset time is.

### 11. T3 threads: sending continue

At the time, relay reads the thread again and sends only when `activeRunId` is null and the newest
run is the run that stopped. Otherwise the stop is over (the person, T3's own resume or another
program continued the thread) and relay records `skipped` with the reason and forgets the stop. A
thread that still shows the stopped run but has an active run is checked again 15 minutes later.
The send is `t3_thread_send` with the message "The usage limit has reset. Continue the task from
where you stopped.", `mode: "queue"`, and `clientRequestId` `relay-resume-<threadId>-<runId>`.
relay writes `sent` to its state file before the call, so a daemon restart after the call never
sends again for that run, and T3 ignores a repeated `clientRequestId` in any case. The 60-second
margin of decision 2 lets T3's own resume go first when it works; relay then sees a new run and
does nothing.

Per thread, relay counts sends in a row whose next run stopped at a limit again, with the same
`max_resumes` of 3 (`[t3.resume_at_reset] max_resumes`). After that, relay stays away from the
thread, also when later runs stop at the limit again, until one of its runs completes.

T3 writes its own text for a Claude limit, such as "Claude usage limit reached. Send the message
again once the limit resets.", without the reset time. relay then looks for Claude Code's own
message, with the time, among the other items of the same run.

State: `RELAY_HOME/t3/resume-at-reset.json` (mode 0600, under `locks/t3-resume.lock`). Events:
`RELAY_HOME/t3/actions.jsonl`, one JSON line per action (`limit_seen`, `waiting`, `checked`,
`sent`, `skipped`, `gave_up`, `cancelled`), with the thread ID, run ID, account and times only.

### 12. `relay t3 connect` and `relay t3 disconnect`

`relay t3 connect` needs a terminal. It calls `signIn` from `src/t3/oauth.ts` with `t3.url`,
the operating system's credential store and the browser opener, then calls
`orchestrator_capabilities` and prints each T3 provider instance with the `[t3.instances.<id>]`
table to add. `relay t3 disconnect` calls `signOut`. Exit codes 40 (T3 not answering), 41 (T3
build too old) and 42 (connection refused or expired), reserved by `add-t3-limit-rules`, are added
to `src/cli/exit-codes.ts`.

### 13. Test switches

With `RELAY_TEST=1` only (the test preload), `RELAY_TEST_RESUME_TICK_MS`,
`RELAY_TEST_RESUME_CHECK_MS` (the 15 minutes) and `RELAY_TEST_RESUME_MARGIN_MS` (the 60 seconds
and the random delays, set to 0) shorten the times, as `RELAY_TEST_HEADLESS_START_MS` does today.
The fake scenarios get `runs` (one scenario per start of the program, counted in a file next to the
scenario) so a test can stop at a limit, be resumed by the daemon and finish.

## Risks / Trade-offs

- [The daemon is not running at the reset, for example after the computer restarted.] → The wait
  stays in its file; the next relay command that starts the daemon (any `relay run`, `relay switch`,
  `relay daemon start`) resumes it. `relay status` shows the wait as overdue. Documented.
- [T3 changes its limit message.] → relay then does not recognise the stop and does nothing, which
  is safe. The patterns are tested with the real messages from T3's source.
- [Both relay and T3's own resume send.] → relay waits a minute past the reset and sends only when
  the newest run is still the stopped one, so it stays quiet when T3's resume worked.
- [A resume without a known reset time hits the limit again.] → It costs no usage and does not
  count; checks are at least 15 minutes apart and end after 7 days.
- [The job's worktree is gone at the reset.] → The daemon ends the wait with `job_moved_on` and
  records it in its log, because the event log is gone with the worktree.
