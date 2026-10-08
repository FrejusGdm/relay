# How relay works

This page explains relay's parts and how they work together, with one diagram per topic. It is
meant for someone who has not read the code. Each section says which parts are already on the
`main` branch and which are still being built, and names the OpenSpec change (the written plan in
`openspec/changes/`) that builds them. `docs/progress.md` shows the state of each change in more
detail.

In the diagrams, a solid line or box is on `main` today. A dashed line, or a box with a dashed
border, is still being built: it is either in an open pull request or not written yet.

## The big picture

```mermaid
flowchart TB
  person(["The person"])

  subgraph computer["The person's computer"]
    cli["relay command-line tool"]
    daemon["relay daemon<br/>(background service)"]
    app["Mac menu-bar app"]
    claude["Claude Code<br/>(the official claude program)"]
    codex["Codex<br/>(the official codex program)"]
    repo[("The git repository<br/>.relay/ job files,<br/>checkpoints under refs/relay/")]
    home[("RELAY_HOME, ~/.relay by default<br/>config.toml, accounts, logs,<br/>relay.db, the socket")]
  end

  site["The website<br/>(install page)"]
  releases["GitHub releases<br/>(the relay program)"]

  person -->|"types relay commands"| cli
  person -->|"works with the agent"| claude
  person -.->|"looks at the card, clicks"| app
  cli -.->|"starts and stops, through adapters"| claude
  cli -.->|"starts and stops, through adapters"| codex
  claude -->|"hooks and the status line<br/>run relay hook and relay statusline"| cli
  codex -->|"hooks run relay hook"| cli
  cli -->|"saves checkpoints, writes job files"| repo
  cli -->|"reads settings, writes logs<br/>and account availability"| home
  cli -->|"starts it, asks over the socket"| daemon
  daemon -->|"follows events.jsonl,<br/>reads the checkpoint refs"| repo
  daemon -->|"keeps its index in relay.db"| home
  app -->|"reads over the socket"| daemon
  person -.->|"reads, copies the install commands"| site
  site -.->|"links to"| releases
  releases -->|"curl downloads the program"| cli

  classDef later stroke-dasharray: 5 5
  class app,site later
```

The person installs one program, `relay`, and keeps using the coding agents they already pay for.
relay never changes those agents. It starts the official `claude` and `codex` programs, watches
what they report, and keeps the state of the job in two places: inside the project, in a `.relay/`
folder and in hidden git refs under `refs/relay/`, and in relay's own folder, which this page
calls `RELAY_HOME` (`~/.relay` unless the person sets `RELAY_HOME`).

The daemon is a background process that keeps an index of every job and answers questions over a
private socket. The command-line tool and the Mac app are its clients. The website only tells
people how to install relay; it never talks to the program.

What is built on `main`:

- The command-line tool with `relay init`, `relay checkpoint`, `relay checkpoints`,
  `relay rollback`, `relay accept-git-changes`, `relay account`, `relay providers`,
  `relay policy show`, `relay hooks`, `relay hook`, `relay statusline`, `relay daemon` and
  `relay doctor --reindex` (`add-cli-scaffold`, `add-checkpoint-engine`, `add-provider-adapters`
  task groups 1 to 8, `add-daemon-api-and-status` task groups 1 to 6).
- The adapters for Claude Code and Codex, which know how to start, watch and stop each program.
  The command that uses them to start an agent, `relay run`, is in review in pull request #19
  (`add-provider-adapters` task groups 9 and 10).
- The daemon with its read endpoints and its event stream.
- The Mac app's package, its daemon client and its views (`add-mac-menu-bar-app` task groups 1 to
  3). Its actions, such as the switch sheet, are in review in pull request #20.
- The website's page (`add-website` task groups 1 to 6). It is not deployed yet.

## A handoff from Claude Code to Codex

