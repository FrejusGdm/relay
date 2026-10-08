# Codebase map

Last updated 2026-10-08, after task groups 1 to 7 of `add-cli-scaffold`, task groups 1 to 9 of
`add-checkpoint-engine`, task groups 1 to 5 of `add-provider-adapters`, task groups 1 to 4 of
`add-handoff-evaluation`, and task groups 1 to 7 of `add-website`.

This page shows the folders of relay's source code and tests, and what each one holds today.
`docs/first-version-index.md` lists every file that the six first-version changes will add, and
which change owns it. Each change that adds a folder updates this page.

```mermaid
flowchart TD
  pkg["package.json, tsconfig.json, bunfig.toml"]

  subgraph src["src/"]
    cli["src/cli/<br/>main.ts, run.ts, router.ts, help.ts,<br/>io.ts, errors.ts, exit-codes.ts"]
    commands["src/cli/commands/<br/>registry.ts: the sixteen commands<br/>init.ts, checkpoint.ts, checkpoints.ts,<br/>rollback.ts, accept-git-changes.ts, hook.ts,<br/>account.ts, providers.ts, policy.ts,<br/>not-built.ts: their handlers"]
    checkpoint["src/checkpoint/<br/>save.ts: saveCheckpoint, the one checkpoint function<br/>snapshot.ts: the tree, built with a temporary index<br/>commit.ts: the commit and its refs<br/>list.ts: relay checkpoints<br/>rollback.ts: relay rollback"]
    core["src/core/<br/>version.ts: the version from package.json<br/>paths.ts: the home and relay folders<br/>relay-home.ts: folder and file safety checks<br/>quote.ts: escapes text relay repeats<br/>log.ts: the JSON-lines log files<br/>cleanup.ts: what to undo on a signal"]
    config["src/core/config/<br/>load.ts, validate.ts, log-level.ts,<br/>types.ts: reading and checking config.toml<br/>edit.ts: the one writer of config.toml"]
    platform["src/platform/<br/>toml.ts: the only Bun-specific call<br/>clock.ts: now() and, for tests, setClock()"]
    adapters["src/adapters/<br/>providers.ts: the list of providers<br/>types.ts: the adapter interface and events<br/>registry.ts: the adapter of each provider<br/>process.ts: the only code that starts agents<br/>lines.ts, text.ts, reset-time.ts: output lines,<br/>TOML strings and reset times<br/>program.ts: finding a program and its version<br/>claude/, codex/: adapter.ts, policy.toml,<br/>tested-versions.json; codex/protocol-used.json"]
    policies["src/policies/<br/>schema.ts, load.ts: the policy files<br/>switching.ts: mayAutoSwitch"]
    accounts["src/accounts/<br/>environment.ts: the agent's environment<br/>profile.ts: profile folders and their checks<br/>registry.ts: accounts in the settings<br/>record.ts, availability.ts, files.ts:<br/>account.json and availability.json"]
    daemon["src/daemon/<br/>empty until add-daemon-api-and-status"]
    git["src/git/<br/>run.ts: the only code that starts git<br/>repo.ts: finds the repository<br/>trust.ts: the trust record of git settings and hooks"]
    job["src/job/<br/>id.ts, names.ts: job IDs and job file names<br/>files.ts, state.ts: templates and state.json<br/>events.ts: the only writer of events.jsonl<br/>lock.ts: the job lock, the events lock<br/>and the config lock<br/>exclude.ts: the /.relay/ exclude line"]
    secrets["src/secrets/<br/>scan.ts: the gitleaks scans<br/>names.ts: secret-like file names<br/>redact.ts: secret-looking values in facts"]
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
    fakes["fakes/<br/>fake-claude.ts, fake-codex.ts: the fake agents<br/>scenario.ts, record.ts, run-hooks.ts<br/>fake-adapter.ts: the in-process fake adapter<br/>fake-t3.ts: a fake T3 Code server"]
    adaptertests["adapters/, accounts/, policies/, docs/:<br/>adapter core, accounts, policies and document tests<br/>adapters/contract.ts, fixtures.ts, registry.ts:<br/>the contract suite<br/>fixtures/providers/: the provider fixtures<br/>helpers/child.ts, helpers/fake-programs.ts"]
  end

  scripts["scripts/smoke-test.sh: runs a built program<br/>scripts/check-release-binary.sh:<br/>no fake agent in the program<br/>scripts/check-policies.ts, record-fixture.ts,<br/>check-codex-protocol.ts"]
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
  commands -->|"init.ts finds the repository and records trust with,<br/>accept-git-changes.ts rewrites the trust record with"| git
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
  adapters -->|"reads the time from"| platform
  accounts -->|"finds the home and relay folders with"| core
  fakes -->|"fake-adapter.ts implements the interface of"| adapters
  adaptertests -->|"start fake-claude through process.ts"| fakes
  adaptertests -->|"check"| adapters
  adaptertests -->|"check"| accounts
  commands -->|"account.ts, providers.ts use"| adapters
  commands -->|"account.ts manages"| accounts
  commands -->|"account.ts writes config.toml through"| config
  commands -->|"policy.ts shows"| policies
  adapters -->|"carry their policy from"| policies
  adaptertests -->|"check"| policies
```

