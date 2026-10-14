# Proposal

Asked for by Josué in chat on 2026-10-13, with the scope below. He asked for it to be built in
the same session, so his request is the approval.

## Why

When a coding agent stops because its account reached a usage limit, the work stops until someone
comes back and types "continue". At night that loses hours. Josué's main tool is T3 Code, and T3's
own "Resume at reset" has an open bug in which it never fires
([pingdotgg/t3code#17808](https://github.com/pingdotgg/t3code/issues/17808), opened 2026-10-10,
still open on 2026-10-13), so relay must not depend on it. Claude Code's own automatic continue
(`autoContinueAtUsageLimit`) covers only interactive sessions (Claude Code documentation,
"Wait for a usage limit to reset", read on 2026-10-13), so headless `claude -p` runs that relay
starts never continue on their own.

The fix is narrow: wait until the limit of the **same** account resets, then continue the **same**
session with the same task. relay never moves the work to another account or provider in this
change. That keeps it inside the providers' terms: it is the person's own session on the person's
own account, continued after the provider itself says the limit has reset, which is what Claude
Code's interactive mode already does by default (`docs/research/security.md`, "Provider terms";
`docs/ROADMAP.md`, "What the research changed", "Provider terms shape the product").

## What Changes

- **Reading the reset time.** relay already reads reset times from Claude Code's
  `rate_limit_event` (`resetsAt`), the limit message text, the status line and the `StopFailure`
  hook, and from Codex's `account/rateLimits/read` and limit message (`docs/adapters.md`, "Reset
  times"). This change adds Claude Code's `errorCode: "credits_required"` as its own failure reason,
  `credits_required`, because such a stop does not end at a reset. When no reset time is known,
  relay checks again every 15 minutes with a random delay of up to one minute, and never more often.
- **`relay run --headless --resume-at-reset [--max-resumes <n>]`.** When the agent stops at a usage
  limit (today's exit code 23), relay records the stop and the reset time in the job's event log,
  waits, and resumes the same session on the same account with the prompt "The usage limit has
  reset. Continue the task from where you stopped." It goes on until the task ends normally. It
  stops with exit code 23 after `--max-resumes` resumes in a row that hit the limit again (default
  3), and stops at once on `credits_required` or any failure that is not a usage limit.
- **The daemon owns the wait.** The wait is a file under `RELAY_HOME/jobs/<job>/` that the daemon
  reads, so the resume happens even when the terminal closes or the daemon restarts. The `relay run`
  that started the job keeps printing what happens until the job ends, and can be closed.
  `relay status` shows "Waiting for claude:work's limit to reset at 15:47, then continuing", and
  `relay resume-at-reset off --job <id>` cancels the wait. Ctrl+C in the waiting `relay run` cancels
  it too.
- **T3 Code threads.** A new `[t3.resume_at_reset]` table in `config.toml` turns this on for chosen
  threads (`threads`) or for every thread on an account (`accounts`). The daemon looks at those
  threads every 60 seconds through the existing T3 client. When a thread on account X stopped at a
  usage limit, relay sends the continue message to that same thread after the reset, only when the
  thread is idle and its last run is still the one that stopped, never twice for the same stop, and
  records every action in `RELAY_HOME/t3/actions.jsonl`. `relay resume-at-reset off --thread <id>`
  cancels a thread's wait.
- **`relay t3 connect` and `relay t3 disconnect`.** The sign-in code of `add-t3-limit-rules`
  (`src/t3/oauth.ts`) is on `main`, but no command calls it, so a person cannot connect relay to T3
  today. This change adds the two commands over the existing sign-in, without the instance mapping
  questions of `add-t3-limit-rules` task 4.4: `relay t3 connect` lists T3's provider instances and
  says how to map them in `config.toml`.
- **Fake agents.** The scenario files get a `runs` list (one scenario per start of the program, so
  a test can hit a limit, be resumed and finish), a `limit` step without `resets_at`, and a
  `"credits"` limit kind. The fake T3 server gets error items, thread list filters and the
  `afterPosition`, `limit`, `view` and `runLimit` read options.
- **Documents.** `docs/cli.md`, `docs/daemon.md`, `docs/adapters.md`, `docs/testing-adapters.md`,
  `docs/config.md`, `README.md` and `docs/progress.md`.

## Capabilities

### New Capabilities

- `resume-at-reset`: waiting for a usage limit to reset and resuming the same session of a relay
  job on the same account, owned by the daemon, shown in `relay status` and cancellable.
- `t3-resume-at-reset`: the same for T3 Code threads, through T3's MCP server.

### Modified Capabilities

- `agent-runs` (from `add-provider-adapters`): `relay run` gains `--resume-at-reset` and
  `--max-resumes`, and the failure reason `credits_required`.
- `t3-connection` (from `add-t3-limit-rules`): `relay t3 connect` and `relay t3 disconnect`
  exist, without the mapping questions.

## Out of scope

- Switching to another account or provider, rotating accounts, or any automatic failover. Those
  stay with `add-t3-limit-rules` and phase 7 of `docs/ROADMAP.md`.
- Interactive `relay run`: Claude Code already continues an interactive session at a reset by
  itself, and relay never changes `autoContinueAtUsageLimit`.
- Starting the daemon when the computer starts. After a restart of the computer, a wait continues
  once any relay command that starts the daemon runs, or after `relay daemon start`.
- The instance mapping questions, `relay t3 status`, `relay t3 enable` and the limit rules of
  `add-t3-limit-rules`.
- Buying usage credits. A `credits_required` stop is reported and never waited for.

## Security

- **Credentials.** relay drives only the official `claude` and `codex` programs, with the
  environment `buildAgentEnv` builds for the account that stopped. It never reads, copies or logs a
  login or token. The only token involved is the one T3 Code issues to relay, which stays in the
  operating system's credential store as `add-t3-limit-rules` decided on 2026-10-08.
- **Same account, same session.** A wait records the account and the provider session ID of the
  worker that stopped. The daemon resumes exactly that session on exactly that account, with the
  job's recorded permission level, and refuses when the job has moved on (a newer worker, or another
  process holds the worker lock). relay's existing check that a session is resumed only on the
  account that started it still applies.