```mermaid
sequenceDiagram
  autonumber
  actor P as The person
  participant C as Claude Code
  participant H as relay hook and relay statusline
  participant R as RELAY_HOME
  participant S as relay switch
  participant G as The git repository
  participant X as Codex
  participant D as relay daemon

  Note over C,R: On main (add-provider-adapters, task group 6)
  C->>H: status line data with the five-hour and weekly usage
  H->>R: accounts/claude-personal/availability.json, with the reset time
  C->>H: StopFailure hook with the error rate_limit
  H->>D: the event, or one line in spool/hooks.jsonl when the daemon does not answer
  D->>R: claude:personal is rate_limited

  Note over P,S: First version, the person starts the switch. Automatic failover is phase 7.
  P->>S: relay switch codex:personal

  Note over S,X: Being built (add-relay-switch, task groups 5 to 7)
  S->>S: checks before anything changes, account signed in, git settings unchanged
  S->>P: This sends the repository and the job notes to OpenAI. Continue?
  P->>S: yes, and relay adds codex:personal to the project's allow list
  S->>C: stop the agent through its adapter
  S->>G: work checkpoint under refs/relay/jobs/(job)/checkpoints/(n)
  S->>S: Claude hit its limit, so relay writes the notes itself from events and the repository
  S->>S: run the job's checks and compare the claims with the facts
  S->>S: secret scan of everything it will write or send
  S->>G: write .relay/checkpoint.md, record refs/relay/jobs/(job)/handoffs/(n)
  S->>X: start Codex with the continuation prompt
  X->>G: read task.md and checkpoint.md, write verify.md, continue the work
  S->>G: append the handoff and worker_started events to .relay/events.jsonl
  D->>G: follow events.jsonl
  D-->>P: new events on the event stream, shown by the Mac app
```

The diagram follows one job from the moment Claude Code runs out of usage to the moment Codex
continues it. Steps 1 to 4 are on `main`: Claude Code runs relay's status-line command and relay's
hooks, which the person installs once with `relay hooks install claude:personal --status-line`.
The status line gives relay the usage of the five-hour and weekly windows with their reset times,
and the `StopFailure` hook with the error `rate_limit` tells relay that the account is out of
usage. The hook gives the event to the relay daemon, which marks the account `rate_limited`; when
the daemon is not running, the hook appends a line to the spool file, which the daemon reads when
it starts and `relay account status` reads in the meantime.

In the first version the person starts the handoff by typing `relay switch codex:personal`, or
later from the Mac app's switch sheet. Starting it automatically when a limit is reported is
phase 7 of `docs/ROADMAP.md`, which begins with the change `add-t3-limit-rules`.

relay asks its questions before it stops anything, so a "no" leaves the job as it was. The first
handoff to an account of another company asks for confirmation, because the code then goes to that
company; the answer is remembered in `config.toml`. Because Claude Code stopped at its usage limit,
relay does not ask it for handoff notes: it writes the notes itself from the event log and the
repository. It then runs the job's checks (for example `bun test`), scans everything for secrets,
writes `.relay/checkpoint.md` and starts Codex with a short prompt. The prompt tells Codex to read
the task and the checkpoint, to check the previous agent's claims in `.relay/verify.md`, and then
to continue.

The parts of the handoff that the switch uses (checks, notes, `checkpoint.md`, the secret scan, the
allow list) are on `main` from `add-relay-switch` task groups 1 to 4. The switch engine that joins
them, the `relay switch` command and the end-to-end tests (task groups 5 to 7) are not built yet.
`docs/handoff.md` describes each step in detail.

## What lives where on disk

