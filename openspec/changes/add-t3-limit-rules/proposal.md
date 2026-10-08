# Proposal

## Why

Josué runs long work at night in T3 Code on a personal Claude subscription. On 2026-10-07 a thread
stopped at 1:00 a.m. on the 5-hour limit, the limit came back at 2:50 a.m., and nothing continued
the work. Josué also wants to keep part of the weekly Claude usage for chatting by hand: past a
threshold (90 percent by default), the work should move to another provider such as Codex instead
of using up the rest. This change lets relay watch T3 Code threads, measure each account's usage,
and apply limit rules that the person sets per account and per usage window. It is the first part
of phase 7 (`docs/ROADMAP.md`, "Single-job failover": "reset times are timer events; per-provider
policy switches"), applied to T3 threads before relay's own jobs.

## What Changes

- **Connecting relay to T3 Code once.** `relay t3 connect` signs relay in to T3 Code's MCP server
  (the documented door for outside programs) with T3's own approval page and pairing code, and
  stores the token T3 issues. `relay t3 status` shows the connection, the days until the token
  expires (T3 tokens last 30 days and cannot be refreshed), and what relay did. `relay t3
  disconnect` deletes the token. Source: `docs/research/t3-outside-access.md` sections 1 and 2.
- **Choosing which projects relay manages.** `relay t3 enable <folder>` turns relay on for every
  thread of that T3 project, and asks the existing first-handoff question for every account a
  rule could move work to, so that nothing waits for an answer at night. `relay t3 disable
  <folder>` turns it off. Threads in other projects are never touched. Source:
  `docs/research/security.md` section 6 (allow list and explicit yes).
- **Limit rules in `config.toml`.** For each account and each usage window (`five_hour`,
  `seven_day`) the person can set a threshold in percent and an action: `wait` (do nothing and let
  the limit reset), `switch` (move the work to another account), or `notify` (tell the person).
  The defaults are: `five_hour` at 100 percent with `wait`; `seven_day` at 90 percent with `notify`,
  or with `switch` when the person names an account to switch to. Switching between two accounts
  of the same provider stays refused (`provider-policies`). Source:
  `docs/research/provider-control-surfaces.md` section 1.5; `docs/ROADMAP.md`, "Decisions made",
  2026-10-07.
- **Measuring usage on a timer.** While at least one rule can act, the daemon reads each ruled
  account's usage every 5 minutes: Codex through its app server's `account/rateLimits/read`, and
  Claude through `claude -p "/usage"` with the account's profile folder. Readings carry their
  source and time, and a missing reading is shown as "not measured", never guessed. Source:
  `docs/research/t3-outside-access.md` section 4; `docs/research/provider-control-surfaces.md`
  sections 1.4 and 2.7.
- **Acting on T3 threads.** When an account passes a `switch` threshold, relay moves each
  thread in an enabled project that uses that account: it waits for the current turn to end (up
  to 15 minutes, then interrupts it), changes the thread's provider with `t3_thread_configure`,
  and sends "continue" with `t3_thread_send` when the turn had been cut off by relay or by a
  limit. T3 then runs its own portable handoff. Turns that start later on that account are
  moved the same way until the window resets. Source: `docs/research/t3-outside-access.md`
  section 3.
- **Continuing at the 5-hour reset is left to T3.** T3's nightly builds already send "Continue
  where you left off." at the reset time when the person turns on "Auto-resume limited threads",
  and T3 knows the exact reset time, which its MCP server does not show to relay. relay checks
  nothing in T3's settings file; `relay t3 enable` tells the person to turn the setting on.
  Source: `docs/research/t3-outside-access.md` sections 4 and 5.
- **Requires a T3 Code nightly build.** Outside access and the T3 tools above exist only from
  v0.0.46-nightly.20261006.2752 onward. `relay t3 connect` refuses older builds with a clear
  message. Source: `docs/research/t3-outside-access.md` section 1.

### Decisions approved with this proposal

Josué approved this proposal on 2026-10-08, and with it each recommendation below.

- **relay stores one token: the one T3 issues to relay.** The project rules say relay never
  stores provider credentials or tokens. A T3 token is not the person's login to Anthropic or
  OpenAI; it is an access grant T3 gives relay, revocable in T3's Connections screen. Without it
  relay cannot act on T3 threads. Recommendation: allow this one exception, keep the token in
  the operating system's credential store (Keychain on macOS, Secret Service on Linux), never in
  `config.toml`, logs or events, and require the person to approve the access level on T3's own
  page.
- **relay needs T3's `full-access` level.** T3 refuses outside programs that act on a thread
  with a broader permission mode than their own, and T3's default thread mode is full access.
  Recommendation: `relay t3 connect` explains this and asks for `full-access`. relay itself
  never changes a thread's permission mode (`t3_thread_configure` cannot) and never answers an
  agent's permission prompt.
- **Claude usage comes from `claude -p "/usage"`.** It is the only documented source that works
  without a running Claude session. Recommendation: use it after task 1.2 confirms that it spends
  no usage and that its output gives the weekly percentage; otherwise Claude rules show "not
  measured" and only Codex rules act. T3's experimental usage call is never used.
- **The relationship with T3 Code** (`docs/ROADMAP.md`, "Decisions still open"). On 2026-10-08
  Josué chose to drive T3 through its MCP server. This change records that choice for the
  adapter part only; "a relay view inside T3" stays open.

## Out of scope

- Sending "continue" at a reset for T3 threads (T3 does it) and for relay's own jobs (the rest of
  phase 7).
