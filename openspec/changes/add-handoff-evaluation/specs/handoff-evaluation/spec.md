# Spec Delta

## Purpose

Measures, on real coding tasks and the founder's own provider accounts, whether a job handed off
with `relay switch` ends as well as a job one agent finished alone, so that automatic failover is
built only when the evidence supports it.

## ADDED Requirements

### Requirement: Fixture tasks with hidden acceptance tests
The evaluation SHALL ship at least three and at most five fixture tasks. Each task SHALL have a
starting repository, a task description with acceptance criteria shown to the agent, acceptance
tests the agent never sees, a reference solution, the command that runs its visible tests, and the
minimum number of acceptance tests that fail on the starting repository.

#### Scenario: Fixture check passes
- **WHEN** the founder runs `bun run eval:handoff check-fixtures`
- **THEN** for every task the visible tests pass on the starting repository, at least the declared minimum of acceptance tests fail on the starting repository, and every visible and acceptance test passes on the starting repository with the reference solution applied
- **AND** the command prints `<task> is ready.` for each task, then `All <n> fixtures are ready.` when it checked more than one, and exits with code 0

#### Scenario: A reference solution fails its acceptance tests
- **WHEN** an acceptance test fails on a task's reference solution
- **THEN** the command prints `Fixture <task>: the reference solution fails <n> acceptance tests.` and the names of those tests, and exits with code 1

#### Scenario: A fixture needs no installation or network
- **WHEN** a fixture's visible or acceptance tests run on a machine that has only `bun`, `python3` and `git`
- **THEN** they run without installing packages and without network access

### Requirement: Acceptance tests stay hidden from agents
The harness SHALL give agents only a scratch copy of the starting repository, created outside the relay repository, with the task description in `.relay/task.md`. Acceptance tests and reference solutions SHALL run only on an exported copy of a checkpoint, never in a directory an agent works in.

#### Scenario: Scratch repository contents
- **WHEN** the harness prepares a run
- **THEN** the scratch repository under `$RELAY_EVAL_HOME/work/<run-id>/repo` contains the starting repository files and no acceptance test, reference solution or path to the relay repository

#### Scenario: An agent reaches the fixture sources
- **WHEN** an event recorded during a run contains the path of the relay repository's `eval/handoff/tasks` directory
- **THEN** the run's status is `contaminated`, it is excluded from the summary rules, and the summary lists it under the runs that need a look

### Requirement: Plans expand into a fixed list of runs
A plan file SHALL name tasks, target roles, interrupt points and a repetition count. The harness SHALL expand it into the same ordered list of runs every time, with one stable run ID per run, baselines before handoffs and repetition 1 of every cell before any repetition 2.

#### Scenario: Plan preview runs nothing
- **WHEN** the founder runs `bun run eval:handoff plan standard`
- **THEN** the harness prints the number of baselines and handoffs, the targets each role maps to and the expected agent time, starts no agent, and exits with code 0

#### Scenario: Stable run IDs
- **WHEN** the same plan is expanded twice
- **THEN** both expansions list the same run IDs in the same order, for example `ledger-import__handoff__claude-to-codex__steps-50__r2`

#### Scenario: A campaign resumes
- **WHEN** the founder runs a plan again with the same campaign name
- **THEN** the harness skips every run that already has a `result.json` and continues with the first run that has none

#### Scenario: The plan changed during a campaign
- **WHEN** the plan file's content hash differs from the hash recorded when the campaign started
- **THEN** the harness prints `The plan standard changed since this campaign started. Start a new campaign with --campaign <name>.` and exits with code 3

### Requirement: The evaluation never runs without the founder's confirmation
The `run` command SHALL refuse to start when the `CI` environment variable is set or when standard input is not a terminal. Before the first run of a session it SHALL print the companies and accounts that will receive the fixture code and the expected agent time, and start only after the founder types `yes`.

