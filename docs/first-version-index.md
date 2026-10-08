# First version index

Last updated 2026-10-08.

The first version of relay is described by six change proposals in `openspec/changes/`. Different
people wrote them at the same time, so on 2026-10-07 they were checked against each other and
made to use the same names. This page lists those shared names in one place: every command, every
exit code, every event type, every job file, every folder of source code, and the order in which
the changes are built. When this page and a proposal disagree, the proposal is the source of
truth, and this page should be fixed.

## Words used on this page

Each term is explained once here and used with the same meaning below.

| Term | Meaning |
|---|---|
| Change | One OpenSpec proposal in `openspec/changes/<name>/`, with a `proposal.md`, a `design.md`, a `tasks.md` and one spec file per capability. Each change is one phase of `docs/ROADMAP.md`. |
| Capability | One area of behaviour that a change specifies, such as `checkpoints` or `agent-runs`. Each capability has its own spec file. No two changes define the same capability. |
| Job | One piece of coding work that relay follows, in one git checkout. A job has an ID of 8 lowercase hexadecimal characters, for example `3f9a2c1d`. |
| Worktree root | The top folder of the git checkout that holds the job. relay always runs agents and git there. |
| Job files | The files in the `.relay/` folder at the worktree root. They describe the job and are listed in `.git/info/exclude`, so they never enter the person's own commits. |
| Checkpoint | A git commit that saves the whole working tree and the job files, stored under `refs/relay/jobs/<job>/checkpoints/<n>`. A ref is git's name for a pointer to a commit; refs under `refs/relay/` are not branches, so the person's branch never moves. |
| Provider | The company and program behind an agent: `claude` (Claude Code by Anthropic) or `codex` (Codex by OpenAI). |
| Account | One sign-in of one provider, written `provider:name`, for example `claude:work`. Each account has its own profile folder. Event fields and the local API call an account a `target` (short for execution target, the term `VISION.md` uses); the value is the same. |
| Adapter | The part of relay that knows how one provider's program works: how to start it, read its output, interrupt it, stop it and resume it. |
| Worker | One run of one agent program on one account. A worker has an ID of 8 lowercase hexadecimal characters, for example `5d2e8f01`. |
| Event | One line of `.relay/events.jsonl` that records a fact, for example "this command ran". |
| Handoff | Moving a job from one worker to the next: stop the first agent, save a checkpoint, write the handoff notes, and start the next agent with a prompt that tells it to continue. `relay switch` performs it. |
| Hook | A command that Claude Code or Codex runs by itself when something happens, such as a turn ending at a limit. relay installs `relay hook` as such a command. |
| Spool | The file `RELAY_HOME/spool/hooks.jsonl`, where `relay hook` writes hook events when no daemon receives them. |
| Daemon | relay's background process. It keeps a fast index of jobs and accounts in SQLite and answers on a private Unix socket (a file-based connection that only programs on the same computer can open). |
| Exit code | The number a command returns when it ends. 0 means success; other numbers say what went wrong. |
| `RELAY_HOME` | relay's own folder, `~/.relay` by default. It holds `config.toml`, logs, locks and other private files, outside every project. |

## Build order

The changes are built in this order. Each change needs the ones before it.

| Phase | Change | What it adds | Needs |
|---|---|---|---|
| 1 | `add-cli-scaffold` | The Bun project, the `relay` binary with all sixteen commands (help only), `RELAY_HOME`, `config.toml`, logs, tests and CI | Nothing |
| 2 | `add-checkpoint-engine` | `relay init`, checkpoints, rollback, the safe git runner, the secret scan, the job files and the event writer | Phase 1 |
| 3 | `add-provider-adapters` | Claude Code and Codex adapters, fake agents, accounts, policies, hook installation, the spool form of `relay hook`, and `relay run` | Phases 1 and 2 |
| 4 | `add-relay-switch` | `relay switch` (the handoff) and the handoff parts of `relay run` | Phases 1 to 3 |
| 5 | `add-daemon-api-and-status` | The daemon, the local API, SQLite, `relay status`, delivery of hook events to the daemon, and `relay doctor --reindex` | Phases 1 to 4 (its switch endpoint calls the phase 4 engine) |
| 6 | `add-handoff-evaluation` | The opt-in evaluation harness in `eval/handoff/`, run with `bun run eval:handoff` | Phases 1 to 5 for real runs; its task groups 2 to 7 use a stub `relay` and can be built while phases 3 to 5 are built |
| 7 (first part) | `add-t3-limit-rules` | Usage readings, limit rules per account and window, and moving T3 Code threads to another provider past a threshold; `relay t3` | Phases 1, 3, 4 and 5; its settings, rules engine and T3 client need only phase 1 |

