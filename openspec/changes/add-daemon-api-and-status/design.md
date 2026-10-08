# Design: the daemon, the local API and `relay status`

## Context

See proposal.md for the motivation. This change builds on the earlier phases and uses their names:

- Phase 1 (`add-cli-scaffold`): the `relay` binary, its command router, `RELAY_HOME` (default
  `~/.relay`), loading `config.toml` (with `[accounts."<provider>:<name>"]` tables; `docs/research/architecture.md`
  section 8 called them `targets`) and logging. This change calls an account an execution target
  (`target`) in the API and the database, written the same way, for example `claude:work`. If the scaffold's layout differs, keep
  the module names below and place them under its source root.
- Phase 2 (`add-checkpoint-engine`): job IDs are 8 lowercase hexadecimal characters (for example
  `3f9a2c1d`); checkpoints are refs `refs/relay/jobs/<job>/checkpoints/<n>` plus
  `refs/relay/jobs/<job>/latest`; `src/checkpoint/list.ts` reads them; `src/job/events.ts` appends
  and reads `events.jsonl`; `src/job/lock.ts` holds the job lock `$RELAY_HOME/locks/<job>.lock`
  during a writing command; `src/cli/exit-codes.ts` holds the exit code table; `src/git/run.ts` is
  the only place that starts git.
- Phase 3 (`add-provider-adapters`): the adapter interface (start, interrupt, stop, availability),
  the fake agents used in tests, the worker events, each account's `availability.json`, the
  spool form of `relay hook` (`src/hooks/hook-command.ts`, `fields.ts`, `spool.ts`), hook
  installation (`relay hooks install`), and the `RELAY_JOB`, `RELAY_TARGET`, `RELAY_WORKER` and
  `RELAY_HOME` variables in every agent's environment.
- Phase 4 (`add-relay-switch`): the switch engine `performHandoff` (stop, checkpoint, handoff
  prompt, start next).

Facts checked while writing this design (2026-10-07):

- **Bun 1.3.6 on this Mac.** `Bun.serve({ unix })` and `node:http` do not expose the file
  descriptor of an accepted connection (the spike returned `undefined`), and handing a stream to
  `node:http` with `server.emit("connection", stream)` did not work under Bun. `Bun.listen({ unix })`
  does expose `socket.fd`, and calling `getpeereid(fd, &uid, &gid)` through `bun:ffi` on that
  descriptor returned the connecting user's ID (501, matching `process.getuid()`). Bun's `fetch`
  accepts a `unix` option to send requests over a socket. The Linux path (`SO_PEERCRED`) was not
  tested; task 1.1 tests it on the Omarchy machine.