#### Scenario: Run inside CI
- **WHEN** `bun run eval:handoff run smoke` starts with `CI` set to any value
- **THEN** it prints `The handoff evaluation uses real subscriptions, so it never runs in CI.` and exits with code 4 without starting relay

#### Scenario: No terminal
- **WHEN** the `run` command starts with standard input that is not a terminal
- **THEN** it prints `Run this in a terminal. The evaluation asks you to confirm before it starts.` and exits with code 4

#### Scenario: The founder declines
- **WHEN** the founder answers anything other than `yes` at the confirmation
- **THEN** the harness prints `Nothing ran.` and exits with code 4

### Requirement: Baseline runs
For each task and starting target the harness SHALL run the task with one agent and no interruption, count its steps, and snapshot the working tree after every step so that the same measurements can be taken at any point of the run afterwards.

#### Scenario: A baseline completes
- **WHEN** a baseline run's agent ends
- **THEN** the result records the total number of steps, the wall-clock time, the usage the provider reported, the acceptance test results on the final checkpoint, and for 25, 50 and 75 percent of its own steps the acceptance results and rework measured from that step's snapshot

#### Scenario: What counts as a step
- **WHEN** the event log records a `command_ran` event (the agent finished a shell command) or a `file_changed` event (the agent modified files)
- **THEN** the harness counts one step

### Requirement: Interrupt points
A handoff run SHALL interrupt the first agent at a point named in the plan: `steps:25`, `steps:50` or `steps:75` (that share of the median step count of the completed baselines for the same task and starting target), `event:first-test-run` (the first visible test run after at least one file edit) or `event:untested-edit` (the first file edit at or after half of that median).

#### Scenario: Interrupt at half of the steps
- **WHEN** the baselines for a task and target have a median of 28 steps and the point is `steps:50`
- **THEN** the harness switches right after the 14th step and records both the target step and the step count at the moment relay stopped the agent

#### Scenario: Baselines are missing
- **WHEN** a handoff run needs a step count and no completed baseline exists for its task and starting target
- **THEN** the harness prints `Run the baselines for <task> on <target> first. The handoff point depends on them.` and exits with code 3

#### Scenario: The agent finishes first
- **WHEN** the first agent ends before the interrupt point is reached
- **THEN** the run's status is `finished_before_interrupt`, no handoff happens, and the run is reported separately and excluded from the handoff rules

### Requirement: Handoffs go through relay switch
At the interrupt point the harness SHALL hand the job to the plan's next target with `relay switch`, using relay's default context tiers, and SHALL answer only relay's own first-handoff question, never an agent's permission prompt.

#### Scenario: Successful handoff
- **WHEN** `relay switch` exits with code 0
- **THEN** the result records the handoff checkpoint, the time `relay switch` took, the time until the next agent's first step, relay's own claim mismatches, and copies of the handoff prompt, `checkpoint.md` and, once the next agent ends, `verify.md`

#### Scenario: Failed handoff
- **WHEN** `relay switch` exits with a non-zero code
- **THEN** the run's status is `handoff_failed`, the result records the exit code and relay's error text, the acceptance tests run on the last checkpoint, and the run counts against the reliability rule