- **No new network listener.** The daemon still has only its Unix socket. `relay t3 connect` uses
  the loopback sign-in of `add-t3-limit-rules`, which only a command at the keyboard starts.
- **Unattended actions are visible and can be stopped.** Every wait, check, resume and send is an
  event in the job's event log or `RELAY_HOME/t3/actions.jsonl`, appears in `relay status`, and can
  be cancelled with `relay resume-at-reset off`. Event data holds no message text and no thread
  title.
- **T3 threads.** relay sends to a thread only when T3 reports it idle (`activeRunId` is null) and
  its newest run is still the one that stopped, with `mode: "queue"` so it can never steer a
  running turn, and with a `clientRequestId` built from the thread and run, so a retry never sends
  a second message.

## Sources

- Claude Code documentation, read on 2026-10-13: "Run Claude Code programmatically"
  (`claude -p --resume <session_id>`), "Agent SDK reference - TypeScript" (`SDKRateLimitEvent`
  with `rate_limit_info.status`, `resetsAt` and `errorCode: "credits_required"`; the assistant
  error `rate_limit`), "Hooks reference" (`StopFailure` with the matcher `rate_limit`), "Interactive
  mode" and "Settings reference" (`autoContinueAtUsageLimit`, interactive sessions only), and
  "Customize your status line" (`rate_limits.*.resets_at`).
- Codex documentation, read on 2026-10-13: "Non-interactive mode" (`codex exec resume
  <SESSION_ID>`); its JSON output has no reset time, which is why relay keeps reading
  `account/rateLimits/read` through the app server (`docs/adapters.md`, "The Codex adapter").
- T3 Code source at commit `80664d5` (2026-10-13): `packages/contracts/src/orchestratorMcp.ts`
  (thread list, read and send), `apps/server/src/mcp/OrchestratorMcpService.ts` (an `error` item's
  text is the provider's failure message; a thread's status is its active or latest run's status),
  `apps/server/src/orchestration-v2/ThreadManagementService.ts` (`queue` never steers).
- `docs/research/t3-outside-access.md`, sections 4 and 5.