- **Claude Code hooks** ([hooks reference](https://code.claude.com/docs/en/hooks)): every hook gets
  `session_id`, `transcript_path`, `cwd`, `hook_event_name` and others on standard input.
  `StopFailure` adds `error` (named `error_type` in `docs/research/architecture.md` section 6; the
  hooks page and `provider-control-surfaces.md` section 1.3 name it `error`), one of `rate_limit`, `overloaded`, `authentication_failed`,
  `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`,
  `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`. It
  carries no reset time. Exit code 2 blocks the action; exit 0 with empty output changes nothing.
  A command hook accepts `args` (then no shell is used), `timeout` and `async: true` (runs in the
  background without blocking).
- **Codex hooks** ([Codex hooks](https://learn.chatgpt.com/docs/hooks)): events `SessionStart`,
  `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `Interrupt`. Input on standard input has
  `session_id`, `cwd`, `hook_event_name`, `model`, `transcript_path`, and `turn_id` for turn
  hooks. Exit 0 with no output means "continue"; exit 2 blocks. The default timeout is 600 seconds,
  but `SessionEnd` and `Interrupt` default to 1 second (3 seconds at most). There is no rate-limit
  event, which matches `docs/research/architecture.md` section 6.

## Goals / Non-Goals

**Goals:**

- A daemon that is safe to leave running: private socket, peer check, no network port, no
  secrets in logs.
- `relay status` that gives the same answer with and without the daemon.
- Hooks that can never slow down, block or alter an agent.
- A SQLite store that can be deleted at any time without losing anything about a job.

**Non-Goals:**

- Acting on availability (phase 7), leases (phase 9), the Mac app (phase 8), any TCP listener.
- A short numeric display alias for jobs. Phase 2 suggested one in SQLite, but a number that lives
  only in a rebuildable cache would change after a rebuild, so `relay://job/<id>` and the status
  header use the 8-character job ID.
- Measuring Claude usage through its status line (phase 7).

## Decisions

### 1. Files under `RELAY_HOME`

```
$RELAY_HOME/                     default ~/.relay, mode 0700
  config.toml                    phase 1
  relay.db, relay.db-wal, relay.db-shm   live state (decision 10), 0600
  projects.list                  known project roots, one per line (decision 12), 0600
  run/                           runtime directory on macOS and whenever RELAY_HOME is set, 0700
    relay.sock                   the API socket, 0600
    daemon.lock                  held with flock for the daemon's life, 0600
    daemon.pid                   {"pid","started_at","version","socket"}, 0600
  spool/hooks.jsonl              hook events received while the daemon was down, 0600
  locks/<job>.lock               phase 2 job lock
  locks/<job>.events.lock        short lock around one event append (decision 9)
  logs/daemon.log                JSON lines, 10 MB x 5 (decision 8)
  logs/daemon.stderr.log         standard output and error of the detached daemon (crash traces)
  logs/hook.log                  relay hook's own failures, phase 1 rotation (10 MB x 5)
  logs/workers/<job>-<worker>.log   output of headless workers (phase 3 format)
  accounts/<provider>-<name>/availability.json   phase 3 availability records, read by the index
```

On Linux without `RELAY_HOME` set, the runtime directory is `$XDG_RUNTIME_DIR/relay/`
(`docs/research/security.md` section 1, "Recommendation", item 1). If `XDG_RUNTIME_DIR` is unset,
it falls back to `$RELAY_HOME/run/`. Setting `RELAY_HOME` always puts the runtime directory inside
it, so tests are hermetic (`docs/research/architecture.md` section 8). The daemon calls
`process.umask(0o077)` at start, so every file and the socket are created private.

### 2. Runtime directory and socket path checks

From `docs/research/security.md` section 1 ("Two caveats on sockets", "Recommendation", item 1).
Module `src/daemon/paths.ts`, run by `relay daemon run` before anything else:

1. `mkdir(dir, { recursive: true, mode: 0o700 })`.
2. `lstat(dir)`. Refuse if it is a symbolic link ("relay cannot start: <dir> is a symbolic
   link."), not a directory, `stat.uid !== process.getuid()`, or `(stat.mode & 0o077) !== 0`
   ("relay cannot start: <dir> must be private (mode 0700, owned by you). Fix it with: chmod 700
   <dir>"). relay never changes the mode of a directory it did not create in this call.
3. The socket path in bytes (`Buffer.byteLength`) must be at most 103 on macOS and 107 on Linux
   (the `sun_path` field is 104 and 108 bytes including the final zero byte;
   `docs/research/architecture.md` section 2). Otherwise: "relay cannot start: the socket path
   <path> is too long. Set RELAY_HOME to a shorter path."
4. If `relay.sock` exists (checked after the lock is held, decision 5): `lstat` must report a
   socket; if so, unlink it. Anything else is refused: "relay cannot start: <path> exists and is
   not a socket."

All refusals exit with code 1 and are written both to standard error and to `daemon.log`.

### 3. The listener: `Bun.listen` with a peer check and a small HTTP/1.1 layer

From `docs/research/security.md` section 1 (peer user check on every connection) and the Bun
facts in Context. Module `src/api/server.ts`:

```ts
Bun.listen({ unix: socketPath, socket: {
  open(s)  { const uid = peerUid(s.fd);              // decision 4
             if (uid === null || uid !== process.getuid()) { log.warn("peer_rejected", { uid }); s.terminate(); return; }
             s.data = new Http1Connection(s, router); },
  data(s, chunk) { s.data.receive(chunk); },
  drain(s) { s.data.flush(); },
  close(s) { s.data?.closed(); },
}});
```

`src/api/http1.ts` implements only what relay's clients need, as a small state machine:

- Read the request head until `\r\n\r\n`; more than 16 KiB without it ends with `431`.
- Request line `METHOD SP target SP HTTP/1.1`. Methods other than `GET` and `POST` get `405`.
  Header names are case-insensitive; a header line without `:` gets `400`.
- `Transfer-Encoding` on a request gets `411` with code `length_required` (only `Content-Length`
  bodies are accepted). `Content-Length` above 65,536 gets `413`. A `POST` without
  `Content-Length` gets `411`.
- One request per connection. The full request must arrive within 10 seconds, or the connection
  is closed.
- The parsed request becomes a standard `Request` object (`new Request("http://relay" + target,
  { method, headers, body })`) and goes to `router(request): Promise<Response>`, so routing code is
  plain fetch-style code that tests call without any socket.
- The `Response` is written as `HTTP/1.1 <status> <reason>`, its headers, `Connection: close`, and
  either `Content-Length` with the body, or, for a streamed body (server-sent events), the stream's
  chunks as they come, ending when the stream ends and the connection closes. Writes respect
  back-pressure: when `s.write()` returns fewer bytes than given, the rest waits for `drain`.

Alternatives considered:

- `Bun.serve({ unix })`: complete HTTP, but no way to learn who connected, so the peer check would
  be impossible. Rejected.
- A front socket that checks the peer and forwards bytes to an internal `Bun.serve` socket in the
  same `0700` directory: reuses Bun's HTTP parser, but the internal socket could be reached without
  the peer check, and two sockets complicate shutdown. Rejected.
- `node:http` under Bun: no descriptor, see Context. Under Node it would work
  (`socket._handle.fd`), which keeps a later move to Node possible.

### 4. Peer credentials and file locks through `bun:ffi`

Module `src/platform/libc.ts` opens the C library once with `dlopen` (`libc.dylib` on macOS,
`libc.so.6` on Linux). It is the only module that imports `bun:ffi`, which keeps Bun-only APIs
behind a small platform module (`docs/research/architecture.md` section 1, "Risks").

- `src/platform/peer-credentials.ts`, `peerUid(fd): number | null`:
  - macOS: `getpeereid(int fd, uid_t *uid, gid_t *gid)`; return the `uid` when the call returns 0.
  - Linux: `getsockopt(fd, SOL_SOCKET = 1, SO_PEERCRED = 17, &ucred, &len)` with
    `struct ucred { int32 pid; uint32 uid; uint32 gid; }` (12 bytes); return `uid` when the call
    returns 0 and `len` is 12.
  - Any failure returns `null`, and the connection is refused (fail closed).
- `src/platform/file-lock.ts`, using `flock(int fd, int op)` with `LOCK_EX = 2`, `LOCK_NB = 4`,
  `LOCK_UN = 8` (same values on macOS and Linux):
  - `tryLock(path): LockHandle | null` opens the file (`O_RDWR | O_CREAT`, 0600) and calls
    `flock(fd, LOCK_EX | LOCK_NB)`; `null` when it is held elsewhere.
  - `lock(path, timeoutMs): Promise<LockHandle>` retries `tryLock` every 10 ms; after `timeoutMs`
    it throws `LockTimeout`. It is asynchronous because phase 2's `withEventsLock`, its first user,
    is.
  - `LockHandle.release()` calls `flock(fd, LOCK_UN)` and closes the file.

Why `flock`: the kernel releases it when the process dies, so a crash never leaves a stale lock
and relay never has to guess whether a process ID was reused
(earlier research on agent session formats, "relay must interrupt only processes it owns").
Phase 2's job lock uses exclusive file creation with a stale-process check; it is held for a whole
command and stays as it is.

### 5. One daemon: lock file and pid file

Module `src/daemon/singleton.ts`. `relay daemon run`:

1. Paths checks (decision 2) for the runtime directory.
2. `tryLock(run/daemon.lock)`. When it is held: read `daemon.pid` (if readable), write "relay
   daemon is already running (pid <pid>)" to standard error, exit 0. Two commands starting the
   daemon at the same moment therefore end with exactly one daemon and no error.
3. Remove a stale socket (decision 2, step 4) and a stale `daemon.pid`.
4. Open the database (decision 11), start the listener (decision 3).
5. Write `daemon.pid` as `daemon.pid.tmp` and rename it.
6. Log `daemon_started` with `pid`, `version`, `socket`, `schema_version`.
7. Start following event logs (decision 12) and, 1 second later, drain the spool (decision 18).

### 6. Starting on demand

From `docs/research/architecture.md` section 7 ("The command-line tool also starts the daemon on
demand"). Module `src/client/ensure-daemon.ts`, `ensureDaemon(): Promise<boolean>`, called by
`relay run` and `relay switch` before they start an agent, and by `relay daemon start`:

1. `GET /v1/version` with a 300 ms timeout. On `200`, compare `daemon_version` with the CLI's
   version; if they differ, print once to standard error "The relay daemon is running version
   <x>; this command is version <y>. Restart it with: relay daemon restart". Return `true`.
2. Otherwise start it detached with `node:child_process`:
   `spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", errFd, errFd], cwd: RELAY_HOME, env: process.env })`
   then `child.unref()`. `argv` is `[process.execPath, "daemon", "run"]` for the compiled binary
   and `[process.execPath, Bun.main, "daemon", "run"]` when running from source (the compiled
   binary is detected the way phase 1 does; if it has no helper, `Bun.main.startsWith("/$bunfs/")`).
   `errFd` is `logs/daemon.stderr.log` opened for appending. Standard input is `/dev/null`
   (earlier research on agent session formats, "relay must manage stdin and output
   explicitly").
3. Poll `GET /v1/version` every 50 ms for up to 3 seconds. On success return `true`.
4. On failure print "relay could not start its background service. Details are in
   ~/.relay/logs/daemon.log." (with the real path) and return `false`. `relay run` and
   `relay switch` continue without the daemon: their engines do not need it (decision 9), and
   their hooks will spool.

`relay status` never starts the daemon (status-command spec).

The daemon inherits the environment of the command that started it, because the phase 3 adapters
need `PATH` and, for accounts configured to use an API key, that variable. The adapters already
remove credential variables per account (openspec/config.yaml, "Providers and accounts"), and the
daemon never logs its environment.

### 7. Stopping and clean shutdown

Module `src/cli/commands/daemon.ts` and `src/daemon/main.ts`.

`relay daemon stop [--force]`:

1. If `tryLock(daemon.lock)` succeeds, no daemon runs: release it, print "relay daemon is not
   running", exit 0.
2. `GET /v1/version` with a 1-second timeout. No answer: print "relay daemon (pid <pid from
   daemon.pid>) is not responding. Stop it with: kill <pid>", exit 1, send nothing.
3. If `daemon.pid` and the API's `pid` differ: print "relay found a pid file that does not match
   the running daemon. Run relay daemon status.", exit 1.
4. If the API reports running headless workers (`GET /v1/version` includes `agents_running`, a
   list of `{ worker, target, job }`) and `--force` is absent: print "relay daemon is running 1
   agent (codex:personal on job 3f9a2c1d). Stopping the daemon stops it too. Run relay daemon stop
   --force to continue." (the count and list adapt), exit 1.
5. `process.kill(pid, "SIGTERM")`, then wait until `tryLock(daemon.lock)` succeeds, polling every
   100 ms for up to 40 seconds (30 seconds for operations plus margin). Success: "relay daemon
   stopped", exit 0. Timeout: "relay daemon (pid <pid>) did not stop within 40 seconds. It is
   still finishing work; see <log path>.", exit 1.

`relay daemon restart` is `stop` (passing `--force` through) followed by `start`.
`relay daemon status` prints, when running:

```
Running   pid 4121 · version 0.5.0 · started 14:02
Socket    ~/.relay/run/relay.sock
Log       ~/.relay/logs/daemon.log
```

and exits 0; otherwise "relay daemon is not running" and exit code 10. `relay daemon start`
prints "relay daemon started (pid 4121)" or "relay daemon is already running (pid 4121)". Exit
code 10 ("the relay daemon is not running or could not start") is added to
`src/cli/exit-codes.ts`; phase 2 uses codes up to 8.

Shutdown on `SIGTERM` or `SIGINT` (`src/daemon/main.ts`):

1. Stop the listener, so new connections are refused.
2. Send `event: shutdown` with `data: {}` to every event-stream client and end those streams.
3. Wait for running operations (decision 17) for up to 30 seconds. Operations are never cut off
   in the middle of a git command; if 30 seconds pass, the daemon logs which operation is still
   running and keeps waiting for it, and `relay daemon stop` reports its own timeout.
4. Stop headless workers through their adapter's `stop()`, wait up to 30 seconds, and
   append `worker_ended` with `end_reason` `relay_stopped` for each.
5. `PRAGMA wal_checkpoint(TRUNCATE)`, close the database.
6. Unlink `relay.sock` and `daemon.pid`, log `daemon_stopped`, exit 0 (the kernel releases the
   lock).

`SIGHUP` reloads `config.toml` and rebuilds the `targets` table.

### 8. Logs

From `docs/research/architecture.md` section 8. Module `src/daemon/log.ts`, built on the phase 1
logger. Each line is one JSON object: `{"ts":"2026-10-07T14:02:11.402Z","level":"info","msg":"daemon_started","pid":4121,...}`.
Levels: `debug`, `info`, `warn`, `error`, chosen as phase 1 does (`--log-level`, then `RELAY_LOG_LEVEL`, then `log.level`, then `info`). Before a write would take
the file past 10 MB, the files shift (`daemon.log.4` to `.5`, and so on; `.5` is deleted) and a new
file starts. Rules: no environment variables, no request bodies, no hook fields outside the
allow list (decision 18), no command output. Requests are logged as method, path, status and
duration only.

### 9. Event log writes under a lock, and `state.json`

`docs/research/architecture.md` section 3 rule 1 says only the daemon writes `events.jsonl`, and
rule 2 says `state.json` is generated from SQLite. Phase 2 deferred both to this phase. This design
keeps the files as they are written by the engines and adds a lock instead:

- `appendEvent(job, type, data)` in `src/job/events.ts` (phase 2) already holds
  `locks/<job>.events.lock`; this change replaces phase 2's exclusive-create lock file with
  `lock(locks/<job>.events.lock, 2000)` from `src/platform/file-lock.ts`, so a crash never leaves a
  stale lock. With the lock held it reads the last complete line's `id`, writes `{"id": last + 1, ...}` plus `\n` in one `write`
  call, and releases the lock. Holding the lock covers only these steps (milliseconds), so a hook
  event can be appended while a long `relay switch` holds the phase 2 job lock.
- Every writer (phase 2 to 4 commands, and the daemon for hook and availability events) uses
  this function; a test fails if any other file opens `events.jsonl` for writing.
- `state.json` stays written by the engines with write-to-temporary-then-rename, as phase 2
  designed.

Why: making the daemon the only writer would make `relay checkpoint`, `relay rollback` and
`relay switch` fail whenever the daemon cannot start, and would make the source of truth depend on
the cache. Generating `state.json` from SQLite has the same problem in reverse: SQLite is
rebuilt from `state.json` (decision 11). A short lock gives the same guarantees rule 1 wanted (one
writer at a time, increasing IDs, whole lines) without that dependency.

Event types this change reads. The names and fields are the ones phases 2 to 4 write (`add-checkpoint-engine` design section 16, `add-provider-adapters` decision 16, `add-relay-switch` decision 20; `docs/first-version-index.md` lists them all). The mapping lives in `src/state/apply-event.ts` only.

| Type | Written by | Fields the index uses |
|---|---|---|
| `job_started` | phase 2 `relay init` | `title` (the job ID is the event's `job`) |
| `checkpoint_saved` | phase 2 `saveCheckpoint`, every kind | `number`, `commit`, `kind`, `message` |
| `rollback` | phase 2 | `to_checkpoint` (the index reloads the last checkpoint from git) |
| `worker_started` | phases 3 and 4 | `worker_id`, `target`, `mode`, `pid`, `provider_session_id`, `from_handoff` |
| `worker_session_identified` | phase 3 | `worker_id`, `provider_session_id` |
| `worker_ended` | phases 3 and 4, daemon | `worker_id`, `exit_code`, `signal`, `end_reason` |
| `handoff` | phase 4 | `from_worker_id`, `to_target`, `checkpoint_number` |
| `availability` | phase 3, daemon | `target`, `status`, `reason`, `retry_at`, `measured_at`, `source`, `windows` |
| `hook` | daemon (new) | `provider`, `event`, the allow-listed fields; also `received_at`, `relay_worker` and `worker_id` for interactive workers (decision 18) |

Unknown types are kept in the replay buffer as they are and otherwise ignored. A type must be 1 to
64 characters from `a` to `z` and `_`, because it is written into the event stream's `event:`
line; a line with any other type is treated as a line that is not an event (skipped and logged).
The data of an unknown type is passed on only when its JSON is at most 16 KiB.

### 10. SQLite schema

From `docs/research/architecture.md` section 3 ("Schema sketch"), reduced to live state, without
leases, tasks, checkpoints or handoffs (those live in git and `.relay/`). File
`src/state/schema.sql`, applied by `src/state/db.ts` with `bun:sqlite`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 2000;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- built_at, daemon_version, stream_epoch
CREATE TABLE projects (
  root_path    TEXT PRIMARY KEY,                -- absolute worktree root
  missing      INTEGER NOT NULL DEFAULT 0,      -- 1 when the folder was not found at the last rebuild
  last_seen_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id                     TEXT PRIMARY KEY CHECK (id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  project_root           TEXT NOT NULL REFERENCES projects(root_path) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  state                  TEXT NOT NULL,          -- copied from state.json, not interpreted
  current_worker_id      TEXT,
  last_checkpoint_number INTEGER,
  last_checkpoint_commit TEXT,
  last_checkpoint_at     TEXT,
  last_checkpoint_kind   TEXT,                   -- so a Job answer needs no git call
  last_checkpoint_message TEXT,
  updated_at             TEXT NOT NULL
);
CREATE TABLE targets (
  id          TEXT PRIMARY KEY,                 -- 'claude:work'
  provider    TEXT NOT NULL,                    -- 'claude'
  account     TEXT NOT NULL,                    -- 'work'
  profile_dir TEXT,
  configured  INTEGER NOT NULL                  -- 1 when present in config.toml
);
CREATE TABLE availability (
  target_id   TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('available','rate_limited','quota_exhausted','unavailable','unknown')),
  reason      TEXT,
  retry_at    TEXT,
  measured_at TEXT,
  source      TEXT,
  usage_json  TEXT NOT NULL DEFAULT '[]'        -- [{window, window_minutes, used_percent, resets_at, measured_at}]
);
CREATE TABLE workers (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_id           TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('headless','interactive','external')),
  pid                 INTEGER,
  provider_session_id TEXT,
  from_handoff        INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  exit_code           INTEGER,
  end_reason          TEXT,
  found_gone_at       TEXT                    -- when the daemon found the process gone without an end
);
CREATE INDEX workers_by_job ON workers(job_id, started_at DESC);
CREATE TABLE event_cursors (
  job_id        TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                  -- <root>/.relay/events.jsonl
  device        INTEGER NOT NULL,
  inode         INTEGER NOT NULL,
  offset        INTEGER NOT NULL,               -- bytes read so far (always at a line end)
  last_event_id INTEGER NOT NULL
);
CREATE TABLE stream_events (                    -- replay buffer for GET /v1/events
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT,
  type    TEXT NOT NULL,
  data    TEXT NOT NULL,
  ts      TEXT NOT NULL
);
PRAGMA user_version = 1;
```

Times are ISO 8601 in UTC with milliseconds. The daemon is the only process that opens the
database for writing. After every 1,000 inserts into `stream_events`, rows older than the newest
10,000 are deleted.

### 11. Building and rebuilding the index

Module `src/state/index-builder.ts`, `buildIndex(db, sources)`, where `sources` gives
`config.toml` targets, the deduplicated `projects.list`, and file readers. The same function fills
the daemon's database and the in-memory database (`new Database(":memory:")` with the same schema)
that offline `relay status` uses, so both views come from one code path.

Rebuild triggers when the daemon opens `relay.db`: the file is missing; opening fails or
`PRAGMA integrity_check` does not return `ok` (the file is renamed to
`relay.db.broken-<UTC timestamp>` first); or `PRAGMA user_version` differs from the expected
version (the file is deleted; it is only a cache). `relay doctor --reindex` (in
`src/cli/commands/doctor.ts`) stops the daemon with `relay daemon stop` (refusing as that command
does when agents are running), deletes `relay.db`, `relay.db-wal` and `relay.db-shm`, runs
`ensureDaemon()`, then reads `GET /v1/jobs` and prints "Rebuilt the index from .relay/ files in
<n> projects."

`buildIndex` steps, in one transaction:

1. Insert every target from `config.toml` with `configured = 1`, and its availability from
   phase 3's `accounts/<provider>-<name>/availability.json` when that file exists, else `unknown`.
2. For each project root: if `<root>/.relay/state.json` is missing, mark the project `missing`
   and continue. Otherwise read `job_id`, `title` and `state` (title falls back to the first `# `
   heading of `task.md`, then to "Untitled job").
3. Read `events.jsonl` from the start with `readEvents` from `src/job/events.ts` and apply each
   event with `applyEvent` (`src/state/apply-event.ts`). Availability events from all projects
   are applied in `measured_at` order, so the newest measurement wins.
4. Read the newest checkpoint with `src/checkpoint/list.ts` (git refs are the source of truth for
   checkpoints) and set the `last_checkpoint_*` columns.
5. Save the cursor (`device`, `inode`, `offset` at the last complete line, `last_event_id`).

Availability is also kept for targets that are not configured but appear in events (for example
an account removed from `config.toml`), with `configured = 0`; such accounts are not shown by
`relay status`.

### 12. Following event logs and the projects list

Module `src/daemon/follow.ts`. For each indexed job, `fs.watch` on the events file plus a timer
every 2 seconds (watching alone misses changes on some file systems). On each check, `stat` the
file:

- Same device and inode, size greater than `offset`: read from `offset`, split on `\n`, keep an
  incomplete last part for later, parse each line (invalid JSON is logged with the line's byte
  position and skipped), apply each event in one transaction, update the cursor, and push the
  resulting changes onto the event stream.
- Size smaller than `offset`, or a different inode (a rollback restored the file): delete the job's
  rows and rebuild that job with `buildIndex` for one project.

`projects.list` (module `src/state/projects-list.ts`) is checked on the same 2-second timer; new
roots are indexed. `relay init` and every command that resolves a job call
`registerProject(root)`, which appends `root + "\n"` with one `appendFileSync` if the root is not
already in the file. Lines are deduplicated when read; a single short append never interleaves
with another.

### 13. HTTP rules and errors

All JSON responses use `Content-Type: application/json; charset=utf-8`. Requests carrying an
`Origin` header get `403 origin_not_allowed` (browsers cannot reach the socket; this is defence in
depth from `docs/research/security.md` section 1, "Recommendation", item 2). Error body:
`{"error": {"code": "...", "message": "..."}}`. Module `src/api/errors.ts`:

| Status | Code | Message (example) |
|---|---|---|
| 400 | `bad_request` | "The request body is not valid JSON." |
| 400 | `invalid_target` | "codex personal is not an account name. Use provider:account, for example codex:personal." |
| 403 | `origin_not_allowed` | "relay does not accept requests from web pages." |
| 404 | `not_found` | "There is no /v1/widgets." |
| 404 | `unsupported_version` | "This relay daemon speaks v1." (with `"supported": ["v1"]`) |
| 404 | `job_not_found` | "No job with id ffffffff." |
| 404 | `target_not_found` | "No account named codex:work in config.toml." |
| 405 | `method_not_allowed` | "Use GET for /v1/jobs." (with an `Allow` header) |
| 409 | `operation_in_progress` | "Job 3f9a2c1d is already being checkpointed." |
| 409 | `interactive_start_required` | "This switch needs a terminal. Run relay switch codex:personal in the project." |
| 409 | `confirmation_required` | the switch engine's confirmation text |
| 409 | `git_changes_not_accepted` | the checkpoint engine's message (git configuration or hooks changed) |
| 409 | `project_missing` | "The project for job 3f9a2c1d is not at /path any more." |
| 411 | `length_required` | "Send the body with Content-Length." |
| 413 | `payload_too_large` | "Request bodies are limited to 64 KiB." |
| 422 | `secret_found` | the checkpoint engine's message naming the file and line |
| 422 | `untracked_secret_file` | the checkpoint engine's message |
| 431 | `headers_too_large` | "Request headers are limited to 16 KiB." |
| 500 | `engine_failed` | the engine's message |
| 500 | `internal_error` | "Something went wrong inside relay. Details are in the daemon log." |
| 503 | `shutting_down` | "The relay daemon is stopping." |
| 503 | `too_many_streams` | "The relay daemon already serves 32 event streams." |
| 503 | `hook_queue_full` | "The relay daemon is behind on hook events." (1,000 events wait; `relay hook` spools the event) |

`src/api/engine-errors.ts` maps the engines' typed errors (the same errors phase 2 maps to exit
codes in `src/cli/exit-codes.ts`) to these rows.

### 14. Endpoints and JSON shapes

From `docs/research/architecture.md` section 2 ("Protocol"), with the account and provider
endpoints the brief asks for. Job IDs in paths must match `^[0-9a-f]{8}$` and targets
`^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$`, or the response is `404` / `400`.

| Method and path | Response |
|---|---|
| `GET /v1/version` | `200` `{"api":"v1","daemon_version":"0.5.0","pid":4121,"started_at":"…","schema_version":1,"stream_epoch":"9c41d0e2a7b35f18","capabilities":["accounts","jobs","events.sse","jobs.checkpoint","jobs.switch","hooks"],"agents_running":[]}` |
| `GET /v1/providers` | `200` `{"providers":[{"id":"claude","name":"Claude Code","accounts":[Account…]},{"id":"codex","name":"Codex","accounts":[…]}]}` |
| `GET /v1/accounts` | `200` `{"accounts":[Account…]}` sorted by `target` |
| `GET /v1/accounts/{target}` | `200` `{"account":Account}` or `404 target_not_found` |
| `GET /v1/jobs` | `200` `{"jobs":[Job…]}` newest `updated_at` first |
| `GET /v1/jobs/{job}` | `200` `{"job":Job}` |
| `GET /v1/jobs/{job}/workers` | `200` `{"workers":[Worker…]}` newest first |
| `GET /v1/jobs/{job}/checkpoints` | `200` `{"checkpoints":[Checkpoint…]}` newest first, read with `src/checkpoint/list.ts` |
| `GET /v1/events` | `200` event stream (decision 15) |
| `POST /v1/jobs/{job}/checkpoint` | `201` `{"checkpoint":Checkpoint}` (decision 17) |
| `POST /v1/jobs/{job}/switch` | `200` `{"handoff":{…},"worker":Worker}` (decision 17) |
| `POST /v1/hooks/{provider}/{event}` | `202` `{"accepted":true}`, `400 bad_request` or `503 hook_queue_full` (decision 18) |

Shapes (every field always present; unknown values are `null`):

```json
Account    {"target":"claude:work","provider":"claude","provider_name":"Claude Code","account":"work",
            "configured":true,
            "availability":{"status":"rate_limited","reason":"Claude Code reported a rate limit",
                            "retry_at":null,"measured_at":"2026-10-07T14:02:11.402Z",
                            "source":"hook"},
            "usage":[]}
Usage item {"window":"five_hour","window_minutes":300,"used_percent":9,       (from the `windows` of phase 3)
            "resets_at":"2026-10-07T19:00:00.000Z","measured_at":"2026-10-07T14:30:02.000Z"}
Job        {"id":"3f9a2c1d","title":"Build authentication","state":"running",
            "project_root":"/Users/josue/projects/app","project_missing":false,
            "current_worker":Worker|null,"last_checkpoint":Checkpoint|null,"updated_at":"…"}
Worker     {"id":"…","job_id":"3f9a2c1d","target":"codex:personal","mode":"interactive",
            "state":"running","pid":5120,"provider_session_id":null,"from_handoff":true,
            "started_at":"…","ended_at":null,"exit_code":null,"end_reason":null}
Checkpoint {"number":7,"commit":"912ec1…(40 hex)","ref":"refs/relay/jobs/3f9a2c1d/checkpoints/7",
            "kind":"handoff","created_at":"…","message":"…"}
```

`Worker.state` is computed when read: `ended` when `ended_at` is set; otherwise `running` when
`process.kill(pid, 0)` succeeds, `stopped` when it fails with `ESRCH` (the process is gone and no
end was recorded, or the daemon found it gone), and `starting` when `pid` is `null`. `Checkpoint`
fields follow phase 2's `src/checkpoint/list.ts`; `GET /v1/jobs/{job}/checkpoints` also passes
through its `head` and `left_out`.

Every `GET` answer except `/v1/events` carries the header `Relay-Stream-Seq`: the highest
`stream_events.seq` whose change the answer already shows, read in the same SQLite read transaction
as the data. The Mac app needs it to order a snapshot against the events it receives
(`add-mac-menu-bar-app` design decision 17, requirement A). `stream_epoch` in `GET /v1/version` is
a random ID stored in `meta` when the database is created, so it changes whenever the index is
rebuilt; the Mac app needs it to tell a rebuilt stream from a restart that kept its history
(requirement C). A new database numbers `stream_events` from the time it was created, in
microseconds since 1970 (its `sqlite_sequence` row is set when the database is created), so its
numbers are above every number an older database used and a client's saved position from before
a rebuild always gets a `reset`.

### 15. Server-sent events

From `docs/research/architecture.md` section 2 ("Live status uses server-sent events"). Module
`src/api/sse.ts`. `GET /v1/events[?job=<id>][&since=<seq>]`, or the `Last-Event-ID` header
(the query parameter wins when both are present):

```
retry: 1000

id: 4181
event: availability
data: {"target":"claude:work","provider":"claude","provider_name":"Claude Code","account":"work","configured":true,"availability":{…},"usage":[]}

id: 4182
event: checkpoint
data: {"job_id":"3f9a2c1d","checkpoint":{…}}

: ping
```

Event types: `job` (a job was added or its fields changed; data is the Job), `worker` (Worker),
`checkpoint` (`{job_id, checkpoint}`), `availability` (the whole Account, the same object as
`GET /v1/accounts/{target}` returns), `hook` (job ID, provider, event), `reset` (the requested
position is not in the retained rows; data `{"stream_epoch": …}`; the client reloads with the GET
endpoints), `shutdown` (data `{}`). Each change is written to `stream_events` in the same
transaction as the index change, and its `seq` is the SSE `id`. On connect, the server replays rows
with `seq > since`, then sends new rows as they are committed, reading the rows only when the
client has read what it was sent (a client that stops reading holds at most one batch). It sends
`reset` first, and then only the rows that come after it, when `since < oldest seq - 1` or when
`since` is greater than the newest `seq`; the second case is a cursor from a rebuilt database, which the Mac app needs to detect
(`add-mac-menu-bar-app` design decision 17, requirement B). A comment line `: ping` every 15
seconds keeps the connection alive. At most 32 clients; the 33rd gets `503 too_many_streams`.

The `availability` data was described two ways in this design (the Account, and an example with
only `target` and `availability`); it is the whole Account, so a client decodes one shape for the
stream and the GET endpoints. When the daemon's 2-second check finds that a worker's process is
gone and no `worker_ended` was recorded, it sets `found_gone_at` and sends one `worker` event with
state `stopped`; the Mac app needs this to stop polling for such changes (requirement D).

### 16. Versioning

From `docs/research/architecture.md` section 2 ("Versioning"). The major version is in the path.
Any path that starts with `/v<n>/` where `n` is not 1 gets `404 unsupported_version`. Within v1,
fields and endpoints may be added, never removed or renamed; clients must ignore unknown fields
and check `capabilities` rather than `daemon_version`. `docs/api.md` documents every endpoint with
a `curl --unix-socket` example. An OpenAPI description is left for the phase 8 Mac app, which is
its first consumer outside this repository.

### 17. Checkpoint and switch through the engines

Module `src/daemon/operations.ts` holds one promise per job; a second checkpoint or switch while
one is running gets `409 operation_in_progress`. The engines also take phase 2's job lock, so an
operation started by the CLI at the same time surfaces as `operation_in_progress` too. Module
`src/daemon/engines.ts` is the only file that imports the phase 2 and 4 functions, so a renamed
function changes one file.

- `POST /v1/jobs/{job}/checkpoint`, body `{"message": "<at most 500 characters>"}` (optional).
  Calls phase 2's `saveCheckpoint` with the job's project root, kind `manual` and the message.
  Returns `201 {"checkpoint": …}`. The `checkpoint_saved` event appended by the engine reaches the
  stream as a `checkpoint` stream event through decision 12.
- `POST /v1/jobs/{job}/switch`, body `{"target": "codex:personal", "confirm_new_provider": false}`.
  Calls the phase 4 switch function, `performHandoff`, with start mode `headless`, because the daemon has no
  terminal. When the target's adapter can only start interactively, or the job is configured for
  interactive work, the engine refuses before stopping anything and the API answers
  `409 interactive_start_required`. When the provider is not yet allowed for this project and
  `confirm_new_provider` is not `true`, the answer is `409 confirmation_required` with the engine's
  confirmation text (`docs/research/security.md` section 6). A headless worker started this way is
  a child of the daemon; its output goes to `logs/workers/<job>-<worker>.log`
  (`docs/research/architecture.md` section 8), and it appears in `agents_running`.
- `relay switch` and `relay checkpoint` in the terminal keep calling the engines directly in the
  CLI process, because the next agent usually runs in the person's terminal. They call
  `ensureDaemon()` first (switch only) so the new agent's hooks have a receiver.

Decisions added while building task groups 7, 9 and 11:

- **The switch endpoint is `relay switch` without a terminal.** `src/daemon/engines.ts` calls the
  preflight of `add-relay-switch` with start mode `headless` and a person who cannot answer, then
  `performHandoff` through the `JobSupervisor` of `src/run/run.ts`; there is no second switch
  implementation. Where the two changes disagree, the steps follow `add-relay-switch` and the
  answers follow this design:
  - `add-relay-switch` hands a switch to the `relay run` that holds the job's agent (its decision
    15). This design did not cover that case. The daemon does the same as `relay switch`, so the
    next agent then runs under that `relay run`, not as a child of the daemon, and is not in
    `agents_running`. When the daemon's own job supervisor holds the agent, the request reaches it
    the same way.
  - `add-relay-switch` refuses a headless start of a job whose agents run in a terminal with exit
    code 32 and its own sentence. The API answers `409 interactive_start_required` with the
    sentence of the local-api spec instead. The engine's refusals that need a person now throw
    `PersonNeeded` (`src/handoff/ask.ts`), a `CommandError` with the same code and lines, so the
    terminal output is unchanged and the API tells them apart without reading message text.
  - The allow list of `add-relay-switch` is per account, not per provider, so
    `confirm_new_provider` answers its question for any account not on the list, also a second
    account of the same provider. The answer is recorded with `"how": "api"`, a third value next to
    `terminal` and `flag`. The other questions (work code moving to a personal account, changed
    files that instruct agents) have no field in the request and get `409
    interactive_start_required`.
- **Checkpoint answers.** When nothing changed since the latest checkpoint, the answer is `200` with
  that checkpoint instead of `201`. The two `422` codes share the engine's exit code 4 and are told
  apart by the engine's first line.
- **Request bodies.** A field other than `message` (checkpoint) or `target` and
  `confirm_new_provider` (switch) gets `400 bad_request`, so no request can carry a folder or a
  command. The project folder comes from the index and is checked, before an engine runs, to be the
  worktree root of a repository whose `.relay/state.json` names the job (`409 project_missing`
  otherwise). Engine refusals without a row in decision 13 are `500 engine_failed` with the
  engine's message; a usage refusal of the engine, such as an account that already works on the
  job, is `400 bad_request`.
- **Signals in the daemon.** `JobSupervisor` and `performHandoff` replace the process's signal
  handlers while an agent or a switch runs, as a command in a terminal must. In the daemon they get
  `signals: false` and keep the daemon's handlers, so `SIGTERM` and `SIGINT` always start the
  shutdown of decision 7, which waits for the switch. The daemon also ignores `SIGUSR1`, which
  `relay switch` sends to the process that holds a job's agent.
- **Settings.** The daemon reads `config.toml` for each request, and a job supervisor in the daemon
  reads it whenever it needs it, because the allow list and the accounts change while the daemon
  runs. Building this found a bug in `add-relay-switch`: a switch handed to a `relay run` added a
  new account to the allow list twice, once in each process, and the second write failed its own
  check. The allow list edit now looks for the entry again in the file under the config lock.
- **Shutdown order.** Step 1 only stops accepting connections; open connections, including the one
  of a running checkpoint or switch, stay open until steps 3 and 4 are done, and then get up to 10
  seconds to finish.
- **`relay daemon stop --force`** is a new option of `relay daemon`; `restart` passes it on to
  `stop`.
- **Tests.** Under the test preload (`RELAY_TEST=1`), `relay run` and `relay switch` start the
  daemon only when the test sets `RELAY_TEST_START_DAEMON=1`, so the many tests of those commands
  leave no daemon running; the tests of task groups 9 and 11 set it and stop the daemon afterwards.

### 18. `relay hook <provider> <event>`

From `docs/research/architecture.md` section 6 ("install hooks as a command ... works when the
daemon is down (the command appends to a spool file instead)"). Phase 3 builds the command in
`src/hooks/hook-command.ts`, the allow list in `src/hooks/fields.ts` and the spool in
`src/hooks/spool.ts`; this change adds step 5 (delivery to the daemon) to the same files. The CLI
router loads command modules lazily, so `relay hook` never loads SQLite or git code.

1. Start a 500 ms timer that calls `process.exit(0)`.
2. Validate the provider (`claude` or `codex`) and the event name
   (`^[A-Za-z][A-Za-z0-9_]{0,63}$`). Invalid: log to `hook.log`, exit 0.
3. Read standard input until end of file, 1 MiB, or 200 ms, whichever comes first.
4. Parse JSON. Keep only the allow-listed fields (`src/hooks/fields.ts`, shared with phase 3):
   `session_id`, `cwd`, `hook_event_name`, `error`, `notification_type`, `reason`, `source`,
   `model`, `turn_id`. Strings are cut to 1,024 characters. Build phase 3's spool line object:
   `v`, `received_at`, `provider`, `event`, `relay_job`, `relay_target` and `relay_worker` (from
   `RELAY_JOB`, `RELAY_TARGET` and `RELAY_WORKER` when they match their formats, else null),
   `profile` (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, or `default`) and `fields`.
5. `postHook(provider, event, body, { timeoutMs: 150 })` from `src/client/api-client.ts`, which is
   `fetch("http://relay/v1/hooks/<provider>/<event>", { unix: socketPath, method: "POST", body, signal: AbortSignal.timeout(150) })`.
   `src/client/api-client.ts` is the only file that calls `fetch`, always with the `unix` option
   (`add-cli-scaffold`, `build-and-ci` "No network use and no telemetry").
   with that object as the body. On `202`, exit 0.
6. Otherwise append the same object plus `\n` to `spool/hooks.jsonl` with one write (lines are
   below 4 KiB), unless the file is over 10 MB (then log "spool full, event dropped"). Exit 0.

Every error is caught and written to `hook.log` (phase 1 rotation); nothing is ever printed,
and the exit code is always 0, because exit code 2 would block the agent in both tools.

The daemon answers `202` after putting the event on an in-memory queue, so the hook never waits
for a file lock. The queue is processed in order by `src/hooks/mapping.ts`:

1. Find the worker: by `relay_worker`; else the newest worker of `relay_job` on `relay_target`;
   else the worker whose `provider_session_id` equals `session_id`; else none. Find the job: the
   worker's job; else `relay_job`; else the indexed project whose root contains `cwd`. Find the
   account: `relay_target`; else the worker's target; else the account whose profile folder
   equals `profile` (`default` means `~/.claude` or `~/.codex`).
2. On `SessionStart` with a worker whose `provider_session_id` is empty, set it.
3. Availability (only when an account is known, from `relay_target` or the worker):

| Provider | Event | Condition | New availability | Reason |
|---|---|---|---|---|
| claude | `StopFailure` | `error` = `rate_limit` | `rate_limited` | "Claude Code reported a rate limit" |
| claude | `StopFailure` | `billing_error` | `unavailable` | "Claude Code reported a billing problem" |
| claude | `StopFailure` | `authentication_failed` | `unavailable` | "Claude Code is signed out of this account" |
| claude | `StopFailure` | `oauth_org_not_allowed` | `unavailable` | "This organization does not allow this login" |
| claude | `StopFailure` | `account_on_hold` | `unavailable` | "Claude Code reported that the account is on hold" |
| claude, codex | `Stop` | none | `available` | "The last turn finished normally" |

   `source` is `hook` (phase 3's reading source), `measured_at` is `received_at`, `retry_at` is
   `null` (no hook carries a reset time). A Claude `Notification` with `notification_type`
   `quota_auto_resume_fired` sets `available` with reason "Claude Code continued after its reset.",
   as phase 3 does. `overloaded` and `server_error` are outages of the
   service, not of the account, and leave availability unchanged.
4. Append a `hook` event (and an `availability` event with phase 3's fields when it changed) to
   the job's `events.jsonl` through `appendEvent`, and update the account's `availability.json`
   as phase 3 does; without a job, update SQLite, `availability.json` and the stream only.

Spool draining (`src/daemon/spool.ts`): one second after start, rename `spool/hooks.jsonl` to
`spool/hooks.<pid>.draining`, wait 1 second (longer than any hook can live, so a hook that opened
the old file has finished), process each line through the same queue, then delete the file.
Leftover `.draining` files from a crash are processed first.

Decisions added while building task group 8:

- **Draining while the daemon runs.** A hook spools its event whenever the daemon does not answer
  within 150 ms, also while the daemon runs but is slow. So the daemon drains the spool again, with
  the same rename and wait, after every hook event it accepts and every 2 seconds, whenever
  `spool/hooks.jsonl` is not empty. A hook whose `202` arrived too late has also spooled its line,
  so the queue remembers the last 2,000 lines it took and takes a repeated line only once.
- **Checking every line again.** The daemon checks each line from a request or the spool with
  `parseSpoolLine` (`src/hooks/fields.ts`): provider, event name, `relay_job`, `relay_target` and
  `relay_worker` formats, `profile` as `default` or an absolute path, `received_at` at most one
  minute ahead, and the allow list and the 1,024-character cut once more. A request that fails
  gets `400 bad_request`; a spool line that fails is skipped. When 1,000 events are waiting, a
  request gets `503 hook_queue_full`, and the hook spools the event.
- **Accounts found through the profile folder.** Step 3 says availability changes "only when an
  account is known, from `relay_target` or the worker", while task 8.2 tests "an event without
  `relay_target` attributed through `profile`". The daemon reads it as: the account found in step
  1, through `relay_target`, the worker or the profile folder, is the account whose availability
  changes, as phase 3's `relay account status` and `relay status` without the daemon also do. Only
  accounts in `config.toml` count, so an agent cannot add an account by naming one.

#### Hook events for interactive workers

Phase 3's interactive workers (`src/adapters/claude/interactive.ts`, `src/adapters/codex/interactive.ts`)
learn that a turn ended or failed from relay's hooks, by reading the spool every second. Once the
daemon accepts the events, they no longer reach the spool. Each event must still be stored in one
place only, so the workers read the place the event went:

- Without a daemon, the event is a line in the spool, as before.
- With a daemon, the event is the `hook` event the daemon appends to the job's `events.jsonl`
  (step 4). That event keeps what a worker needs to read it as the spool line it was:
  `received_at` and `relay_worker` (the hook's `RELAY_WORKER`), next to `provider`, `event` and the
  allowed fields. It also holds `worker_id`, the worker the daemon attributed the event to.

`src/hooks/feed.ts` gives a worker both: the spool's lines and, read on from where it stopped, the
`hook` events of its job's `events.jsonl` (the worker's `cwd` is the job's worktree root), turned
back into spool lines. Lines are counted by a key made of `received_at`, provider, event,
`relay_worker` and the fields, so a line that the daemon drains from the spool into `events.jsonl`
is handed out once, while two identical events are still handed out twice. A line is never in
both places at once, because a spool being drained is a `.draining` file, which the feed does not
read. The workers keep their own filters (the worker ID or the session ID, and events after the
worker started).

Other designs were rejected: the daemon writing the event back to the spool would make it a second
copy that the next drain records again; the worker following the daemon's event stream would make
it depend on the daemon and need a second path for the spool anyway. Events without a job (an
agent started outside relay) reach no interactive worker, which is right, because relay starts
interactive workers only inside a job.

Installing the hooks is phase 3's `relay hooks install <account>`, which writes one entry per
event into the account's `settings.json` (Claude Code) or `hooks.json` (Codex) with the command
`'<relay path>' hook <provider> <Event>`. This change adds no installation; it extends phase 3's
`docs/hooks.md` with how events reach the daemon, the spool draining, and what each event changes
in availability.

### 19. Availability words and stale reset times

Module `src/state/availability.ts`, shared by the API and `relay status`. When read, an account
whose status is `rate_limited` or `quota_exhausted` and whose `retry_at` is in the past is
reported as `unknown` with reason "The reset time has passed; relay has not checked since." This
is honest: relay knows the limit should be over but has not seen proof.

| Status | Words in `relay status` |
|---|---|
| `available` | `available` |
| `rate_limited` | `limit reached` |
| `quota_exhausted` | `out of quota` |
| `unavailable` | `unavailable` |
| `unknown` | `unknown` |

A running worker on the account replaces the word with `running`; a worker that disappeared
without a recorded end shows `stopped`.

### 20. `relay status` rendering

From the design notes for `relay status` (the lanes drawing, bold for the active row, dim for the
limited one, the closing sentence, "unknown" shown honestly, never a combined total). Modules
`src/status/model.ts` (builds a `StatusView` from `src/state/queries.ts`), `render-text.ts`,
`render-json.ts`, `time-format.ts`; command `src/cli/commands/status.ts`.

Getting the data: find the project root with `src/git/repo.ts` and read `job_id` from
`.relay/state.json` (or take `--job <id>` and look it up in `projects.list`). Call
`registerProject(root)`. Ask the daemon (`GET /v1/jobs/<id>` and `GET /v1/accounts`, 300 ms
timeout each). If the daemon does not answer, or answers `404` for a project it has not indexed
yet, build the in-memory index (decision 11) for this project, merge the newest availability per
account from the spool and from `relay.db` opened with `{ readonly: true }` (a failure to open it
is ignored), and mark the view as saved state.

Text layout (`W` = the longest account ID plus 3, at least 17):

```
Build authentication   job 3f9a2c1d · checkpoint 912ec1 · 2 min ago

claude:work      ────────────┐      limit reached · reset unknown
                             │
codex:personal   ━━━━━━━━━━━━┷━━━   running · usage unknown
claude:home      ────────────────   available · 9% used (5-hour window, checked 14:30)

Continuing on Codex.
```

- Rows: the previous worker's account (the account of the newest ended worker, if it differs from
  the current one; when the newest ended worker ran on the current account, there is no previous
  row), then the current worker's account, then every other configured account in
  alphabetical order. Without a current worker, all accounts are in alphabetical order with no
  previous row.
- Lanes are 16 characters: previous `─` x12 + `┐` + 3 spaces; the line after it is `W + 12`
  spaces + `│`; current with a previous row `━` x12 + `┷` + `━` x3; current without one `━` x16;
  others `─` x16. Three spaces separate the lane from the words, so the words line up on every row.
- Words (decision 19), then, for `limit reached` and `out of quota`, `· resets <time>` or
  `· reset unknown`; for `unknown`, `· not measured` when there was never a measurement and
  `· reset time passed` for a stale reset; otherwise usage: for each measured window, narrowest
  first, `· <n>% used (<window>, checked <time>)`, or `· usage unknown` when none. Window names:
  `five_hour` "5-hour window", `seven_day` "7-day window", other windows "<hours>-hour window" from
  `window_minutes`, else "usage window".
- Closing sentence: `Continuing on <provider name>.` when the current worker has `from_handoff`;
  `<provider name> is working on this job.` otherwise; `No agent is working on this job.` without
  a running worker. Provider names: `claude` "Claude Code", `codex` "Codex".
- Saved state: after the closing sentence, a blank line and `Showing saved state. The relay daemon
  is not running.`, or, when the daemon answered but has not indexed the project yet,
  `Showing saved state. The relay daemon has not read this project yet.`
- Styling (`\x1b[1m` bold for the current row, `\x1b[2m` dim for rows whose status is
  `rate_limited`, `quota_exhausted` or `unavailable`, `\x1b[0m` to reset) only when standard output
  is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`.
- Times (`time-format.ts`, with an injectable clock): within the same local day `HH:MM`
  (24-hour); within the next or last 6 days `Thu 09:00`; otherwise `Oct 12 09:00`. Ages: `just now`
  under a minute, `<n> min ago` under an hour, `<n> h ago` under a day, then the date. The job title
  is cut to 48 characters with `…`.

`relay status --json` prints exactly one object:

```json
{
  "schema": "relay.status/v1",
  "daemon": "running",
  "saved_state": false,
  "generated_at": "2026-10-07T14:32:00.000Z",
  "job": { "id": "3f9a2c1d", "title": "Build authentication", "state": "running",
           "project_root": "/Users/josue/projects/app",
           "current_worker": { "id": "…", "target": "codex:personal", "state": "running", "from_handoff": true, "started_at": "…" } },
  "checkpoint": { "number": 7, "commit": "912ec1…", "ref": "refs/relay/jobs/3f9a2c1d/checkpoints/7", "kind": "handoff", "created_at": "…", "message": "…" },
  "accounts": [
    { "target": "claude:work", "provider": "claude", "provider_name": "Claude Code", "account": "work",
      "role": "previous", "activity": "idle",
      "availability": { "status": "rate_limited", "reason": "Claude Code reported a rate limit", "retry_at": null, "measured_at": "…", "source": "hook" },
      "usage": [] }
  ]
}
```

`saved_state` is `true` when the view was built from the files (the daemon did not answer, or has
not indexed the project yet). `role` is `previous`, `current` or `other`; `activity` is `running`, `stopped` or `idle`. Exit
codes: 0 when the status was shown (daemon running or not); 3 outside a project without `--job`, or
for an unknown `--job` (phase 2's code for "not possible here"); 2 for a usage error (phase 1's
code for bad arguments).

### 21. Module layout

```
src/platform/libc.ts                 dlopen of the C library (only importer of bun:ffi)
src/platform/peer-credentials.ts     peerUid(fd)
src/platform/file-lock.ts            tryLock, lock, release
src/daemon/paths.ts                  runtime directory, socket path, checks (decision 2)
src/daemon/singleton.ts              daemon.lock, daemon.pid (decision 5)
src/daemon/main.ts                   relay daemon run: start-up and shutdown (decisions 5, 7)
src/daemon/log.ts                    JSON-lines log with rotation (decision 8)
src/daemon/follow.ts                 following events.jsonl and projects.list (decision 12)
src/daemon/spool.ts                  draining the hook spool (decision 18)
src/daemon/operations.ts             one operation per job (decision 17)
src/daemon/engines.ts                calls into phases 2 and 4 (decision 17)
src/daemon/workers.ts                headless workers the daemon started
src/api/server.ts                    Bun.listen and the peer check (decision 3)
src/api/http1.ts                     request parser and response writer (decision 3)
src/api/router.ts                    Request -> Response routing, version prefix (decision 16)
src/api/routes/{version,providers,accounts,jobs,events,actions,hooks}.ts
src/api/errors.ts, src/api/engine-errors.ts   (decision 13)
src/api/sse.ts                       event stream (decision 15)
src/state/schema.sql, src/state/db.ts         (decision 10)
src/state/index-builder.ts, src/state/apply-event.ts, src/state/queries.ts   (decision 11)
src/state/projects-list.ts           (decision 12)
src/state/availability.ts            (decision 19)
src/hooks/hook-command.ts, fields.ts, spool.ts   phase 3 files; this change adds delivery (decision 18)
src/hooks/mapping.ts                 worker, job and account lookup, availability table (decision 18)
src/client/api-client.ts             fetch over the socket with timeouts
src/client/ensure-daemon.ts          (decision 6)
src/status/model.ts, render-text.ts, render-json.ts, time-format.ts   (decision 20)
src/cli/commands/daemon.ts, status.ts, doctor.ts   (hook.ts is phase 3's)
src/job/events.ts                    phase 2 module; appendEvent's events lock becomes flock (decision 9)
docs/daemon.md, docs/api.md; docs/hooks.md (phase 3) gains a section
test/helpers/relay-home.ts           temporary RELAY_HOME, starts and stops a test daemon
test/helpers/fake-hook-input.ts      Claude and Codex hook payloads from the documented fields
test/platform/*.test.ts, test/daemon/*.test.ts, test/api/*.test.ts, test/state/*.test.ts,
test/hooks/*.test.ts, test/status/*.test.ts, test/status/golden/*.txt, test/e2e/daemon-status.test.ts
```

### 22. Tests

Tests use `bun test`, never call a real provider, and use the phase 2 helper
`test/helpers/scratch-repo.ts` for repositories and the phase 3 fake agents for workers. The test
`RELAY_HOME` is a fresh folder from `fs.mkdtemp(os.tmpdir() + "/relay-test-")`, which keeps the
socket path under 103 bytes on macOS. Time-dependent tests use the injectable clock and `TZ=UTC`.
Following AGENTS.md, tests run on the Omarchy machine (Linux); the tests marked "macOS" also run
on the Mac, because `getpeereid` exists only there. Each test's purpose is listed in tasks.md.

## Risks / Trade-offs

- [`bun:ffi` is marked experimental by Bun, and it must keep working in compiled binaries.] →
  It is confined to `src/platform/libc.ts`; task 1.3 runs the peer check from the compiled binary
  on both systems. If it breaks, the fallback is a 30-line C helper compiled per platform, or Node,
  where `socket._handle.fd` is available.
- [The HTTP layer is hand-written, and HTTP parsers are a classic source of bugs.] → It accepts a
  deliberately small subset (no keep-alive, no chunked requests, fixed limits), only from the same
  user, and the parser has its own tests for every limit.
- [A hook event accepted with `202` is lost if the daemon crashes before processing it.] → The
  window is milliseconds; availability is a hint that the next hook corrects.
- [Process ID reuse could make a long-dead worker look `running`.] → Rare within one session;
  leases in phase 9 replace this check.
- [Claude reset times stay unknown in this phase.] → Shown as "reset unknown"; phase 7 adds the
  status-line source.
- [Socket only means the Mac app cannot use `URLSession`.] → Pending Josué's decision (proposal);
  the Network framework can talk to the socket.
- [Two processes write `events.jsonl` (the CLI and the daemon).] → The events lock and one
  `appendEvent` function; a test fails if any other file writes the log.
- [Any program running as the person can use the socket.] → Stated in `docs/daemon.md`, as
  `docs/research/security.md` section 1 asks.

## Migration Plan

New feature; nothing to migrate. The database is a cache, so changing its schema later only needs
a new `user_version` (the daemon then rebuilds). To remove the feature from a machine: `relay
daemon stop`, then delete `~/.relay/run`, `~/.relay/relay.db*`, `~/.relay/spool` and the hook
entries added to provider settings.

## Open Questions

- Whether Codex accepts a hooks entry without a `matcher` for `SessionStart`. It changes only the
  snippet in `docs/hooks.md`.
- Whether `async: true` applies to every Claude Code hook event. Without it, the hook still
  returns within 500 ms, so the behaviour does not depend on the answer.