```mermaid
flowchart LR
  subgraph project["In the project (the git worktree)"]
    direction TB
    jobfiles["The job files in .relay/<br/>task.md: goal, criteria, plan<br/>decisions.md: decisions<br/>checkpoint.md: the latest handoff<br/>state.json: relay's record of the job<br/>events.jsonl: one event per line<br/>verify.md: the next agent's checks"]
    exclude[".git/info/exclude<br/>keeps .relay/ out of your commits"]
    refs["Hidden refs in .git<br/>refs/relay/jobs/&lt;job&gt;/checkpoints/&lt;n&gt;<br/>refs/relay/jobs/&lt;job&gt;/latest<br/>refs/relay/jobs/&lt;job&gt;/handoffs/&lt;n&gt;"]
  end

  subgraph relayhome["RELAY_HOME (~/.relay by default, mode 0700)"]
    direction TB
    config["config.toml: settings, accounts,<br/>projects and their allow lists"]
    plist["projects.list: known project roots"]
    db["relay.db: the daemon's index (a cache)"]
    run["run/relay.sock, run/daemon.lock,<br/>run/daemon.pid"]
    locks["locks/: the events lock and<br/>the worker lock of each job"]
    logs["logs/: cli.log, hook.log, daemon.log,<br/>checks/ (output of handoff checks)"]
    spool["spool/hooks.jsonl: hook events"]
    accounts["accounts/&lt;provider&gt;-&lt;name&gt;/<br/>account.json, availability.json"]
    jobs["jobs/&lt;job&gt;/handoff-settings.json:<br/>the job's check commands"]
    profiles["profiles/&lt;provider&gt;-&lt;name&gt;/<br/>the agent's own sign-in, which relay never reads"]
  end

  jobfiles -->|"saved in every checkpoint"| refs
  project -.->|"with config.toml and projects.list,<br/>the daemon rebuilds relay.db from these"| db
```

relay keeps the job next to the code, so that any agent can read it, and keeps everything private
outside the project. The `.relay/` folder holds the files that describe the job. relay lists it in
`.git/info/exclude`, so these files never enter the person's own commits. Each checkpoint is a git
commit stored under `refs/relay/`, a part of git that branches and `git log` do not show; relay
never moves the person's branch, index or uncommitted work, and it never pushes these refs.

`RELAY_HOME` holds the settings, the logs, the daemon's files and one folder per account. The
index `relay.db` is only a cache: the daemon can rebuild it at any time from `config.toml`,
`projects.list`, the job files and the checkpoint refs (`relay doctor --reindex` does this). A
profile folder belongs to the agent: Claude Code or Codex writes its sign-in there through its own
login command, and relay only points the agent at the folder.

