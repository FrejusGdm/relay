# Codebase map

Last updated 2026-10-08, after task groups 1 to 7 of `add-cli-scaffold`, task groups 1 to 5 of
`add-checkpoint-engine`, task groups 1 to 7 of `add-handoff-evaluation`, and task groups 1 to 7
of `add-website`.

This page shows the folders of relay's source code and tests, and what each one holds today.
`docs/first-version-index.md` lists every file that the six first-version changes will add, and
which change owns it. Each change that adds a folder updates this page.

```mermaid
flowchart TD
  pkg["package.json, tsconfig.json, bunfig.toml"]

  subgraph src["src/"]
    cli["src/cli/<br/>main.ts, run.ts, router.ts, help.ts,<br/>io.ts, errors.ts, exit-codes.ts"]
    commands["src/cli/commands/<br/>registry.ts: the sixteen commands<br/>init.ts, checkpoint.ts, checkpoints.ts,<br/>rollback.ts, hook.ts, not-built.ts: their handlers"]
    checkpoint["src/checkpoint/<br/>save.ts: saveCheckpoint, the one checkpoint function<br/>snapshot.ts: the tree, built with a temporary index<br/>commit.ts: the commit and its refs<br/>list.ts: relay checkpoints<br/>rollback.ts: relay rollback"]
    core["src/core/<br/>version.ts: the version from package.json<br/>paths.ts: the home and relay folders<br/>relay-home.ts: folder and file safety checks<br/>quote.ts: escapes text relay repeats<br/>log.ts: the JSON-lines log files<br/>cleanup.ts: what to undo on a signal"]
    config["src/core/config/<br/>load.ts, validate.ts, log-level.ts,<br/>types.ts: reading and checking config.toml"]
    platform["src/platform/<br/>toml.ts: the only Bun-specific call"]
    adapters["src/adapters/<br/>providers.ts: the list of providers"]
    daemon["src/daemon/<br/>empty until add-daemon-api-and-status"]
    git["src/git/<br/>run.ts: the only code that starts git<br/>repo.ts: finds the repository<br/>trust.ts: the trust record of git settings and hooks"]
    job["src/job/<br/>id.ts, names.ts: job IDs and job file names<br/>files.ts, state.ts: templates and state.json<br/>events.ts: the only writer of events.jsonl<br/>lock.ts: the job lock and the events lock<br/>exclude.ts: the /.relay/ exclude line"]
    secrets["src/secrets/<br/>scan.ts: the gitleaks scans<br/>names.ts: secret-like file names"]
    text["src/text/<br/>invisible.ts: the one list<br/>of invisible characters"]
  end

  subgraph test["test/"]
    setup["setup.ts: the test preload"]
    helpers["helpers/home.ts: a new relay folder per test<br/>helpers/cli.ts: run relay in or out of process<br/>helpers/scratch-repo.ts, invariants.ts: scratch repositories<br/>and captureState()"]
    gittests["git/: runner, repository, only-runner<br/>and trust record tests"]
    jobtests["job/, text/, secrets/, checkpoint/:<br/>job files, events, locks, invisible characters,<br/>secret scans, relay init and relay checkpoint<br/>helpers/fake-gitleaks.ts, helpers/secrets.ts"]
    clitests["cli/: router, help, hook, signal, settings,<br/>logging and exit-code tests<br/>cli/golden/: the exact help texts"]
    coretests["core/: paths, relay folder, settings and log tests<br/>fixtures/config/: settings files"]
    fake["fixtures/fake-provider/<br/>guard programs, fake agent, scenarios"]
    buildtests["build/: no-network.test.ts"]
  end

  scripts["scripts/smoke-test.sh:<br/>runs a built program"]
  ci[".github/workflows/ci.yml: the CI checks<br/>.github/dependabot.yml: weekly updates"]

  pkg -->|"bun run relay"| cli
  cli -->|"looks up the command"| commands
  cli -->|"checks the relay folder,<br/>writes logs/cli.log and logs/hook.log"| core
  cli -->|"loads the settings"| config
  commands -->|"hook.ts logs through"| core
  config -->|"checks the file with"| core
  config -->|"parses with"| platform
  coretests -->|"check"| config
  clitests -->|"compare help with"| commands
  core -->|"reads the version"| pkg
  pkg -->|"bun test preloads"| setup
  setup -->|"puts guard-bin/ first on PATH"| fake
  buildtests -->|"searches for network use"| src
  ci -->|"runs bun test, builds, then runs"| scripts
  gittests -->|"try to break the rules of"| git
  gittests -->|"use scratch repositories and captureState() from"| helpers
  commands -->|"init.ts sets up a job with"| job
  commands -->|"init.ts checks the scanner with"| secrets
  commands -->|"init.ts finds the repository and records trust with"| git
  secrets -->|"reads the checkpoint trees through"| git
  commands -->|"init.ts, checkpoint.ts, checkpoints.ts and rollback.ts use"| checkpoint
  checkpoint -->|"builds trees and commits through"| git
  checkpoint -->|"scans with"| secrets
  checkpoint -->|"locks, appends events and updates state.json with"| job
  commands -->|"init.ts cleans the title with"| text
  git -->|"trust.ts marks invisible characters with"| text
  jobtests -->|"check"| job
  jobtests -->|"check"| secrets
  jobtests -->|"check"| checkpoint
```