Some later changes modify code that an earlier change created. Each of these is declared in the
later change:

- Phase 3 builds `relay run` and `relay hook`. Phase 4 adds the start and continuation prompts, the
  first-handoff question (which replaces phase 3's refusal of an account that is not allowed), switch
  requests and the checkpoint when the agent exits. Phase 5 adds delivery of hook events to the
  daemon.
- Phase 2 builds `appendEvent` with a lock file. Phase 5 replaces the lock mechanism with `flock`,
  which the operating system releases when a process dies, without changing the function.
- Phase 5 makes `relay init`, and every command that finds a job, add the project's root to
  `RELAY_HOME/projects.list`.

The consistency check found two places where changes overlapped. Josué approved how each is
resolved, and the proposals now say so:

- **The worker lock file.** Phase 3 creates `RELAY_HOME/locks/<job>.worker.lock` while `relay run`
  supervises an agent, with the fields `pid`, `account` and `started_at`, and says that later phases
  may add fields that readers ignore. Phase 4 adds `schema_version`, `process_started_at`,
  `worker_id`, `mode` and `relay_version` to the same file, so that `relay switch` can find and
  signal that `relay run`. Phase 4 keeps no separate record file (`add-relay-switch` design
  decision 15).
- **Bun APIs outside `src/platform/`.** Phase 1 keeps every Bun-specific call in `src/platform/`, and
  its grep check for this applies to phase 1 only. Phases 2 to 5 may call Bun APIs such as
  `Bun.spawn`, `Bun.which`, `Bun.listen` and `bun:sqlite` directly in other folders where their
  designs say so. Calls into the C library through `bun:ffi` stay in `src/platform/libc.ts`.

## Commands

Phase 1 adds every command to the router with its help text. Running a command that is not built
yet prints that it is not built yet and exits with code 69. The change named in "Built by" gives the
command its real behaviour and its final options.

| Command | Arguments | What it does | Built by | Extended by |
|---|---|---|---|---|
| `relay init [--title <text>]` | 0 | Sets up `.relay/` in the current git checkout and saves the first checkpoint | `add-checkpoint-engine` | `add-daemon-api-and-status` (registers the project) |
| `relay run [<provider[:account]>]` | 0 to 1 | Starts an agent inside the job, in the terminal or headless | `add-provider-adapters` | `add-relay-switch` (prompts, handoff, switch requests, `--check`, `--yes`, `--no-summary`) |
| `relay checkpoint [-m <text>] [--include <path>]... [--json]` | 0 | Saves a checkpoint | `add-checkpoint-engine` | |
| `relay checkpoints [--json]` | 0 | Lists the job's checkpoints, newest first | `add-checkpoint-engine` | |
| `relay rollback [<checkpoint>] [--yes] [--dry-run]` | 0 to 1 | Restores the files of an earlier checkpoint after saving the current state | `add-checkpoint-engine` | |
| `relay accept-git-changes` | 0 | Lets the person, at a terminal, trust a change to git settings or hooks | `add-checkpoint-engine` | |
| `relay switch <provider[:account]>` | 1 | Hands the job to another agent or account | `add-relay-switch` | |
| `relay status [--job <id>] [--json]` | 0 | Shows the job, its latest checkpoint and one row per account | `add-daemon-api-and-status` | |
| `relay account <list\|add\|status\|login\|remove> [...]` | 1 to 3 | Manages accounts; `add` takes `<provider> <name>`, `status`, `login` and `remove` take `<provider:name>` | `add-provider-adapters` | |
| `relay providers [--json]` | 0 | Shows which agent programs are installed and what each adapter can do | `add-provider-adapters` | |
| `relay policy show <provider>` | 2 | Shows relay's notes on a provider's terms | `add-provider-adapters` | |
| `relay hooks <install\|remove\|status> <provider:name>` | 2 | Installs, removes or checks relay's hooks in an account's settings | `add-provider-adapters` | |
| `relay hook <provider> <event>` | 2 | Called by the agents' hooks; records the event and always exits 0 without output | `add-provider-adapters` (spool) | `add-daemon-api-and-status` (delivery to the daemon) |
| `relay statusline <provider>` | 1 | Called by Claude Code's status line; records usage and runs the person's own status line | `add-provider-adapters` | |
| `relay daemon <start\|stop\|restart\|status\|run>` | 1 | Controls the background service | `add-daemon-api-and-status` | |
| `relay doctor --reindex` | 0 | Rebuilds the daemon's index from the job files and git | `add-daemon-api-and-status` | |
| `relay t3 <connect\|enable\|disable\|status\|disconnect> [<folder>]` | 1 to 2 | Connects relay to T3 Code and chooses the projects whose threads relay manages; `enable` and `disable` take a folder | `add-t3-limit-rules` | |

Every command also accepts `-h`, `--help` and `--log-level <level>`. `relay --help` and
`relay --version` work without a command.

## Exit codes

All relay commands share one table in `src/cli/exit-codes.ts`. No two changes use the same
number for different meanings. A command returns only the codes that apply to it.

| Code | Meaning | Defined by |
|---|---|---|
| 0 | The command did what was asked, including "nothing changed" | `add-cli-scaffold` |
| 1 | The command ran and could not finish (for example a git error, or a secret scan that did not finish) | `add-cli-scaffold` |
| 2 | The command line is wrong (unknown option, wrong number of arguments, unknown checkpoint or account name) | `add-cli-scaffold` |
| 3 | Not possible here: not a git repository, a bare repository, relay not set up, already set up, a damaged `state.json`, git older than 2.34, gitleaks missing, `relay status` outside a project, or `relay switch` before any agent worked on the job | `add-checkpoint-engine` |
| 4 | Stopped by the secret scan, or by an untracked file whose name suggests a secret | `add-checkpoint-engine` |
| 5 | The git configuration or hooks changed since `relay init` | `add-checkpoint-engine` |
| 6 | Another relay command is working on the job (the job lock, the worker lock, or a switch in progress) | `add-checkpoint-engine` |
| 7 | relay needs the person: a question without a terminal and without `--yes`, a "no", or a command that must be run by the person at a terminal | `add-checkpoint-engine` |
| 8 | A rollback would overwrite or delete files relay has not saved | `add-checkpoint-engine` |
| 10 | The relay daemon is not running or could not start | `add-daemon-api-and-status` |
| 20 | The provider's program is missing or older than the oldest tested version | `add-provider-adapters` |
| 21 | The account is not configured | `add-provider-adapters` |
| 22 | The account is not signed in, or its API key variable is not set | `add-provider-adapters` |
| 23 | The agent stopped at a usage or rate limit | `add-provider-adapters` |
| 24 | The agent failed, crashed or asked for a permission | `add-provider-adapters` |
| 25 | Refused by a relay rule: full access, an account the allow list excludes (phase 3 only), or resuming a session on another account | `add-provider-adapters` |
| 31 | The next agent did not start; the handoff is ready to retry | `add-relay-switch` |
| 32 | The switch would give the next agent less supervision or more permission than the job had | `add-relay-switch` |
| 33 | The current agent could not be stopped, or the `relay run` that holds it did not answer | `add-relay-switch` |
| 40 | T3 Code is not answering at its address | `add-t3-limit-rules` |
| 41 | This T3 Code build cannot be driven by other programs (a nightly build is needed) | `add-t3-limit-rules` |
| 42 | relay is not connected to T3 Code, or the connection expired | `add-t3-limit-rules` |
| 69 | The command exists but this version cannot do it yet | `add-cli-scaffold` |
| 70 | A bug inside relay | `add-cli-scaffold` |
| 78 | The relay folder, `config.toml`, a relay environment variable or a profile folder is wrong or unsafe | `add-cli-scaffold` |
| 130 | Stopped by Control-C (`SIGINT`) | `add-cli-scaffold` |
| 143 | Stopped by `SIGTERM` | `add-cli-scaffold` |

The numbers 9, 11 to 19, 26 to 30, 34 to 39 and 43 to 63 are free. The evaluation harness
(`bun run eval:handoff`) is a separate program, not a relay command, and has its own codes 0 to 5
and 130, described in `add-handoff-evaluation` design decision 12.

## Event types

Every event is one line of `.relay/events.jsonl` with the same envelope: `v` (1), `id` (an integer
that grows by 1), `ts` (the time), `job`, `type`, `actor` (`relay`) and `data`. Every relay process
appends events through one function, `appendEvent`, which holds a short lock so two processes
never write at the same time. Events never hold message text, command output, environment values
or secrets.

| Type | Written by | `data` fields |
|---|---|---|
| `job_started` | `add-checkpoint-engine` (`relay init`) | `title`, `worktree_root`, `head`, `branch`, `detached`, `linked_worktree` |
| `checkpoint_saved` | `add-checkpoint-engine` (`saveCheckpoint`, for every kind) | `number`, `commit`, `kind` (`baseline`, `manual`, `pre_rollback`, `handoff` or `auto`), `message`, `parent`, `head`, `branch`, `files_changed`, `left_out` |
| `checkpoint_refused` | `add-checkpoint-engine` | `command`, `reason` (`secret_found`, `secret_like_file` or `git_changed`), and `findings`, `files` or `changed` depending on the reason |
| `rollback` | `add-checkpoint-engine` | `to_checkpoint`, `to_commit`, `undo_checkpoint`, `files_written`, `files_deleted` |
| `git_changes_accepted` | `add-checkpoint-engine` | `changed`, and `trust_record` (`missing` or `damaged`) when a record relay could not read was rewritten |
| `worker_started` | `add-provider-adapters`; `add-relay-switch` sets `from_handoff` | `worker_id`, `target`, `provider`, `mode`, `transport`, `provider_version`, `permission`, `pid`, `provider_session_id`, `argv` (with the instructions and prompt replaced by placeholders), `resumed_from`, `from_handoff`, `start_checkpoint` |
| `worker_session_identified` | `add-provider-adapters` | `worker_id`, `provider_session_id`, `model`, `source` |
| `command_ran` | `add-provider-adapters` | `worker_id`, `command` (redacted), `exit_code`, `status` |
| `file_changed` | `add-provider-adapters` | `worker_id`, `paths` |
| `turn_completed` | `add-provider-adapters` | `worker_id`, `duration_ms`, `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`), `cost_usd_estimate` |
| `turn_failed` | `add-provider-adapters` | `worker_id`, `reason`, `retry_at`, `source` |
| `availability` | `add-provider-adapters` and `add-daemon-api-and-status` | `worker_id`, `target`, `status`, `reason`, `retry_at`, `measured_at`, `source`, `windows` (`name`, `window_minutes`, `used_percent`, `resets_at`) |
| `approval_requested` | `add-provider-adapters` | `worker_id`, `summary` |
| `permission_denied` | `add-provider-adapters` | `worker_id`, `tool` |
| `worker_ended` | `add-provider-adapters`; also `add-relay-switch` and `add-daemon-api-and-status` | `worker_id`, `exit_code`, `signal`, `end_reason` (`exited`, `interrupted`, `stopped_by_switch`, `relay_stopped` or `start_failed`), `stop_how`, `seconds` |
| `handoff_notes` | `add-relay-switch` | `handoff`, `from_worker_id`, `outcome`, `reason`, `seconds`, `characters`, `invisible_removed` |
| `check_run` | `add-relay-switch` | `handoff`, `command`, `outcome`, `exit_code`, `signal`, `seconds`, `passed`, `failed`, `skipped`, `log` |
| `verification_recorded` | `add-relay-switch` | `handoff`, `worker_id`, `rows`, `yes`, `no`, `unclear` |
| `provider_allowed` | `add-relay-switch` | `account`, `company`, `how` |
| `handoff` | `add-relay-switch` | `number`, `from_worker_id`, `from_target`, `to_target`, `to_worker_id`, `checkpoint_number`, `checkpoint_commit`, `handoff_ref`, `notes_source`, `notes_reason`, `tiers`, `claims_count`, `mismatches`, `checks`, `instruction_files_changed`, `confirmations`, `invisible_removed`, `prompt_path` |
| `handoff_failed` | `add-relay-switch` | `number`, `to_target`, `step`, `reason`, `exit_code`, `kept_checkpoint` |
| `hook` | `add-daemon-api-and-status` | `provider`, `event`, and the allow-listed hook fields |