All of this is on `main`, with three exceptions. The `handoffs/<n>` refs and `verify.md` come with
the switch engine of `add-relay-switch`. The worker lock comes with `relay run` (pull request #19).
`add-t3-limit-rules` adds `RELAY_HOME/t3/`, and `add-lifetime-license` would add
`RELAY_HOME/license.key`; neither folder nor file is on `main` yet. `docs/checkpoints.md`,
`docs/daemon.md` and `docs/accounts.md` describe the files one by one.

## The daemon and its clients

```mermaid
flowchart LR
  subgraph clients["Clients"]
    direction TB
    daemoncmd["relay daemon start, status, stop,<br/>relay doctor --reindex"]
    status["relay status"]
    mac["Mac menu-bar app"]
    hook["relay hook"]
  end

  daemoncmd --> sock
  status -.->|"in review, #18"| sock
  mac --> sock
  hook --> sock

  sock["run/relay.sock<br/>a Unix socket, mode 0600,<br/>in a folder of mode 0700"] --> peer{"Peer check:<br/>is the connecting user<br/>the daemon's user?"}
  peer -->|"no"| closed["Connection closed,<br/>nothing read"]
  peer -->|"yes"| router{"No Origin header,<br/>path under /v1/"}
  router --> reads["Read endpoints<br/>GET /v1/version, /v1/providers,<br/>/v1/accounts, /v1/jobs,<br/>/v1/jobs/{job}/workers,<br/>/v1/jobs/{job}/checkpoints"]
  router --> sse["GET /v1/events<br/>the event stream (SSE)"]
  router --> hooks["POST /v1/hooks/{provider}/{event}<br/>queued, then recorded in events.jsonl,<br/>availability.json and the index"]
  router -.-> actions["POST /v1/jobs/{job}/checkpoint<br/>POST /v1/jobs/{job}/switch"]
  reads --> index[("relay.db")]
  sse --> index
  index -->|"filled from"| files["config.toml, projects.list,<br/>.relay/ files, refs/relay/"]

  classDef later stroke-dasharray: 5 5
  class actions later
```

The daemon answers on a Unix socket, a special file that only programs on the same computer can
open. It never opens a network port, so a web page cannot reach it. Before it reads a single byte,
the daemon asks the operating system which user opened the connection and closes the connection
when that user is not its own. A request that carries an `Origin` header, which browsers add, is
refused.

The read endpoints answer with JSON from the index. The event stream, `GET /v1/events`, uses
server-sent events (SSE): the connection stays open and the daemon sends each new event as it
happens, so a client does not have to ask again and again. The Mac app reads both the read
endpoints and the event stream. `relay status`, in review in pull request #18, reads the read
endpoints once and prints the job, its latest checkpoint and the availability of each account;
when the daemon is not running, it builds the same view from the files. `relay hook` sends each
hook event to `POST /v1/hooks/{provider}/{event}`; the daemon puts it on a queue, answers at once,
and then records it in the job's event log, the account's `availability.json` and the index
(`docs/hooks.md`).

On `main`: the socket, the peer check, the read endpoints, the event stream and the `relay daemon`
commands (`add-daemon-api-and-status` task groups 1 to 6), and the Mac app's client
(`add-mac-menu-bar-app` task groups 1 to 3). Hook events sent straight to the daemon (task group
8) are in review. Still to come: the checkpoint and switch endpoints (task group 7) and the
end-to-end test (task group 11). `docs/daemon.md` and `docs/api.md` describe the
daemon and every endpoint.

## The safety rules

```mermaid
flowchart TD
  start["relay is about to start an agent"] --> own{"Is it an account the person added<br/>and signed in to with the provider's own login?"}
  own -->|"no"| refuse["relay refuses"]
  own -->|"yes"| env["Build the environment without<br/>credential variables of any provider"]
  env --> perm{"Is the permission read-only<br/>or edit-in-workspace?"}
  perm -->|"no, for example full-access"| refuse
  perm -->|"yes"| argv["Build the command line:<br/>no permission-bypass flag,<br/>the prompt last, after --"]
  argv --> agent["The agent runs"]
  agent -->|"asks for approval"| report["relay records approval_requested<br/>and answers nothing"]
```

| Rule | What it means | Where it is enforced | State |
|---|---|---|---|
| The prompt comes after `--` | A prompt such as `--dangerously-bypass-approvals-and-sandbox` stays text and is never read as an option. A one-word prompt gets a trailing space so Claude Code cannot read it as a subcommand. | `src/adapters/claude/interactive.ts`, `src/adapters/codex/interactive.ts`, `src/adapters/codex/exec.ts` | On `main` in the adapters; `relay run`, which passes the person's prompt, is in review (#19) |
| Never a bypass flag | relay never adds a flag that turns off the agent's permission checks. The adapter interface accepts only `read-only` and `edit-in-workspace`, so `full-access` cannot reach an agent, and the adapter tests fail if a bypass flag appears in a command line. | `src/adapters/types.ts`, `src/handoff/permission.ts`, `test/adapters/` | On `main` |
| Never answer an approval request | When an agent asks for permission, the adapter reports `approval_needed` and relay sends no decision. | The adapters' workers, such as `src/adapters/codex/app-server-worker.ts` | On `main`; stopping a headless agent that asks, with its own exit code, comes with #19 |
| Only your own subscriptions | relay starts only the official programs the person installed and signed in to. It does not pool, share or rotate accounts, and it switches between two accounts of the same provider only when the person asks. | `src/accounts/`, `src/policies/switching.ts` | On `main` |
| No reading of credential files | relay never reads, copies, stores or logs a password, token or API key value. It removes credential variables from the agent's environment, unless the person names one for an account, and it never reads the files in a profile folder. | `src/accounts/environment.ts`, `src/accounts/profile.ts` | On `main` |
| Confirmation before another company | The first handoff to another company's agent asks first, because it sends the code to that company. | `src/handoff/allow-list.ts` | The check is on `main`; the switch that asks is being built (`add-relay-switch` 5 to 7) |

The diagram shows the checks between relay and an agent it starts. The table lists the rules that
the project's documents promise, what each one means in practice and where the code enforces it.
There is one exception to "relay never stores tokens": when the person connects relay to T3 Code,
relay keeps the access token T3 Code issues to it, in the operating system's credential store only
(`add-t3-limit-rules`). `VISION.md` and `docs/research/security.md` explain why these rules exist.