The diagram shows how the pieces connect. `bun run relay` starts `src/cli/main.ts`, which passes
the command line to `runCli` in `src/cli/run.ts`. `runCli` asks `src/cli/router.ts` what the
command line means, prints help from `src/cli/help.ts` or an error, or calls the command's
handler. `src/cli/commands/registry.ts` lists the sixteen commands with their help texts and
argument counts. In this version every handler is `not-built.ts`, except `hook.ts` for
`relay hook`, `init.ts` for `relay init`, `checkpoint.ts` for `relay checkpoint`, `checkpoints.ts` for `relay checkpoints` and `rollback.ts` for `relay rollback`, which restores an earlier checkpoint's files after saving an undo checkpoint. `--version` prints the version from `src/core/version.ts`, which reads the
`version` field of `package.json`. `docs/cli.md` describes the command line and its exit codes.

Before a command's handler runs, `runCli` finds the relay folder with `src/core/paths.ts`,
creates or checks it with `src/core/relay-home.ts`, and loads `config.toml` with
`src/core/config/load.ts`. `load.ts` checks the file with `relay-home.ts`, parses it with
`src/platform/toml.ts`, and checks every setting with `validate.ts`. `types.ts` holds the shape of
the loaded settings, and `log-level.ts` picks the log level. Every message that repeats a value or path
writes it through `src/core/quote.ts`, which escapes characters that do not print, so a value
cannot change what the terminal shows; the router uses it too. `docs/config.md` describes the
settings and shows this flow in a diagram.

Once the relay folder has passed its checks, `runCli` opens a logger with `openLog` from
`src/core/log.ts`. The logger writes one JSON object per line to `logs/cli.log`, or to
`logs/hook.log` for `relay hook`, and rotates the file at 10 MB. `runCli` gives the logger to the
command's handler, and `src/cli/main.ts` uses it to record a signal that stops relay. The "Log
files" section of `docs/cli.md` describes the events, the fields and what is never logged.

`src/platform/` holds calls that only work on Bun, so that a later move to another runtime
changes one folder. `src/adapters/providers.ts` names the two supported providers, `claude` and
`codex`. `src/daemon/` only holds a README until the change named in the diagram fills it.

`src/git/run.ts` is the only code that starts git. Every call gets settings that turn off hooks
and the file-system monitor, an environment without the parent's `GIT_` variables, and checks that
keep git away from the person's branch, index, stash and files. `src/git/repo.ts` uses it to find
the repository that holds a folder. `src/git/trust.ts` writes `git-trust.json` in the job's folder
under `RELAY_HOME` with hashes of the git settings and hooks, and later reports what changed. `docs/git-safety.md` explains the rules, and the tests in
`test/git/` try to break each of them. `test/git/only-runner.test.ts` fails if any other source
file starts git.

`bun test` loads `test/setup.ts` before any test, because `bunfig.toml` lists it as a preload.
The preload gives each test run its own home folder and relay folder in the system temporary
folder, removes credential variables, and puts the guard programs in
`test/fixtures/fake-provider/guard-bin/` first on `PATH`. The guard programs stop any test that
starts the real `claude` or `codex` by mistake, and `guard-bin/git` stops any git process that
does not come from relay's git runner. The preload also removes git and XDG settings variables, and makes `Bun.spawn`,
`Bun.spawnSync` and `Bun.which` use the test environment when a test passes none. The fake agent in the same folder follows a
scenario file, so tests can run a scripted child process instead of a real agent.
`test/fixtures/fake-provider/README.md` describes both.