`add-t3-limit-rules` writes its events to `RELAY_HOME/t3/events.jsonl`, not to a job's
`.relay/events.jsonl`, because T3 threads are not relay jobs. They use the same envelope with
`job` set to `null`: `usage_reading`, `limit_crossed`, `t3_thread_switched`,
`t3_thread_continued`, `t3_action_failed` and `t3_disconnected` (fields in that change's specs).

The availability `status` is one of `available`, `rate_limited`, `quota_exhausted`, `unavailable`
and `unknown`. Its `source` says where the reading came from: `provider_api`, `stream_event`,
`hook`, `status_line`, `message_text`, `usage_command` (`add-t3-limit-rules`), `user` or `none`. Window names are `five_hour`, `seven_day`,
or `<n>_minutes` for other lengths.

## Job files

These files live in `.relay/` at the worktree root. Checkpoints store exactly these files and no
other file that may appear in `.relay/`.

| File | Who writes it | Format defined in | Stored in checkpoints |
|---|---|---|---|
| `task.md` | `relay init` writes a template; the person and agents keep it current | `add-checkpoint-engine`, `job-files` "task.md template" | Yes |
| `state.json` | relay only (the checkpoint engine; `add-relay-switch` adds `current_worker` and `last_handoff`) | `add-checkpoint-engine`, `job-files` "state.json schema"; readers ignore fields they do not know | Yes |
| `checkpoint.md` | `relay init` writes a placeholder; `relay switch` replaces it at every handoff | `add-checkpoint-engine` (placeholder), `add-relay-switch` design decision 11 (handoff template) | Yes |
| `decisions.md` | `relay init` writes a template; the person and agents add entries | `add-checkpoint-engine`, `job-files` | Yes |
| `events.jsonl` | relay only, through `appendEvent` | `add-checkpoint-engine`, `job-files` "events.jsonl format" | Yes |
| `verify.md` | The next agent after a handoff, as a table with the columns Claim, Holds and Evidence; relay removes it from the folder at the next switch | `add-relay-switch` design decision 13 | Yes, when it exists |

## Environment variables shared between changes

| Variable | Set by | Read by |
|---|---|---|
| `RELAY_HOME` | the person (optional; default `~/.relay`); the adapters pass it to every agent | every change |
| `RELAY_LOG_LEVEL` | the person | `add-cli-scaffold`, `add-daemon-api-and-status` |
| `RELAY_JOB`, `RELAY_TARGET`, `RELAY_WORKER` | `add-provider-adapters`, in every agent's environment | `relay hook` (`add-provider-adapters`, `add-daemon-api-and-status`), `relay statusline` |
| `RELAY_BIN` | development and tests | `add-provider-adapters` (hook installation), `add-handoff-evaluation` |
| `RELAY_CLAUDE_BIN`, `RELAY_CODEX_BIN`, `RELAY_FAKE_SCENARIO`, `RELAY_FAKE_RECORD` | tests | `add-provider-adapters` and every later change's tests |
| `RELAY_GITLEAKS` | tests | `add-checkpoint-engine` and later changes' tests |
| `RELAY_TEST` | the test preload of `add-cli-scaffold` | `add-relay-switch` (crash tests) |

## Source code map

All relay source lives under `src/`. The evaluation harness lives under `eval/handoff/` and is
never compiled into the `relay` binary.

| Folder or file | Owner | Purpose |
|---|---|---|
| `src/cli/main.ts`, `run.ts`, `router.ts`, `help.ts`, `io.ts`, `errors.ts` | `add-cli-scaffold` | The entry point, the command router and help |
| `src/cli/exit-codes.ts` | `add-cli-scaffold`; each later change adds its codes | The one exit-code table |
| `src/cli/output.ts` | `add-checkpoint-engine` | Relative times, short hashes and prompts |
| `src/cli/commands/<name>.ts` | the change that builds the command (see "Commands") | One handler per command; `registry.ts` lists them |
| `src/core/version.ts`, `paths.ts`, `relay-home.ts`, `log.ts` | `add-cli-scaffold` | The version, `RELAY_HOME`, its safety checks, and JSON-lines logs |
| `src/core/config/types.ts`, `load.ts`, `validate.ts`, `log-level.ts` | `add-cli-scaffold` | Reading and checking `config.toml`; the `Account` type |
| `src/core/config/edit.ts` | `add-provider-adapters` | The one writer of `config.toml` (accounts and allow lists only, never credentials) |
| `src/platform/toml.ts` | `add-cli-scaffold` | `parseToml`, the first Bun-only call |
| `src/platform/clock.ts` | `add-provider-adapters` | `now()` and, for tests, `setClock()` |
| `src/platform/libc.ts`, `peer-credentials.ts`, `file-lock.ts` | `add-daemon-api-and-status` | C library calls: the socket's peer user check and `flock` |
| `src/git/run.ts`, `repo.ts`, `trust.ts` | `add-checkpoint-engine` | The only place that starts git, repository discovery, and the git trust record |
| `src/checkpoint/snapshot.ts`, `save.ts`, `commit.ts`, `list.ts`, `rollback.ts` | `add-checkpoint-engine` | Building, saving, listing and restoring checkpoints |
| `src/secrets/scan.ts`, `names.ts` | `add-checkpoint-engine` | The gitleaks scans and secret-like file names |
| `src/secrets/redact.ts` | `add-provider-adapters`; `add-relay-switch` adds `redactEnvValues` | Removing secret-looking values from event text and check output |
| `src/text/invisible.ts` | `add-checkpoint-engine` | The one list of invisible characters |
| `src/job/files.ts`, `state.ts`, `events.ts`, `id.ts`, `lock.ts` | `add-checkpoint-engine`; `add-daemon-api-and-status` changes the events lock to `flock` | Job files, `state.json`, the event writer, job IDs and the job lock |
| `src/adapters/providers.ts` | `add-cli-scaffold` | The list of providers and the `Provider` type |
| `src/adapters/` (the rest, with `claude/` and `codex/`) | `add-provider-adapters` | The adapter interface, process supervision and the two adapters |
| `src/accounts/` | `add-provider-adapters` | Account registry, profile folders, environment, login, availability records |
| `src/policies/` | `add-provider-adapters` | Policy files and the same-provider switching rule |
| `src/hooks/install.ts`, `hook-command.ts`, `fields.ts`, `spool.ts`, `statusline.ts` | `add-provider-adapters`; `add-daemon-api-and-status` adds delivery to `hook-command.ts` | Installing hooks, the `relay hook` command, the allow list, the spool and the status line |
| `src/hooks/mapping.ts` | `add-daemon-api-and-status` | Turning hook events into worker and availability changes |
| `src/run/run.ts`, `job-context.ts`, `instructions.ts`, `worker-record.ts`, `progress.ts` | `add-provider-adapters` | `relay run` and relay's fixed instructions text |
| `src/run/control.ts` | `add-relay-switch` | Switch requests sent to a running `relay run` |
| `src/handoff/` | `add-relay-switch` | The switch engine, notes, checks, claims, templates, allow list and safety checks |
| `src/daemon/`, `src/api/`, `src/state/`, `src/status/`, `src/client/` | `add-daemon-api-and-status` | The daemon, the local API, the SQLite index, `relay status`, and the only code that opens a connection (to relay's own socket) |
| `src/limits/`, `src/usage/`, `src/t3/` | `add-t3-limit-rules` | Limit rules and crossings, usage readings, and the T3 Code client (the only code that connects to T3, on `127.0.0.1`) |

## Functions used across changes

These functions are defined in one change and called by others. Their names are the same in
every change.

| Function | Module | Defined by | Called by |
|---|---|---|---|
| `loadConfig`, `validateConfig` | `src/core/config/` | `add-cli-scaffold` | every later change; `edit.ts` checks its result with `validateConfig` |
| `openLog` | `src/core/log.ts` | `add-cli-scaffold` | `add-daemon-api-and-status` (`src/daemon/log.ts`) |
| `git` (the safe runner) | `src/git/run.ts` | `add-checkpoint-engine` | phases 3 to 5 whenever they run git (the evaluation harness has its own runner with the same overrides) |
| `openRepository`, `compareTrust` | `src/git/repo.ts`, `src/git/trust.ts` | `add-checkpoint-engine` | `add-provider-adapters`, `add-relay-switch`, `add-daemon-api-and-status` |
| `buildSnapshotTree` | `src/checkpoint/snapshot.ts` | `add-checkpoint-engine` | `add-relay-switch` |
| `saveCheckpoint` | `src/checkpoint/save.ts` | `add-checkpoint-engine` | `add-relay-switch` (kinds `handoff` and `auto`, with `lockHeld`), `add-daemon-api-and-status` |
| `scanCheckpoint`, `scanTexts` | `src/secrets/scan.ts` | `add-checkpoint-engine` | `add-relay-switch` (`scanTexts`) |
| `removeInvisible` | `src/text/invisible.ts` | `add-checkpoint-engine` | `add-provider-adapters`, `add-relay-switch` |
| `appendEvent`, `readEvents` | `src/job/events.ts` | `add-checkpoint-engine` | every later change |
| `captureState` (tests) | `test/helpers/invariants.ts` | `add-checkpoint-engine` | the end-to-end tests of phases 3 to 5 |
| `adapter.start`, `worker.stop`, `worker.interrupt` | `src/adapters/types.ts` | `add-provider-adapters` | `add-relay-switch`, `add-daemon-api-and-status` |
| `mayAutoSwitch` | `src/policies/switching.ts` | `add-provider-adapters` | phase 7 (failover, not part of the first version) |
| `performHandoff` | `src/handoff/switch.ts` | `add-relay-switch` | `relay switch`, `relay run`, `add-daemon-api-and-status` (`POST /v1/jobs/{job}/switch`) |
| `ensureDaemon` | `src/client/ensure-daemon.ts` | `add-daemon-api-and-status` | `relay run`, `relay switch` |
| `registerProject` | `src/state/projects-list.ts` | `add-daemon-api-and-status` | `relay init` and every command that finds a job |

## Capabilities by change

| Change | Capabilities |
|---|---|
| `add-cli-scaffold` | `cli-commands`, `relay-config`, `relay-logging`, `build-and-ci` |
| `add-checkpoint-engine` | `job-files`, `checkpoints`, `rollback`, `git-safety`, `secret-scanning` |
| `add-provider-adapters` | `provider-adapters`, `fake-provider`, `adapter-contract-tests`, `codex-adapter`, `claude-code-adapter`, `provider-accounts`, `provider-policies`, `provider-hook-setup`, `agent-runs` |
| `add-relay-switch` | `agent-switch`, `run-continuation`, `handoff-content`, `handoff-checks`, `provider-allow-list`, `handoff-safety` |
| `add-daemon-api-and-status` | `daemon-lifecycle`, `local-api`, `live-state-index`, `provider-hooks`, `status-command` |
| `add-handoff-evaluation` | `handoff-evaluation` |
| `add-t3-limit-rules` | `t3-connection`, `usage-readings`, `limit-rules`, `t3-thread-actions` |

Two pairs of capabilities touch the same command, and each pair is written so that the two parts
agree. `agent-runs` (phase 3) defines `relay run`, and `run-continuation` (phase 4) adds the
handoff to it. `provider-hook-setup` (phase 3) defines the spool form of `relay hook`, and
`provider-hooks` (phase 5) adds delivery to the daemon; both keep the same allow list of hook
fields (`session_id`, `cwd`, `hook_event_name`, `error`, `notification_type`, `reason`, `source`,
`model`, `turn_id`) and the same spool line.
