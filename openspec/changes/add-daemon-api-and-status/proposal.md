# Proposal

## Why

After phases 1 to 4, relay can checkpoint a job and hand it to another agent, but every command
works alone: nothing keeps watching the job, provider hooks have nowhere to report a limit, and
there is no way to see at a glance which account is working, which one hit its limit and when it
resets. This change adds the small background process (the daemon), its private local API and the
`relay status` command, so that the job's live state is visible to the terminal now and to the Mac
app later (`docs/ROADMAP.md`, phase 5; `docs/research/architecture.md`, "First build steps", step 5).

## What Changes

- **The relay daemon.** A background process, one per user, that the command-line tool starts on
  demand (`relay run` and `relay switch` start it when it is not running). It holds an exclusive
  lock file, writes a pid file, shuts down cleanly on `SIGTERM` and `SIGINT`, and writes rotated
  JSON-lines logs to `~/.relay/logs/daemon.log`. New commands: `relay daemon start`,
  `relay daemon stop`, `relay daemon restart`, `relay daemon status` and `relay daemon run`
  (foreground). Source: `docs/research/architecture.md` sections 7 and 8 (starting on demand, files
  under `~/.relay/`, log rotation) and earlier research on agent session formats ("relay must
  interrupt only processes it owns", "relay must manage stdin and output explicitly").
- **A local API on a Unix domain socket only.** The socket is `~/.relay/run/relay.sock` on macOS
  and `$XDG_RUNTIME_DIR/relay/relay.sock` on Linux, inside a directory with mode `0700`. The daemon
  refuses to start if that directory is a symbolic link, belongs to another user, or is readable
  or writable by group or others, and it checks the user ID of every connecting process with the
  kernel (`getpeereid` on macOS, `SO_PEERCRED` on Linux). There is no TCP port. Source:
  `docs/research/security.md` section 1, "Recommendation", items 1 and 3.
- **HTTP with JSON under `/v1`, and server-sent events for live status.** Endpoints:
  `GET /v1/version`, `GET /v1/providers`, `GET /v1/accounts`, `GET /v1/accounts/{target}`,
  `GET /v1/jobs`, `GET /v1/jobs/{job}`, `GET /v1/jobs/{job}/workers`,
  `GET /v1/jobs/{job}/checkpoints`, `GET /v1/events` (server-sent events, resumable with
  `Last-Event-ID`), `POST /v1/jobs/{job}/checkpoint` and `POST /v1/jobs/{job}/switch` (both call
  the phase 2 and phase 4 engines), and `POST /v1/hooks/{provider}/{event}` (used by `relay hook`).
  Versioning follows `docs/research/architecture.md` section 2, "Protocol" and "Versioning": the
  major version is in the path, `GET /v1/version` lists capabilities, and fields are only ever
  added within `/v1`.
- **SQLite for live state only.** `~/.relay/relay.db` holds the jobs index, workers, execution
  targets (accounts), their availability, a cursor into each job's `events.jsonl` and a short
  replay buffer for the event stream. It is a cache: when it is missing, damaged or from another
  schema version, the daemon rebuilds it from the `.relay/` files, the git checkpoint refs and
  `config.toml`, and `relay doctor --reindex` forces a rebuild. Source:
  `docs/research/architecture.md` section 3.
- **`relay hook <provider> <event>`, delivered to the daemon.** The command that Claude Code and
  Codex hooks call. `add-provider-adapters` builds it with a spool file and installs the hooks
  (`relay hooks install`); this change adds delivery to the daemon. It reads the hook's JSON on
  standard input, keeps only an allow-listed set of fields, sends them to the daemon, and falls
  back to the spool file when the daemon is not running. It always exits with code 0, prints
  nothing, and finishes within 500 milliseconds, so it never blocks or changes the agent. A Claude
  Code `StopFailure` hook whose `error` field is `rate_limit` marks the account as rate limited
  (the hooks page names the field `error`; `architecture.md` section 6 calls it `error_type`).
  Source: `docs/research/architecture.md` section 6, "Signals" and "Hooks verified today";
  `docs/research/provider-control-surfaces.md` section 1.3.
- **Event log writes under a file lock.** Any relay process that appends to a job's
  `.relay/events.jsonl` does so through one function (`appendEvent` in the phase 2 module
  `src/job/events.ts`) that holds a short exclusive lock on
  `~/.relay/locks/<job>.events.lock`. Phase 2 builds the function and the lock; this change
  switches the lock to `flock`, which the kernel releases when a process dies. The daemon reads
  the file from a saved cursor instead of being the only writer. This is a deliberate departure from `docs/research/architecture.md` section 3, rule 1
  ("only the daemon writes to `events.jsonl`"): phases 2 and 4 already work without a daemon, and
  `relay status` must work when the daemon is down. For the same reason `state.json` stays
  written by the engines rather than generated from SQLite (section 3, rule 2). Design decision 9
  explains both.
- **`relay status`.** Shows the job, its latest checkpoint and one row per account in the lanes
  style from the design notes: availability in words, the reset time when it is known, "unknown"
  when nothing was measured, and never a combined total across accounts. It has a text mode and a
  `--json` mode, and when the daemon is not running it reads the files directly and says so.

### Decision pending Josué's decision

- **Local API transport: Unix socket only, including for the future Mac app.**
  This is pending Josué's decision (`docs/ROADMAP.md`, "Decisions waiting for Josué", "Local API
  transport"). Approving this proposal approves the recommendation. `docs/research/architecture.md`
  section 2 suggested a second listener on `127.0.0.1:7331` with a token, mainly because Swift's
  `URLSession` cannot open a Unix socket. `docs/research/security.md` section 1 recommends the socket
  alone, because browsers cannot reach a Unix socket, so cross-site requests and DNS rebinding (a
  web page tricking the browser into sending requests to your own computer) do not apply. The cost
  is that the Mac app (phase 8) must use Apple's Network framework (`NWEndpoint.unix(path:)`) and
  parse HTTP itself. A TCP listener would be added later only if a browser-based client must talk
  to relay.

## Out of scope

- The Mac menu-bar app (phase 8).
- Automatic failover: nothing in this change acts on availability; it is only recorded and shown
  (phase 7).
- Leases, heartbeats and the task queue (phase 9). The schema has no leases table yet.
- Any TCP listener, token file or `Host`/`Origin` handling for TCP.
- New availability sources. The daemon indexes the readings `add-provider-adapters` already
  records (the `availability` events and each account's `availability.json`, fed by headless runs,
  hooks, Claude Code's status line when the person installed it, and `relay account status`), and
  adds none of its own. Polling Codex's app server for rate limits on a timer is phase 7. Claude
  reset times therefore show as "reset unknown" unless phase 3 recorded one.
- Installing hooks into provider settings. `add-provider-adapters` does this with
  `relay hooks install`; this change only adds delivery of hook events to the daemon and extends
  `docs/hooks.md`.
- `relay daemon install` (a macOS launch agent or a systemd user service).
- A `relay note` command and any endpoint that writes arbitrary events.

## Security

- **Local API.** Socket only, in a `0700` directory owned by the user, with the socket file
  itself set to `0600`, and a kernel peer user check on every connection; connections from another
  user are closed before any byte is read. Requests that carry an `Origin` header are refused, as
  defence in depth. No endpoint runs a shell command or accepts a path to execute: actions name a
  job and an operation, and relay decides the rest (`docs/research/security.md` section 1,
  "Recommendation", item 3). The documentation states the limit honestly: any program running as
  the same user can use the socket, just as it can read `~/.claude` and `~/.codex`.
- **Hooks.** `relay hook` stores only allow-listed fields (`session_id`, `cwd`,
  `hook_event_name`, `error`, `notification_type`, `reason`, `source`, `model`, `turn_id`, the
  same list as `add-provider-adapters`) and never tool inputs,
  tool outputs, prompts or the environment (`docs/research/security.md` section 3,
  "Recommendations", item 1). The spool file is `0600` in a `0700` directory.
- **Credentials.** The daemon never reads, logs or stores provider credentials. Its logs never
  contain environment variables or hook payloads beyond the allow list
  (`docs/research/security.md` section 2).
- **Git.** The checkpoint and switch endpoints only call the phase 2 and phase 4 engines, which
  already run git with hooks and `core.fsmonitor` disabled and write to `refs/relay/...`. The daemon
  reads checkpoints with `git for-each-ref` through the same safe git wrapper.
- **Processes.** `relay daemon stop` signals a process only after the daemon's own API confirms
  that its process ID matches the pid file, so relay never kills a process it does not own
  (earlier research on agent session formats, "relay must interrupt only processes it owns").

## Capabilities

### New Capabilities

- `daemon-lifecycle`: starting the daemon on demand, one per user, the lock and pid files, clean
  shutdown, logs, and the `relay daemon` commands.
- `local-api`: the Unix socket transport and its permission and peer checks, HTTP and JSON under
  `/v1`, every endpoint and its responses and errors, server-sent events, and versioning.
- `live-state-index`: the SQLite store of live state, the locked event log writes, and rebuilding
  the store from `.relay/` files, git refs and configuration.
- `provider-hooks`: the `relay hook <provider> <event>` command contract shared with
  `add-provider-adapters`, delivery to the daemon, draining the spool file, and how hook events
  change worker records and account availability.
- `status-command`: `relay status` in text and `--json` modes, with and without the daemon.

### Modified Capabilities

None. No specs exist yet in `openspec/specs/`. The small changes this proposal makes to code from
phases 2 to 4 (the `flock` lock inside `appendEvent`, delivery in `relay hook`, registering project
roots) are listed under Impact and specified in the new capabilities above.

## Impact

- New code: `src/platform/libc.ts`, `src/platform/peer-credentials.ts`,
  `src/platform/file-lock.ts`, `src/daemon/`, `src/api/`, `src/state/`, `src/hooks/mapping.ts`,
  `src/status/`, `src/client/`, and the CLI commands `relay daemon`, `relay status` and
  `relay doctor --reindex`, which `add-cli-scaffold` already lists. Exit code 10 is new and no
  other change uses it.
- Changes to earlier phases: `appendEvent` in `src/job/events.ts` (phase 2) keeps its signature
  and switches its events lock to `flock`; phase 3's `src/hooks/hook-command.ts` gains delivery
  to the daemon before it falls back to the spool; `relay init` appends the project root to
  `~/.relay/projects.list`. The `RELAY_JOB`, `RELAY_TARGET`, `RELAY_WORKER` and `RELAY_HOME`
  variables that hooks use are already set by the phase 3 adapters.
- New files under `RELAY_HOME` (default `~/.relay`): `run/` (or `$XDG_RUNTIME_DIR/relay/` on
  Linux) with `relay.sock`, `daemon.lock` and `daemon.pid`; `relay.db`; `projects.list`;
  `spool/hooks.jsonl`; `logs/daemon.log` and `logs/hook.log`.
- New lock files under `RELAY_HOME`: `locks/<job>.events.lock`, next to the phase 2 job locks.
- New documentation: `docs/api.md`, `docs/hooks.md`, `docs/daemon.md`.
- No new dependencies: the design uses Bun's built-in `Bun.listen`, `bun:sqlite` and `bun:ffi`
  (the runtime itself is pending Josué's decision in `docs/ROADMAP.md`; phase 1 assumes Bun).