The diagram shows how the pieces connect. `bun run relay` starts `src/cli/main.ts`, which passes
the command line to `runCli` in `src/cli/run.ts`. `runCli` asks `src/cli/router.ts` what the
command line means, prints help from `src/cli/help.ts` or an error, or calls the command's
handler. `src/cli/commands/registry.ts` lists the sixteen commands with their help texts and
argument counts. In this version every handler is `not-built.ts`, except `hook.ts` for
`relay hook`, `init.ts` for `relay init`, `checkpoint.ts` for `relay checkpoint`,
`checkpoints.ts` for `relay checkpoints`, `rollback.ts` for `relay rollback`, which restores an
earlier checkpoint's files after saving an undo checkpoint, `accept-git-changes.ts` for
`relay accept-git-changes`, `account.ts` for `relay account`, `providers.ts` for
`relay providers` and `policy.ts` for `relay policy show`. `--version` prints the version from `src/core/version.ts`, which reads the
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
changes one folder, and `clock.ts`, the one clock that every comparison with a reset time or a
file's age reads. `src/adapters/providers.ts` names the two supported providers, `claude` and
`codex`. `src/daemon/` only holds a README until the change named in the diagram fills it.

`src/adapters/` holds the adapter interface of `add-provider-adapters` in `types.ts` and the
registry that gives each provider's adapter in `registry.ts`; the Claude Code and Codex adapters
themselves come in later task groups. `process.ts` is the only code that starts an agent process:
headless agents in their own process group with their output drained into a worker log of mode
0600, interactive agents in the person's terminal, and signals only through the child relay holds.
`test/adapters/no-other-spawn.test.ts` fails if another file under `src/adapters/` starts a process.
`lines.ts` splits output into whole lines, `text.ts` encodes TOML strings for Codex, and
`reset-time.ts` reads the reset times of usage limits. `src/accounts/environment.ts` builds every
agent's environment without credential variables, and `src/accounts/profile.ts` recognises the
providers' own folders. `src/secrets/redact.ts` replaces secret-looking values in the facts relay
records. `docs/adapters.md` describes all of these with diagrams.

`src/adapters/claude/adapter.ts` and `src/adapters/codex/adapter.ts` are the two adapters. So far
they find their program through `src/adapters/program.ts`, read its version and compare it with
their `tested-versions.json`, read the sign-in state, name the login command, and declare their
capabilities and hooks; starting workers comes in later task groups. Each folder also holds the
provider's `policy.toml`, which `src/policies/load.ts` imports and `schema.ts` checks, and
`src/policies/switching.ts` answers whether relay may move a job between two accounts on its own.
`src/cli/commands/account.ts` is `relay account list | add | status | login | remove`: it checks and
creates profile folders with `src/accounts/profile.ts`, writes `config.toml` only through
`src/core/config/edit.ts`, keeps `account.json` with `src/accounts/record.ts` and reads
`availability.json` with `src/accounts/availability.ts`. `providers.ts` is `relay providers` and
`policy.ts` is `relay policy show`. `docs/accounts.md` describes the accounts with diagrams.

`test/adapters/contract.ts` declares the contract suite that every adapter registered in
`test/adapters/registry.ts` must pass, and `test/adapters/fixtures.ts` loads and replays the
fixtures in `test/fixtures/providers/`. `scripts/record-fixture.ts` records a real fixture when
`RELAY_RECORD=1` is set, `scripts/check-codex-protocol.ts` checks the Codex protocol subset in
`src/adapters/codex/protocol-used.json`, and `scripts/check-policies.ts` fails when a policy is
older than its `max_age_days` or dated in the future; CI runs it in a job of its own, so a stale
date does not stop the release build. `docs/testing-adapters.md`
describes the contract suite and the fixtures.

`test/fakes/` holds the fake agents that every adapter test runs instead of the real programs:
`fake-claude.ts` and `fake-codex.ts` print the output formats of Claude Code and Codex and follow a
scenario file (`scenario.ts`), record what they received (`record.ts`) and run installed hooks
(`run-hooks.ts`). `fake-adapter.ts` implements the adapter interface in memory for tests of code
that uses adapters, and `fake-t3.ts` is the fake T3 Code server of `add-t3-limit-rules`. `scripts/check-release-binary.sh` builds relay and fails if a fake reached the
program; CI runs it after each build. `docs/testing-adapters.md` describes the fakes and the
scenario format.

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
`src/job/lock.ts` holds the job lock, the short events lock and the config lock, which
`src/core/config/edit.ts` holds while it changes `config.toml`, under `RELAY_HOME/locks/`, and
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