#### Scenario: A bypass flag appears
- **WHEN** the `argv` of a `worker_started` event contains `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `bypassPermissions` or `danger-full-access` (Codex's `--sandbox danger-full-access` or `sandbox_mode="danger-full-access"`)
- **THEN** the harness stops the job, records a safety violation, prints `relay started an agent with a permission bypass flag. Stopped.` and exits with code 1

### Requirement: Outcome measurements
For every run the harness SHALL measure on the final checkpoint: acceptance and visible tests passed, wall-clock time, steps, usage where reported, files and lines the next agent reworked, acceptance tests that passed at the handoff and failed at the end, and claims found false.

#### Scenario: Acceptance tests run on an exported checkpoint
- **WHEN** an agent ends
- **THEN** the harness takes a final checkpoint with relay, exports that commit with `git archive` to a temporary directory, adds the acceptance tests there, runs them, and records passed, failed and total counts with the name of each failing test

#### Scenario: Rework
- **WHEN** the next agent removes or rewrites a line the first agent added before the handoff
- **THEN** that line counts in `lines_reverted` and its file appears in `files_reworked`

#### Scenario: Regression
- **WHEN** an acceptance test passes on the handoff checkpoint and fails on the final checkpoint
- **THEN** its name appears in the run's `regressions` list

#### Scenario: Claims found false
- **WHEN** relay's own check reports a mismatch, or a row of `.relay/verify.md` says a claim does not hold
- **THEN** it counts in `claims_found_false`; rows marked unclear count in `claims_unverified`; a missing `verify.md` sets `verify_written` to false

#### Scenario: Usage not reported
- **WHEN** the event log holds no usage for a worker
- **THEN** that segment's usage is recorded with source `not reported` and null numbers, and the summary shows `not reported` instead of zero

### Requirement: Safety guarantees are checked on every run
Before each run the harness SHALL record the scratch repository's `main` tip, its reflog, a hash of its index and a hash of a file with uncommitted changes, and after the run SHALL check that all four are unchanged.

#### Scenario: relay changed the person's checkout
- **WHEN** any of the four differs after the run
- **THEN** the result lists each difference under `safety.violations` and the summary's verdict for that direction is to fix relay first

### Requirement: One result file per run
The harness SHALL write `$RELAY_EVAL_HOME/campaigns/<campaign>/runs/<run-id>/result.json` with schema version 1 when a run ends, together with the artifacts named in the design. Runs stopped by the founder, by a provider limit or by a harness error SHALL be written as `attempt-<n>.json` and stay pending.

#### Scenario: A provider limit interrupts a run
- **WHEN** a worker ends because its account reached a limit
- **THEN** the attempt is saved, the run stays pending, the harness prints `<target> reached its limit. It resets at <time>. Run the same command again after that.` and exits with code 5

#### Scenario: The founder presses Ctrl-C
- **WHEN** the founder interrupts the harness
- **THEN** the harness interrupts the `relay run` process it started (relay ends the worker through its adapter), saves the attempt with status `stopped_by_person`, prints `Stopped. This run will start again next time.` and exits with code 130

### Requirement: Summary table and verdict
The `summarize` command SHALL build `summary.md` and `summary.csv` from a campaign's result files: one row per task, run kind, direction and interrupt point; the six decision rules per handoff direction with their numbers; a verdict per direction; and the runs that need a look.

#### Scenario: All rules pass
- **WHEN** every rule passes for Claude to Codex
- **THEN** `summary.md` says `Claude to Codex: build failover. All six rules pass.`

#### Scenario: A quality rule fails
- **WHEN** safety and reliability pass but another rule fails for a direction
- **THEN** the verdict for that direction is `improve the handoff first` and names each failing rule with its measured value and threshold

#### Scenario: A safety rule fails
- **WHEN** any run in a direction has a safety violation or the reliability rule fails
- **THEN** the verdict for that direction is `fix relay first`

#### Scenario: Too few runs for a verdict
- **WHEN** a direction has fewer than 9 counted handoff runs at step points
- **THEN** its verdict is `not enough runs yet (<n> of 9)` and no rule is applied to it

#### Scenario: Counts, not only percentages
- **WHEN** the summary shows a rate
- **THEN** it also shows the counts it comes from, for example `11 of 12`

### Requirement: The harness is tested without real providers
The harness's own tests SHALL run with `bun test ./eval/handoff/test` and SHALL never start a real provider; the end-to-end test SHALL use relay's fake agents.

#### Scenario: End-to-end test with fake agents
- **WHEN** the end-to-end test runs the smoke plan against relay configured with fake agents
- **THEN** it writes two result files with status `completed`, no safety violation, and a summary, and the scratch directories are removed