- The same rules for jobs started with `relay run`. The rules engine is written so that phase 7
  can reuse it.
- Switching a thread back to its first provider after the weekly window resets.
- Excluding single threads inside an enabled project.
- Cursor, OpenCode and other T3 providers as switch targets, and Cursor usage readings (Cursor
  gives none before a limit, `docs/research/provider-control-surfaces.md` section 3.4).
- Claude per-model weekly windows (Opus, Sonnet); only the weekly window for all models is used.
- T3 servers reached over the network or T3 Connect. relay connects only to `127.0.0.1`.
- The Mac app view of rules and readings (phase 8).
- Any change to T3 Code itself, including asking T3 to expose `usageLimitResetAt` through MCP.

## Security

- **Another provider.** A switch sends the project to another company. relay asks the
  existing first-handoff question (`provider-allow-list`) when the person enables a project, not
  at night, and a rule whose target is not on the project's allow list never acts. Same-provider
  automatic switching stays refused (`docs/research/security.md` section 7).
- **The T3 token.** Stored only in the operating system's credential store, never written to
  disk by relay, never logged, sent only in the `Authorization` header to the T3 address the
  person confirmed. `relay t3 disconnect` deletes it and tells the person to revoke it in T3.
- **Network.** The OAuth sign-in needs a temporary listener on `127.0.0.1` for T3's redirect. It
  uses a random port, accepts one request whose `state` matches, and closes after 120 seconds.
  The daemon's own API stays on the Unix socket. relay only connects to a T3 address on
  `127.0.0.1` or `localhost` (`docs/research/security.md` section 1).
- **Credentials.** `claude -p "/usage"` and `codex app-server` run with the account's profile
  folder, and relay never reads the files in it. relay removes credential environment variables
  as the adapters already do (`docs/research/security.md` section 2).
- **Permissions.** relay never raises a thread's permission mode, never answers permission
  prompts, and interrupts a turn only for a `switch` rule after the 15-minute grace period.
- **Untrusted text.** Thread titles and messages read from T3 are never placed into anything
  relay sends; relay only sends the fixed text "continue".

## Capabilities

### New Capabilities

- `t3-connection`: signing in to T3's MCP server, the build check, storing and deleting the
  token, expiry warnings, and `relay t3 connect`, `status` and `disconnect`.
- `usage-readings`: reading each ruled account's usage windows on a timer, from Codex's app
  server and from `claude -p "/usage"`, with source, time and "not measured".
- `limit-rules`: the `[limits]` settings, their defaults and checks, and deciding when a
  threshold is crossed in a window.
- `t3-thread-actions`: enabling projects, finding the threads a rule applies to, waiting,
  interrupting, switching the provider, sending "continue", and recording every action.

### Modified Capabilities

None. No specs exist yet in `openspec/specs/`. The new settings tables (`[t3]`, `[limits]`) that
`relay-config` from `add-cli-scaffold` must accept are specified in `limit-rules` and
`t3-connection` and listed under Impact.

## Impact

- **Depends on** phases 1 (settings, CLI), 3 (accounts, Codex app-server reading, policies) and
  5 (daemon, events, status), and on `provider-allow-list` from phase 4.
- **New code:** `src/t3/` (connection, MCP client, thread actions), `src/usage/` (readers and
  timer), `src/limits/` (rules), and the commands `relay t3 connect|enable|disable|status|
  disconnect`.
- **Changes to earlier phases:** phase 1's command table gains `relay t3` (1 to 2 arguments) and
  `src/cli/exit-codes.ts` gains 40 (T3 not answering), 41 (T3 build too old) and 42 (not
  connected to T3); `relay-config` accepts `[t3]` and `[limits]`; the daemon starts
  the usage timer and the T3 watcher; `relay status` shows each rule and reading; new event
  types `usage_reading`, `limit_crossed`, `t3_thread_switched`, `t3_thread_continued`.
- **New dependency:** the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) for the
  Streamable HTTP client and OAuth.
- **New documentation:** `docs/t3.md`, the `[t3]` and `[limits]` sections of `docs/config.md`,
  and the new command, exit codes and events in `docs/first-version-index.md` and `docs/cli.md`.
- **Roadmap:** after approval, `docs/ROADMAP.md` records the T3 decision and places this change
  at the start of phase 7, and the private task board gets its tasks.
- **For people using it:** T3 Code must be a nightly build, with
  "Auto-resume limited threads" turned on.