The tests in `test/cli/` run relay in the same process with `runRelayInProcess`, or as its own
process with `runRelay` when they need standard input, signals or a full logging check.
`test/cli/logging.test.ts` plants credentials, option values, settings values and hook input built
while the test runs, and checks that no log file contains them. `test/cli/golden/` holds the
exact text of the top-level help and of each command's help, and the tests compare the output
with these files byte for byte.

The tests in `test/core/` call the relay folder, settings and log functions directly. They build
each settings file in a new relay folder from `makeRelayHome`, or read one from
`test/fixtures/config/`. A credential value in a test is built at run time, so none is committed.

`test/build/no-network.test.ts` searches every file under `src/` and fails when relay's code could
open a network connection, other than to relay's own socket (`src/client/`) or to T3 Code on this
computer (`src/t3/client.ts` and `src/t3/oauth.ts`). `scripts/smoke-test.sh` runs a built `relay` program and checks its
version, its help, its exit code and its log file. The workflow in `.github/workflows/ci.yml`
runs the type check and the tests, builds the program for Linux and macOS, runs the smoke test on
each, and scans the dependencies and the git history. `.github/dependabot.yml` asks GitHub to
propose updates to the actions and the Bun dependencies every week. `docs/development.md`
describes these steps and shows the CI jobs in a diagram.

`test/helpers/scratch-repo.ts` creates a scratch repository with commits, a second branch, a tag,
a stash entry, and staged, unstaged, untracked and ignored files, with its own `HOME` and
`RELAY_HOME`. `test/helpers/invariants.ts` provides `captureState()`, which records everything of
the person's that relay must never change, so a test can compare the repository before and after
a command.

`src/cli/commands/init.ts` is `relay init`. It finds the repository with `src/git/repo.ts`,
checks gitleaks with `src/secrets/scan.ts`, draws a job ID with `src/job/id.ts`, writes the job
files with `src/job/files.ts` and `src/job/state.ts`, adds the exclude line with
`src/job/exclude.ts`, records the git trust record with `src/git/trust.ts`, and appends the first
event with `appendEvent` from `src/job/events.ts`. That function is the only code that writes
`events.jsonl`, and `test/job/single-writer.test.ts` fails if another source file does.
`src/job/lock.ts` holds the job lock and the short events lock under `RELAY_HOME/locks/`, and
`src/job/names.ts` names the job files for the modules that need the list. `src/text/invisible.ts`
removes invisible characters from the job title, and `src/git/trust.ts` uses the same list to
mark them in its report. `src/secrets/scan.ts` runs gitleaks on text relay builds itself, and
`src/secrets/names.ts` matches file names that suggest secrets. When a signal stops relay, `src/cli/main.ts` runs the
actions registered in `src/core/cleanup.ts`: the scan removes its temporary files and stops
gitleaks, and `relay init` removes what it had created. `docs/checkpoints.md` describes
both flows in diagrams.