`src/cli/commands/accept-git-changes.ts` is `relay accept-git-changes`. It refuses to run without
a terminal, compares the git settings and hooks with the trust record through `reviewTrust()` in
`src/git/trust.ts`, and writes a new record only after the person types `yes`.
`test/checkpoint/accept-git-changes.test.ts` simulates the terminal, and
`test/checkpoint/tampering.test.ts` checks that a planted setting or hook stops relay and never
runs. `test/checkpoint/e2e.test.ts` builds the program with the build script of `package.json`
and runs it as a separate process through a whole job, reading the git commands it ran from the
runner's call log. The section "When relay refuses to run git" of `docs/checkpoints.md` shows the
messages.

## The handoff evaluation harness

`eval/handoff/` holds the opt-in evaluation of `add-handoff-evaluation`. It is a separate Bun
program, run with `bun run eval:handoff <command>`, and is never compiled into the `relay` binary.
Today it has its command line, its git runner, its JUnit reader, the fixture check, the four
fixture tasks, the plan files, the `plan` command and the checks that `run` makes before it starts.

```mermaid
flowchart TD
  script["package.json script eval:handoff"]
  home["$RELAY_EVAL_HOME<br/>targets.toml, campaigns/&lt;name&gt;/campaign.json"]

  subgraph eval["eval/handoff/"]
    main["src/main.ts<br/>the five commands and the usage text"]
    plan["src/plan.ts<br/>reads plans and targets.toml, lists the runs, estimates the time"]
    campaign["src/campaign.ts<br/>the run command so far, campaign.json"]
    guards["src/guards.ts<br/>CI, terminal, fixture, disk checks and the confirmation"]
    fixtures["src/fixtures.ts<br/>reads task.toml, runs check-fixtures"]
    junit["src/junit.ts<br/>counts passed and failed tests in JUnit XML"]
    gitrun["src/git.ts<br/>runs git without hooks or fsmonitor"]
    pyrunner["runners/unittest_junit.py<br/>runs Python tests and writes JUnit XML"]
    plans["plans/<br/>smoke.toml, standard.toml, full.toml"]
    tasks["tasks/<br/>rate-limiter, ledger-import, job-queue, markdown-toc:<br/>task.toml, task.md, .start/, .acceptance/, solution/"]
    etests["test/<br/>unit tests, golden/, data/junit/ and data/fixtures/"]
  end

  script --> main
  main -->|"plan"| plan
  main -->|"run"| campaign
  main -->|"check-fixtures"| fixtures
  plan -->|"reads"| plans
  plan -->|"reads expected minutes from task.toml"| tasks
  plan -->|"reads targets.toml"| home
  campaign -->|"expands the plan with"| plan
  campaign -->|"checks before asking yes"| guards
  campaign -->|"writes campaign.json"| home
  guards -->|"git status of the fixtures through"| gitrun
  fixtures -->|"copies .start/, solution/, .acceptance/ to a temporary folder"| tasks
  fixtures -->|"runs bun test, or Python tests through"| pyrunner
  fixtures -->|"reads the results with"| junit
  etests -->|"test"| main
```

The diagram shows the parts of the harness that exist so far. `bun run eval:handoff` starts
`src/main.ts`. `summarize` and `annotate` still print `Not built yet.`, and an unknown command
prints the usage text and exits with code 2.

`plan <plan>` reads a plan file from `plans/` through `src/plan.ts`, and the founder's
`targets.toml` from `$RELAY_EVAL_HOME` (by default `~/.relay-eval`), which maps each role of the
plan, such as `claude`, to one of his relay accounts. It expands the plan into the ordered list of
runs: all baselines first, then all handoffs, with repetition 1 of every run before any
repetition 2. It prints the number of runs, the accounts and the expected agent time, and starts
nothing. A role that `targets.toml` does not map stops it with exit code 3. The `full` plan has
four optional handoffs to the role `claude_second`, which it leaves out when that role is not
mapped.

`run <plan>` makes every check that must pass before the evaluation spends a subscription. It
refuses when `CI` is set or standard input is not a terminal, reads the plan and the targets, and
stops when an existing campaign's `campaign.json` records a different plan hash, when a fixture
has uncommitted changes, or when less than 1 GB is free. These checks live in `src/guards.ts`.
Then it names the companies and accounts that will receive the fixture code and the expected
time, and asks the founder to type `yes`. After a `yes`, `src/campaign.ts` writes `campaign.json`
for a new campaign. Running the runs comes in a later task group, so for now `run` then prints
`Not built yet.`

`check-fixtures` reads each task's `task.toml` through `src/fixtures.ts`. For each task it copies
the starting repository from `.start/` to a temporary folder, runs the visible tests, then adds the
hidden acceptance tests as `__acceptance__/` and runs them. It does the same again with the
reference solution from `solution/` copied over the start. Every run writes JUnit XML, which
`src/junit.ts` reads with Bun's `HTMLRewriter`. Python tasks write that XML through
`runners/unittest_junit.py`. A task is ready when its visible tests pass, enough acceptance tests
fail at the start, and every test passes with the solution. Three tasks are TypeScript on Bun and
`markdown-toc` is Python with only the standard library, and none needs an installation or the
network.

`src/git.ts` is the one place where the harness runs git. It turns off hooks and
`core.fsmonitor` and sets the author `relay eval`. Today the fixture check of `run` uses it; later
task groups use it for the scratch repositories.

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
