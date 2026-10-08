# Design

## Context

Josué runs night work in T3 Code threads on a personal Claude subscription. Two things went wrong on
2026-10-07: a thread stopped at the 5-hour limit and nothing continued it at the reset, and there
was no way to keep part of the weekly limit for chatting by hand. The research in
`docs/research/t3-outside-access.md` (2026-10-08) found:

- T3's nightly builds already continue a limited thread at its reset ("Auto-resume limited
  threads", off by default). Older builds, such as 0.0.40, do not have it.
- Outside programs can drive T3 only through its MCP server, and only in nightly builds from
  v0.0.46-nightly.20261006.2752. They sign in with OAuth and a pairing code; the token lasts 30
  days and cannot be refreshed.
- The MCP tools can list projects and threads, read a thread's turns, switch its provider
  (`t3_thread_configure`, which starts T3's portable handoff at the next turn), send a message,
  and interrupt a turn.
- The MCP tools show no usage percentages, no reset times and no "limited" status. A turn
  stopped by a limit shows as `failed`.

This change builds on interfaces that earlier proposals define and that are not built yet:

- From phase 1 (`add-cli-scaffold`): the settings loader and its problem list (exit code 78), the
  `config.toml` writer, the command table.
- From phase 3 (`add-provider-adapters`): accounts with profile folders, the credential
  environment rules, the Codex availability reading (`account/rateLimits/read`), provider
  policies, and the fake `claude` and `codex` programs.
- From phase 4 (`add-relay-switch`): the first-handoff question and the allow list writer
  (`src/handoff/allow-list.ts`).
- From phase 5 (`add-daemon-api-and-status`): the daemon, its timer and event stream, hook events
  attributed to an account through the profile folder (design decision 18), and `relay status`.

## Goals / Non-Goals

**Goals:**

- The person connects relay to T3 once and enables the projects relay may act on.
- Each account has a threshold and an action for each window, with defaults that match Josué's
  wish: use all of the 5-hour window, keep 10 percent of the weekly window.
- When a `switch` threshold is crossed, the work in enabled projects moves to the other provider
  at the end of the current turn, unattended, with every action recorded.
- Every number relay acts on is measured, recent and labelled with its source.

**Non-Goals:**

- Sending "continue" at a 5-hour reset (T3 does it).
- Rules for relay's own jobs, switching back after a reset, per-thread exclusions, and Cursor or
  OpenCode (see the proposal's "Out of scope").

## Decisions

### 1. Drive T3 through its MCP server only

relay uses only the MCP tools at `/mcp`. T3's WebSocket at `/ws` is internal and undocumented
for other programs, and T3's settings and SQLite files are internal storage, so relay neither
reads nor writes them (`docs/research/provider-control-surfaces.md` section 4.3, items b and d;
project rule "no reverse-engineered private APIs").

relay calls a fixed list of tools: `t3_project_list`, `t3_thread_list`, `t3_thread_read`,
`t3_thread_configure`, `t3_thread_send`, `t3_thread_interrupt` and `orchestrator_capabilities`.
The MCP client wrapper (`src/t3/client.ts`) refuses any other tool name before sending, so a bug
cannot turn relay's `full-access` grant into something larger. A test checks the list.

Alternative considered: become an ACP provider inside T3 (`provider-control-surfaces.md`
section 4.3, item c). That would put every turn through relay, which is far more work and
changes how the person uses T3. Rejected for now.

### 2. Leave continue-at-reset to T3

T3 knows each thread's exact reset time (`usageLimitResetAt`) and its recovery worker checks
that the thread is still waiting for that same reset before it sends anything. relay cannot see
that time through MCP. If relay also sent "continue" at a reset it estimated from its own
readings, two messages could arrive, and T3 does not deduplicate messages from two senders
(`t3-outside-access.md` section 5). So relay does not send "continue" for 5-hour resets. `relay
t3 enable` tells the person to turn on T3's setting, because relay cannot read it.

relay does send "continue" after a switch (decision 9). If T3 had a recovery pending for that
thread, relay's message comes first, and T3's guarded recovery then does nothing.

### 3. The MCP client and the sign-in

relay uses the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`): its Streamable HTTP
client transport, and its OAuth client support for discovery, dynamic client registration and
PKCE. relay implements only the SDK's `OAuthClientProvider` interface, which says where to keep
the client information and token (decision 4) and how to open the browser (`open` on macOS,
`xdg-open` on Linux).

The redirect address is `http://127.0.0.1:<random port>/callback`. `relay t3 connect` (never the
daemon) starts this listener with `Bun.serve` on `127.0.0.1` only. It accepts one `GET` whose
`state` matches, answers with a short page that says "relay is connected. You can close this
tab.", and closes after that request or after 120 seconds. The research could not confirm that
T3 accepts a loopback redirect address; task 1.1 checks it first. If T3 refuses it, the change
stops and comes back to Josué, because the alternative (a fixed port) needs a new decision.

Version check: at connect time and every time the daemon starts the T3 watcher, relay lists the
server's tools and requires the tools of decision 1. A missing tool gives exit code 41 at connect,
and in the daemon a `t3_disconnected` event with reason `t3_too_old`.

### 4. Keeping the token

The token is stored with Bun's built-in `Bun.secrets` (Keychain on macOS, libsecret on Linux),
service `relay-t3`, name equal to `t3.url`. The OAuth client registration (client ID, no secret,
since T3 registers public clients) is stored in the same place under the name
`<t3.url>#client`, so a new connect reuses it. The expiry time (30 days after the token was
issued) is stored in `RELAY_HOME/t3/connection.json` (mode `0600`), which holds no secret.

Command-line tools such as `security add-generic-password -w <token>` were rejected because they
put the token in the process arguments, which other programs of the same user can read. If the
pinned Bun version has no `Bun.secrets`, task 2.2 stops and reports it instead of falling back.

This is the exception to the project rule about tokens that the proposal asks Josué to approve.

### 5. Settings

```toml
[t3]
url = "http://127.0.0.1:3773/mcp"
projects = ["~/projects/app"]

[t3.instances.claude]
account = "claude:personal"

[t3.instances.codex]
account = "codex:personal"
model = "gpt-6.1-sol"          # used when relay switches a thread to this instance

[limits."claude:personal".seven_day]
threshold = 90
switch_to = "codex:personal"   # action defaults to "switch" when switch_to is set
```

The accounts must point at the same profile folders T3 uses, which by default are `~/.claude`
and `~/.codex`. `relay t3 connect` cannot check this, because T3 does not report its config
folders through MCP, so `docs/t3.md` explains it and gives this example:

```toml
[accounts."claude:personal"]
profile_dir = "~/.claude"
```

`relay-config` from phase 1 gains the top-level keys `t3` and `limits`. The problem messages
follow phase 1's format.

### 6. Usage readings

A timer in the daemon reads every account that a T3 instance or a `switch_to` names, every 5
minutes, while relay is connected and at least one project is enabled. A Claude `StopFailure`
hook with `rate_limit`, attributed to an account through its profile folder (phase 5, decision
18), starts an extra reading within 10 seconds. T3's Claude sessions run the person's hooks
(`t3-outside-access.md` section 6), so this works inside T3.

- **Codex:** phase 3's reading through `codex app-server`. Windows of 300 and 10080 minutes are
  named `five_hour` and `seven_day`.
- **Claude:** `claude -p "/usage"`. The research could not confirm whether it spends usage,
  whether it saves a session transcript (which would appear in the person's session lists), or
  what it prints. Task 1.2 answers all three on the Omarchy machine with a signed-in account,
  records the output in `test/fixtures/usage/`, and picks the parser. The command runs in
  `RELAY_HOME/run/usage` so a saved transcript, if any, lands under that folder rather than
  under a project, and with `--no-session-persistence` if the installed Claude Code supports it.
  If `/usage` costs usage or prints no weekly percentage, Claude readings are dropped from this
  change and Claude rules show "not measured".

A reading older than 15 minutes counts as not measured: three missed readings in a row. 5
minutes is a balance: at the weekly scale a 5-minute delay costs little of a 10 percent reserve,
and starting `claude` or `codex app-server` more often would be wasteful.

### 7. Rules and crossings

The rules engine (`src/limits/`) is a pure module: given the settings and a reading, it returns
the crossings that start or end. It does not know about T3, so phase 7 can reuse it for relay's
own jobs.

A crossing is identified by account, window and `resets_at` (or `none` when the reading has no
reset time). Crossings and actions are appended to `RELAY_HOME/t3/events.jsonl` with phase 5's
locked `appendEvent`, and the daemon rebuilds its in-memory view from that file when it starts.
This is what makes "once per crossing" and "each thread at most once per crossing" survive a
daemon restart. The events also go to the daemon's event stream for `relay status` and later
the Mac app.

### 8. Acting on threads

While a `switch` crossing is active, a 60-second loop in the daemon:

1. Lists the threads of each enabled project with `t3_thread_list` (project IDs come from
   `t3_project_list`, matched on `workspaceRoot` after resolving symbolic links).
2. Keeps threads whose `providerInstanceId` maps to the crossed account and whose turn is active
   or ended after the crossing started (`t3_thread_read`, `recentRuns[0].completedAt`).
3. For an active turn: does nothing until it ends. If it is still `running` 15 minutes after
   relay first saw it under this crossing, calls `t3_thread_interrupt` once. `waiting` turns are
   waiting for the person (an approval or a question) and are never interrupted.
4. For an ended turn: calls `t3_thread_configure`, then decision 9.

The 15-minute grace period lets most turns reach their own end, which is the closest thing T3
has to relay's checkpoints, while bounding how much of the reserve one long turn can use.
Alternative considered: interrupt at once. Rejected because it cuts agents off mid-step, which
the vision avoids ("an agent that is almost done is left alone").

Only one action per thread runs at a time. Calls that fail are retried twice, 30 seconds apart.

### 9. When to send "continue"

The MCP answers do not say why a turn failed. relay sends `continue` after a switch when relay
interrupted the turn itself or the turn ended `failed`; it sends nothing after `completed` or
`cancelled` (the work had reached a stopping point, or the person stopped it). A turn that
failed for a reason unrelated to the limit therefore also gets `continue` on the new provider.
That is accepted: the new agent reads the thread and either continues or reports the problem,
and the event log shows what happened.

The `clientRequestId` is `relay-<threadId>-<runId>`, so a retry never sends a second message.
The text is always exactly `continue`; nothing read from T3 is placed into it.

### 10. Notifications

`notify` uses `osascript -e 'display notification "<text>" with title "relay"'` on macOS and
`notify-send relay "<text>"` on Linux, with the text built only from the provider name, account
name, percentage and window, which relay controls. One notification per crossing.

### 11. Module layout

```
src/t3/client.ts          MCP client wrapper, tool allow list, retries, logging
src/t3/oauth.ts           OAuthClientProvider, loopback listener, Bun.secrets storage
src/t3/connection.ts      connection.json, expiry, version check
src/t3/watcher.ts         the 60-second loop of decision 8
src/t3/actions.ts         switch and continue
src/t3/commands.ts        relay t3 connect|enable|disable|status|disconnect
src/usage/timer.ts        decision 6 timer and hook trigger
src/usage/claude.ts       claude -p "/usage" and its parser
src/usage/codex.ts        thin wrapper over phase 3's reading
src/limits/rules.ts       settings to rules, defaults, checks
src/limits/crossings.ts   the pure crossing engine
src/limits/notify.ts      decision 10
```

### 12. Tests

No test talks to a real T3. A fake T3 server (`test/fakes/fake-t3.ts`) is built with the MCP
SDK's own server classes on a random `127.0.0.1` port. It serves the tools of decision 1 with
scripted threads, records every call, implements the OAuth endpoints with a fixed pairing code,
and can answer `401` or stop answering. The fake `claude` prints recorded `/usage` output from
`test/fixtures/usage/`. All timers use phase 5's injectable clock.

## Risks / Trade-offs

- [T3's nightly MCP tools change shape.] → The version check (decision 3) refuses missing tools,
  the fake server's fixtures come from the commit cited in the research, and `docs/t3.md` names
  the last T3 build checked.
- [`claude -p "/usage"` output changes or costs usage.] → Task 1.2 checks first; the parser fails
  loudly ("not measured") instead of guessing, and a test pins the recorded output.
- [Readings lag up to 5 minutes, plus the 15-minute grace period.] → At the weekly scale this is
  a small part of a 10 percent reserve; the person can lower the threshold.
- [`full-access` grant.] → relay calls only the tools of decision 1, enforced in one place and
  tested. The person can revoke the grant in T3 at any time.
- [A thread failed for another reason gets `continue`.] → Accepted (decision 9) and logged.
- [The token expires every 30 days without refresh.] → Warnings from 3 days before, in both
  status commands; when it expires, relay stops acting and says so instead of failing quietly.
- [Accounts point at other profile folders than T3's.] → Readings would describe the wrong
  account. Documented in `docs/t3.md`, with the default folders as the example.
- [Two programs act on the same thread: relay and the person.] → relay acts only after a turn
  ends and sends one idempotent message; if the person already sent something, `auto` mode
  queues relay's `continue` behind it, which is harmless.

## Migration Plan

Nothing exists yet, so there is nothing to migrate. To stop using the feature, the person runs
`relay t3 disconnect` and removes the grant in T3's Connections screen. `relay t3 disable` stops
actions for one project. Removing the `[t3]` table turns the watcher off.

## Open Questions

- Does T3's approval page accept a loopback redirect address? (Task 1.1. If not, Josué decides.)
- Does `claude -p "/usage"` spend usage, save a transcript, and print the weekly percentage?
  (Task 1.2.)
- Are T3 provider instance IDs stable across T3 restarts and updates? (Task 1.1 records them
  before and after a restart.)
- Should T3 be asked to expose `usageLimitResetAt` and the usage windows through MCP? That
  would remove decision 6's Claude workaround. This is Josué's call, outside this change.
