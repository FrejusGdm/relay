# relay: T3 Code's door for outside programs, and its limit handling

Researched on 2026-10-08 by reading T3 Code's source with `gh api` (no clone) and its
documentation. **Stable** means release v0.0.45 (2026-10-02). **Main** means commit
`f9e16b3f66476ad1e213152708c9aa8b035085a3` (2026-10-08). This note updates
`provider-control-surfaces.md` sections 4.3 and 4.5, which were written a day earlier.
Older builds, such as 0.0.40, have none of the features below.

## The short version

1. Outside programs can drive T3 threads only in nightly builds from
   v0.0.46-nightly.20261006.2752 (2026-10-07) onward. Stable has no outside access.
2. T3 already continues a thread when its usage limit resets, but only in nightly builds,
   and only when the person turns the setting on (it is off by default).
3. T3's door for outside programs shows no usage percentages, no reset times, and no
   "limited" status. relay has to measure usage itself.
4. An outside program can switch a thread from Claude to Codex and send it a message.

## 1. Which builds have what

| Feature | First build | In stable v0.0.45? |
|---|---|---|
| "Limited" badge, "Resume at reset", "Auto-resume limited threads" | v0.0.46-nightly.20261003.2610 (2026-10-03) | No |
| Outside programs signing in to the MCP server at `/mcp` | v0.0.46-nightly.20261006.2752 (2026-10-07) | No |
| "Install" button for the `t3` command in Settings | v0.0.46-nightly.20261008.2801 (2026-10-08) | No |

Sources: the release notes of
[v0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610),
[v0.0.46-nightly.20261006.2752](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261006.2752)
and [v0.0.46-nightly.20261008.2801](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261008.2801);
commit `2c8be5893eb3754071162e344a8c8e8a67bef597`. Stable has an `/mcp` endpoint too, but
only T3's own provider sessions can use it.

## 2. How an outside program connects (main)

- **Transport.** MCP over Streamable HTTP at `/mcp`, protocol revision `2025-06-18`. The
  address is shown in **Settings → Connections → environment menu → Copy MCP URL**. The
  desktop app usually listens on `127.0.0.1:3773` but moves to a higher port when 3773 is
  taken, and can listen on all interfaces when the person turns on network access.
  Source: `apps/server/src/mcp/McpHttpServer.ts`, `docs/user/outside-agents.md`,
  `docs/user/remote-access.md`.
- **Sign-in.** OAuth with PKCE (a standard way for a program to get a token without a
  stored password), discovery, and dynamic client registration. The person approves the
  program on T3's approval page with a pairing code from Connections or from
  `t3 auth pairing create`. The token lasts 30 days, can be revoked in Connections, and
  cannot be refreshed: after 30 days the person approves again. Source:
  `apps/server/src/auth/McpOAuth.ts`, `apps/server/src/auth/EnvironmentAuth.ts`.
- **Access levels.** `read-only` (the default), `approval-required`, `auto-accept-edits`,
  `auto` and `full-access`. Every level above read-only may operate threads, but never a
  thread whose permission mode is broader than the level. T3's default thread mode is full
  access (`provider-control-surfaces.md` section 4.5), so a program that must act on
  ordinary threads needs the `full-access` level. Source: `packages/contracts/src/auth.ts`,
  `apps/server/src/mcp/threadAccess.ts`.

## 3. The tools relay would use (main)

- `t3_project_list` returns each project's `id` and `workspaceRoot` (its folder).
- `t3_thread_list` returns each thread's `status`, `providerInstanceId`, `model`,
  `runtimeMode`, `latestRunId` and `updatedAt`. It can filter by project and status.
- `t3_thread_read` adds `activeRunId`, `worktreePath`, `branch` and recent runs with
  `startedAt` and `completedAt`.
- `t3_thread_configure` takes a `threadId` and a `modelSelection` (`instanceId`, `model`,
  optional `options`). Changing the instance from a Claude one to a Codex one starts T3's
  portable handoff, which runs at the next turn. It never changes the permission mode and
  asks for no confirmation.
- `t3_thread_send` takes a `threadId`, a `message`, a `mode` (`auto`, `queue`, `steer`,
  `restart`) and a `clientRequestId` that makes retries safe. On a thread with no active
  turn, `auto` starts a turn at once. It does not wait for a limit to reset.
- `t3_thread_wait` waits for a turn to end, and `t3_thread_interrupt` stops a running turn.
- `orchestrator_capabilities` lists provider instances and their models.

Source: `packages/contracts/src/orchestratorMcp.ts` and `apps/server/src/mcp/toolkits/`.

## 4. What the door does not show (main)

- **No "limited" status.** Thread and turn statuses are `idle`, `preparing`, `queued`,
  `starting`, `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled` and
  `rolled_back`. A turn stopped by a usage limit is just `failed`. T3 keeps the reason
  (`lastErrorClass`) and the reset time (`usageLimitResetAt`) internally, but the MCP
  answers leave them out. Source: `apps/server/src/mcp/OrchestratorMcpService.ts`.
- **No usage percentages.** No tool reports an account's 5-hour or weekly percentage.
  T3 has them internally (`usageLimits.windows`, with `usedPercent`, `resetsAt` and a
  `kind` of `session` or `weekly`), but only for its own windows, not for outside
  programs. Source: `packages/contracts/src/providerUsageLimits.ts`.
- **Where T3 gets them.** For Codex, from the app server's `account/rateLimits/read` and
  `account/rateLimits/updated`, which relay can call too. For Claude, from the SDK's
  `rate_limit_event` and from an SDK call named
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. relay should not use the
  second one. Source: `apps/server/src/provider/claudeUsageLimits.ts`,
  `apps/server/src/provider/codexUsageLimits.ts`.

## 5. T3's own continue at reset (nightly)

The setting is `autoResumeLimitedThreads`, off by default, stored in T3's
`userdata/settings.json`. When it is on, T3 sends "Continue where you left off." to a
limited thread at its reset time, and it checks first that the thread is still waiting for
that same reset. If an outside program has already sent a message, T3's own message does
nothing. If T3's message goes first, a second message from an outside program is not
deduplicated. Source: `packages/contracts/src/settings.ts`,
`apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts`.

## 6. Hooks inside T3's sessions

T3 runs Claude through the Agent SDK and loads the user's settings, so hooks in
`~/.claude/settings.json` run in T3's Claude sessions (stable sets
`settingSources: ["user", "project", "local"]`; main leaves it unset, and the SDK's default
is the same three). Codex hooks from the person's own Codex settings should also run under
T3's `codex app-server`, since T3 does not turn them off, but no test proves it. Source:
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
`apps/server/src/provider/codexLaunchArgs.ts`.

## Checked later

- **Loopback redirects are accepted** (checked in `apps/server/src/auth/McpOAuth.ts` at the same
  commit, 2026-10-08). An outside program may register `http://localhost`, `http://127.0.0.1` or
  `http://[::1]` redirect addresses, or any `https` address. Loopback redirects match on
  everything except the port, as RFC 8252 section 7.3 describes for command-line programs, so
  relay can listen on any free port. A client may register at most 5 redirect addresses of at
  most 512 characters, and the client ID T3 returns is signed, so T3 keeps no state for it.

## What I could not verify

- Whether `claude -p "/usage"` spends any usage, and whether its text includes the weekly
  percentage in a stable form. The Claude docs say `/usage` works in `-p` mode, but not
  what it prints there.
- Whether a Codex hook really runs inside a T3 session.
- How long nightly-only features take to reach a stable release.