`relay init` then saves the first checkpoint, and `src/cli/commands/checkpoint.ts` saves the next
ones. Both call `saveCheckpoint` in `src/checkpoint/save.ts`, the one function that saves a
checkpoint. It checks the trust record, takes the job lock, builds the tree with
`src/checkpoint/snapshot.ts` (which works on a temporary copy of the person's index), scans it with
`src/secrets/scan.ts`, creates the commit and writes the refs under `refs/relay/` with
`src/checkpoint/commit.ts`, and records the event and `state.json`. The "Saving checkpoints"
section of `docs/checkpoints.md` shows this in a diagram. The setting
`[checkpoint] max_file_size_mb` reaches the commands through the loaded settings, which `runCli`
passes to every handler.

The tests in `test/job/`, `test/text/` and `test/secrets/` call these modules directly; the
secret scan tests use `test/helpers/fake-gitleaks.ts` through `RELAY_GITLEAKS`, and the real
gitleaks with secrets that `test/helpers/secrets.ts` builds at run time. `test/checkpoint/init.test.ts`
runs `relay init` in scratch repositories and compares `captureState()` before and after.
`test/checkpoint/snapshot.test.ts` and `commit.test.ts` call the checkpoint modules directly, and
`test/checkpoint/checkpoint.test.ts` runs `relay checkpoint` and compares `captureState()` before
and after in ordinary, detached, empty and linked-worktree repositories.

## The handoff evaluation harness

`eval/handoff/` holds the opt-in evaluation of `add-handoff-evaluation`. It is a separate Bun
program, run with `bun run eval:handoff <command>`, and is never compiled into the `relay` binary.
It has its command line, the four fixture tasks, the plan files, the checks that `run` makes
before it starts, the runner that performs baseline and handoff runs through `relay`, and the
summary with its decision rules. Its own tests use a stub `relay` instead of the real program, so
they start no agent.

```mermaid
flowchart TD
  script["package.json script eval:handoff"]
  home["$RELAY_EVAL_HOME<br/>targets.toml, campaigns/&lt;name&gt;/campaign.json,<br/>runs/&lt;run-id&gt;/result.json, summary.md, summary.csv,<br/>work/&lt;run-id&gt;/repo while a run lasts"]
  relay["relay program<br/>$RELAY_BIN or relay on PATH"]

  subgraph eval["eval/handoff/"]
    main["src/main.ts<br/>the five commands and the usage text"]
    plan["src/plan.ts<br/>reads plans and targets.toml, lists the runs, estimates the time"]
    campaign["src/campaign.ts<br/>the run command: confirmation, campaign.json,<br/>resuming, progress lines, exit codes"]
    guards["src/guards.ts<br/>CI, terminal, fixture, disk checks and the confirmation"]
    runner["src/runner.ts<br/>one baseline or handoff run"]
    relaycli["src/relay-cli.ts<br/>every relay command the harness runs"]
    events["src/events.ts<br/>event types and the events.jsonl reader"]
    interrupt["src/interrupt.ts<br/>steps:P and the two event points"]
    scratch["src/scratch.ts and src/safety.ts<br/>scratch repository, four safety values,<br/>bypass flags, contamination, cleanup"]
    snapshot["src/snapshot.ts<br/>per-step snapshots under refs/relay-eval/steps/"]
    measure["src/measure.ts, src/rework.ts, src/claims.ts<br/>tests on an export, rework, verify.md"]
    result["src/result.ts<br/>result.json and attempt files"]
    summary["src/summary.ts<br/>summarize and annotate"]
    fixtures["src/fixtures.ts<br/>reads task.toml, runs check-fixtures"]
    junit["src/junit.ts<br/>counts passed and failed tests in JUnit XML"]
    gitrun["src/git.ts<br/>runs git without hooks or fsmonitor; exports commits"]
    plans["plans/<br/>smoke.toml, standard.toml, full.toml"]
    tasks["tasks/<br/>rate-limiter, ledger-import, job-queue, markdown-toc"]
    stub["test/bin/relay<br/>the stub relay that plays scenario files"]
  end

  script --> main
  main -->|"plan"| plan
  main -->|"run"| campaign
  main -->|"summarize, annotate"| summary
  main -->|"check-fixtures"| fixtures
  campaign -->|"checks before asking yes"| guards
  campaign -->|"each pending run"| runner
  runner --> scratch
  runner -->|"follows .relay/events.jsonl with"| events
  runner -->|"decides when to switch with"| interrupt
  runner -->|"baselines"| snapshot
  runner --> measure
  runner -->|"writes"| result
  runner -->|"init, run, switch, checkpoint, status"| relaycli
  relaycli --> relay
  stub -.->|"stands in for, in tests"| relay
  measure -->|"reads reports with"| junit
  scratch -->|"git archive of .start/"| tasks
  scratch --> gitrun
  snapshot --> gitrun
  measure --> gitrun
  summary -->|"reads result files"| home
  result --> home
  plan -->|"reads"| plans
  fixtures --> tasks
```

The diagram shows how the parts of the harness depend on each other. `bun run eval:handoff`
starts `src/main.ts`, which hands each command to its module. Only `src/relay-cli.ts` starts the
`relay` program, and only `src/git.ts` starts git. In the tests, `$RELAY_BIN` points at the stub
in `test/bin/`, shown with a dotted line.

`plan <plan>` reads a plan file from `plans/` through `src/plan.ts`, and the founder's
`targets.toml` from `$RELAY_EVAL_HOME` (by default `~/.relay-eval`), which maps each role of the
plan, such as `claude`, to one of his relay accounts. It expands the plan into the ordered list of
runs: all baselines first, then all handoffs, with repetition 1 of every run before any
repetition 2. It prints the number of runs, the accounts and the expected agent time, and starts
nothing.

`run <plan>` first makes every check that must pass before the evaluation spends a subscription
(`src/guards.ts`): it refuses when `CI` is set or standard input is not a terminal, and stops when
an existing campaign's `campaign.json` records a different plan hash or accounts, when a fixture
has uncommitted changes, or when less than 1 GB is free. It skips every run that already has a
`result.json`, and runs whose last attempt was a harness error unless `--retry-errors` is given.
Then it names the companies and accounts that will receive the fixture code, asks the founder to
type `yes`, writes `campaign.json` for a new campaign, looks for `relay`, and gives each pending run
to `src/runner.ts`. It stops at once with exit code 5 when a target reaches its limit, 130 after
Ctrl-C, and 1 when relay started an agent with a permission bypass flag.

```mermaid
sequenceDiagram
  participant H as runner.ts
  participant S as scratch repository
  participant R as relay run
  participant W as relay switch
  H->>S: git archive of .start/, one commit, the person's note in NOTES.md
  H->>S: relay init, .relay/task.md, record the four safety values, snapshot 0
  H->>R: relay run with the first target, --headless --json
  loop every 500 ms
    H->>S: read new lines of .relay/events.jsonl
    Note over H: count steps, snapshot after each step of a baseline,<br/>watch for a bypass flag, the fixture path and the time limit
  end
  H->>W: at the interrupt point, relay switch to the next target, --yes --json
  W->>R: relay run stops the first agent and starts the next one
  R-->>H: exits when the next agent ends
  H->>S: relay checkpoint --message "eval final" --json
  H->>H: tests on exports of the final and handoff checkpoints, rework, verify.md
  H->>S: recheck the four safety values
  H->>H: write result.json, then remove the work folder and relay's job worktrees
```

The sequence shows one handoff run. A baseline run is the same without `relay switch`; instead the
runner snapshots the working tree after every step into `refs/relay-eval/steps/<n>` with a
temporary index, and afterwards measures the snapshots at 25, 50 and 75 percent of its steps as
control points. A handoff run switches after the step chosen by `src/interrupt.ts` from the median
step count of the completed baselines. Every test run happens in a temporary export made with
`git archive`, where the hidden acceptance tests are added as `__acceptance__/`, so they never
reach a folder an agent works in. Snapshot 0 holds the starting tree with the person's note, and
rework is measured from it. The four safety values are the `main` tip, its reflog, the index file
and `NOTES.md`; any change is a safety violation in the result. Runs stopped by a limit, by Ctrl-C
or by a harness error are saved as `attempt-<n>.json` and stay pending.

`summarize <campaign>` reads only the result files through `src/summary.ts`. It writes
`summary.csv` with one row per run and `summary.md` with a header, a verdict and a rule table per
handoff direction, the outcomes per task, run kind, direction and point, and the runs that need a
look. `annotate <campaign> <run-id> <text>` saves a note in that run's `result.json`, and the next
summary lists it.

`check-fixtures` reads each task's `task.toml` through `src/fixtures.ts`. For each task it copies
the starting repository from `.start/` to a temporary folder, runs the visible tests, then adds the
hidden acceptance tests as `__acceptance__/` and runs them. It does the same again with the
reference solution from `solution/` copied over the start. Every run writes JUnit XML, which
`src/junit.ts` reads with Bun's `HTMLRewriter`. Python tasks write that XML through
`runners/unittest_junit.py`. None of the four tasks needs an installation or the network.

`test/bin/relay` is a stub of the `relay` program for the harness's tests. It implements
`--version`, `init`, `run`, `checkpoint`, `checkpoints`, `switch` and `status` with the JSON that
the real commands print, writes `.relay/events.jsonl` and checkpoint commits under `refs/relay/`,
and plays the agents' edits and commands from the scenario file named by `RELAY_STUB_SCENARIO`.
The tests build a committed copy of the harness in a temporary folder, so runs can export fixtures
with `git archive` even where the checkout is not a git repository. `test/data/campaigns/` holds
four sample campaigns, and `test/golden/` the summaries they must produce.

A bare `bun test` at the repository root also runs the harness's own tests, because `bunfig.toml`
sets the whole repository as the test root (see the website section below), and
`bun test ./eval/handoff/test` runs only them. Both load relay's test preload, whose guard program
stops git unless a git runner started it, so `src/git.ts` marks its git processes the way relay's
runner does (`docs/development.md`, "The fake provider"). The fixtures' starting repositories and
acceptance tests sit in folders whose names start with a dot, which Bun's test runner skips, so
neither command runs them.

## The website

`site/` holds the public website, which is separate from the `relay` program. `site/public/` is
the folder that is deployed, with the two pages, the stylesheet and the script. `site/test/` holds
file checks that `bun test` runs together with the tests above, and `site/e2e/` holds browser
checks that Playwright runs. `site/scripts/` holds the font download script, the smoke test
of a running copy of the site, and the deployment script. `bunfig.toml` sets the test root to the whole repository so that
`bun test` finds `site/test/`. `docs/website.md` describes the files with a diagram and says how to
get the fonts and run the checks.
