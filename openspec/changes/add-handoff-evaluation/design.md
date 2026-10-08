# Design

## Context

See proposal.md for why this evaluation exists and which recommendations it asks Josué to approve.
The requirements are in `specs/handoff-evaluation/spec.md`. This document explains how to build the
harness and the fixtures so that the loop can implement them without guessing.

The current state and the constraints that shape the design:

- When this change is built, phases 1 to 5 exist: the `relay` binary (TypeScript on Bun), the
  checkpoint engine, the Claude Code and Codex adapters with fake agents, `relay switch`, and the
  daemon with its event log. The harness uses them only through the `relay` command and the files
  relay writes, so it measures exactly what the founder will use.
- Real providers cost real subscription usage. Research puts them only in "a separate, opt-in
  evaluation" (`docs/research/architecture.md`, section 9, items 6 and the summary at the top).
- The founder's agents are signed in on his Mac, which has almost no free disk
  (`AGENTS.md` at the repository root). The evaluation runs on the Mac
  because that is where the accounts live. The fixtures therefore need no package installation:
  only `bun` (1.3.6 on the Mac today), `python3` and `git`. The harness's own unit tests can run
  on the Omarchy machine like every other test.
- Agents do not behave the same way twice, so each measured cell runs at least three times
  (`architecture.md`, section 5, "Repetition").

Two terms used throughout:

- A **step** is one finished agent action that relay records in the event log: a shell command
  that finished, or a file that was modified.
- A **campaign** is one execution of a plan, stored in its own directory. Running the same command
  again with the same campaign name continues it.

## Goals / Non-Goals

**Goals:**

- One command shows what a plan will cost; another runs it, can stop at any time and continues
  where it stopped.
- Every run leaves a self-contained result file that can be read without the harness.
- The summary gives a clear, rule-based answer per handoff direction, with the counts behind it.
- The harness itself is fully tested without real providers.

**Non-Goals:**

- Statistical significance. With 3 repetitions and 4 tasks the evaluation detects large effects
  only; the rules have wide margins for that reason.
- Judging code quality beyond the acceptance tests. The founder reads the flagged runs himself.
- Measuring desktop apps or sessions relay did not start.

## Decisions

### 1. The harness is a Bun script in `eval/handoff/`, not a `relay` subcommand

The harness runs with `bun run eval:handoff <command>` (a script in the root `package.json`:
`"eval:handoff": "bun run eval/handoff/src/main.ts"`). It is never compiled into the `relay`
binary.

- Why: a `relay eval` command would ship code that spends a user's subscription to every user,
  and would need relay's internals instead of its public behaviour. Research keeps the evaluation
  "separate from the test suite because it uses real providers" (`architecture.md`, section 5).
- Alternative considered: a shell script. Rejected because the harness parses JSON, TOML and JUnit
  XML and computes line overlaps; TypeScript on Bun is the project's runtime (ROADMAP decision
  "Runtime for the daemon and CLI", pending, recommended Bun).

### 2. The harness drives relay as a black box, through one module

Every relay command the harness runs is in `eval/handoff/src/relay-cli.ts`, and every event type
it reads is a constant in `eval/handoff/src/events.ts`. The binary is `$RELAY_BIN`, or `relay` on
`PATH`. The harness uses the founder's normal `RELAY_HOME`, because his account profiles live
there (`docs/research/security.md`, section 2). Each evaluation job is titled `eval <run-id>`, so it
is easy to recognise in `relay status`.

#### Interfaces the harness needs from relay

Reconciled on 2026-10-07 with the phase 1 to 5 changes, and checked again on 2026-10-08 (task 1.1),
when no name had changed. Each row names the change and the spec or design decision that defines
it; none of them needs a new relay command.

| What the harness needs | Command or file | Defined in |
|---|---|---|
| relay's version for the record | `relay --version` prints `relay <version>` | `add-cli-scaffold`, `cli-commands` "Version" |
| Set up the scratch project | `relay init --title "eval <run-id>"`, exit code 0 | `add-checkpoint-engine`, `job-files` |
| A checkpoint without stopping the agent | `relay checkpoint -m <text> --json` prints `{"saved", "number", "commit", "ref", "files_changed", "left_out"}`, or `{"saved": false, "latest": <n>}` when nothing changed (then the harness uses the commit of checkpoint `<n>` from `relay checkpoints --json`) | `add-checkpoint-engine`, `checkpoints` "Listing checkpoints" |
| Start a headless worker | `relay run <target> --headless --prompt "<text>" --json`, kept running by the harness: it prints each worker event as one JSON line and exits when the agent ends. The job ID is `job_id` in `.relay/state.json`; the worker ID is in the `worker_started` event | `add-provider-adapters`, `agent-runs` "Command line" and "Headless progress output" |
| Facts about the job | `<workdir>/.relay/events.jsonl`, one JSON object per line: `v`, `id`, `ts`, `job`, `type`, `actor`, `data` | `add-checkpoint-engine`, `job-files` "events.jsonl format" |
| Steps | `type: "command_ran"` with `data.command` and `data.exit_code`; `type: "file_changed"` with `data.paths` | `add-provider-adapters`, design decision 16 |
| Worker start and end | `worker_started` with `data.worker_id`, `data.target` and `data.argv`; `worker_session_identified` with `data.model`; `worker_ended` with `data.end_reason` and `data.exit_code`; why a worker stopped comes from its last `turn_failed` (`data.reason`) | `add-provider-adapters`, design decision 16 |
| Usage | `turn_completed` with `data.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`) and `data.cost_usd_estimate` | `add-provider-adapters`, design decision 16 |
| Handoff | `relay switch <target> --yes --json` prints `{"handoff_id", "checkpoint_sha", "prompt_path", "to_worker_id", "outcome", "notes_source", "mismatches"}`; `--yes` answers only relay's own questions. On a headless job the `relay run` that supervises the agent performs the switch and then supervises the next agent | `add-relay-switch`, `agent-switch` "JSON result" and "Switching an agent that runs under relay run elsewhere" |
| relay's own claim check | the `handoff` event's `data.claims_count` and `data.mismatches` (a list of `{claim, found}`) | `add-relay-switch`, design decision 20 |
| The next agent's verification | `<workdir>/.relay/verify.md`, a Markdown table with the columns Claim, Holds (`yes`, `no` or `unclear`) and Evidence | `add-relay-switch`, `handoff-content` "Verification file" |
| Stop a worker | send `SIGINT` to the `relay run` process the harness started: relay interrupts the turn through the adapter and exits with code 130; a second `SIGINT` stops the agent at once | `add-provider-adapters`, `agent-runs` "Interrupting a headless run with Ctrl+C" |
| Account state | `relay status --json`, run in the scratch repository because it answers only inside a relay project, with `accounts[]`: `target`, `availability.status`, `availability.retry_at` and `usage[].used_percent` | `add-daemon-api-and-status`, `status-command` "JSON mode" |

The `handoff` event and `verify.md` come from `architecture.md`, section 5, "Making the next agent
check the previous agent's claims" (layers 2 and 3).

The prompt the harness gives the first agent is `Do the task described in .relay/task.md. Run the
tests before you finish.` (`PROMPT` in `eval/handoff/src/runner.ts`).

### 3. Four fixture tasks

Each task takes an agent roughly 15 to 30 minutes, touches several files, and has a plan with more
than one stage, so that interrupting it at 25, 50 or 75 percent leaves real work in progress. All
four need no dependencies and no network. Three are TypeScript on Bun; one is Python with only the
standard library, so the handoff is not tuned to one language.

Every starting repository contains the same three agent files: `AGENTS.md` (how to run the tests;
do not add dependencies; do not use the network), `CLAUDE.md` containing the single line
`@AGENTS.md` (Claude Code's documented import, so both agents read the same rules), and
`.claude/settings.json` (decision 13). It also contains `NOTES.md`, which the harness uses to
check that relay leaves the person's uncommitted work alone (decision 9).

#### Task `rate-limiter`: fix a refill bug and make time injectable (TypeScript, about 15 minutes)

Starting repository: `src/bucket.ts` (class `TokenBucket(capacity, refillPerSecond)` with
`tryTake(n = 1): boolean`, using `Date.now()`), `src/limiter.ts` (class `KeyedLimiter` keeping one
bucket per key in a `Map` that never shrinks, with `check(key): boolean`), and
`test/bucket.test.ts`. The bug: refill rounds down to whole tokens and then resets the refill time,
so fractional tokens are lost and the effective rate drifts below the configured rate.

Acceptance criteria shown to the agent (`task.md`):

1. Refill is exact: over any period a bucket allows at most `capacity + rate × elapsed seconds`
   requests, and fractional tokens carry over between calls.
2. Both classes accept an optional `clock` (`{ now(): number }`, milliseconds); the default uses
   `Date.now()`, so existing constructor calls keep working. `TokenBucket` takes it as a third
   constructor argument and `KeyedLimiter` as a `clock` field of its options object.
3. `KeyedLimiter` forgets a key that has not been checked for `idleMs` (an option, default 60000)
   and exposes `size`, the number of keys it tracks, as a read-only property like `Map.size`. The
   option `idleMs` is a field of the same options object.
4. `check(key)` returns `{ allowed: boolean; retryAfterMs: number }`; `retryAfterMs` is 0 when
   allowed and otherwise the time until one token is available, rounded up to a whole millisecond.
5. `tryTake(n)` with `n` larger than the capacity throws `RangeError("n exceeds capacity")`.

Acceptance tests (`.acceptance/limiter.test.ts`, 10 tests, at least 7 fail on the start):

1. With a capacity of 5 and a rate of 5 per second, 400 calls 150 ms apart starting at fake time 0
   are allowed exactly 304 times (`floor(5 + 5 × 59.85)`). The starting code allows fewer.
2. Fractional tokens carry over: a bucket emptied at time 0, at 5 per second, allows one call at
   300 ms and two calls at 600 ms (1.5 + 1.5 tokens). The starting code allows only one at 600 ms.
3. After one hour idle, a bucket allows exactly `capacity` calls in a row.
4. `new TokenBucket(5, 1)` without a clock works and allows 5 calls.
5. An allowed `check` returns `retryAfterMs: 0`.
6. An empty bucket at 3 per second returns `retryAfterMs: 334`.
7. A key unchecked for `idleMs` is gone: `size` drops by one.
8. A key checked just before `idleMs` is kept.
9. `tryTake(6)` on a capacity of 5 throws a `RangeError` with that message.
10. Two keys have independent buckets.

#### Task `ledger-import`: add CSV import to a ledger tool (TypeScript, about 25 minutes)

Starting repository: `src/money.ts` (`parseAmount("12.50")` returns 1250 cents, `formatAmount`),
`src/ledger.ts` (class `Ledger` with entries `{ date, amountCents, category, note }`, `add`,
`balanceByCategory`, load and save to `ledger.json`), `src/cli.ts` (commands `add` and
`balance`, run with `bun src/cli.ts`), and tests for money and ledger.

Acceptance criteria shown to the agent:

1. `bun src/cli.ts import <file.csv>` reads CSV as defined by RFC 4180: a header row with the
   columns `date`, `amount`, `category`, `note` in any order and any letter case; quoted fields
   with commas, doubled quotes and line breaks; LF or CRLF line endings; an optional final line
   break; and an optional UTF-8 byte order mark.
2. A row is valid when its date is a real calendar date written `YYYY-MM-DD`, its amount is an
   optional minus sign, digits and at most two decimals (no thousands separators), and its
   category is not empty. The note may be empty.
3. Import is all or nothing. If any row is invalid, nothing is added, the command prints one line
   per problem such as `line 4: invalid date "2026-02-30"` (physical line numbers; the header is
   line 1), and exits with code 1.
4. A row equal in all four fields to an existing entry, or to an earlier row of the same file, is
   skipped.
5. On success the command prints `Imported 12 entries, skipped 3 duplicates.` (with `1 entry` and
   `1 duplicate` in the singular) and exits with code 0.
6. The library exports `importCsv(ledger, text)`, which returns `{ imported, skipped }` or throws
   an `ImportError` whose `errors` is a list of `{ line, message }`.

`task.md` also names the module (`src/import.ts`), says that `importCsv` is synchronous and accepts
the same text as the command, including a leading byte order mark, gives the exact error messages (`invalid date "<value>"`, `invalid amount "<value>"`, `empty category`) and
says that errors go to standard error, so the hidden tests check nothing the agent was not told.

Acceptance tests (`.acceptance/import.test.ts`, 15 tests, at least 12 fail on the start): a quoted
field with a comma; a doubled quote; a line break inside quotes shifts later line numbers; CRLF
input; a byte order mark; reordered and upper-case headers; `2026-02-30` is reported on the right
line; `1,000.00` is rejected; `-3.5` imports as -350 cents; an invalid row leaves the ledger
unchanged; a duplicate of an existing entry is skipped; a duplicate within the file is skipped; the
command's success text and exit code 0; the command's error lines and exit code 1; the singular
wording.

#### Task `job-queue`: retries, a dead-letter list and crash-safe persistence (TypeScript, about 30 minutes)

Starting repository: `src/queue.ts` (class `JobQueue`, in memory: `enqueue(type, payload)`
returns an ID, `runNext(handlers)` runs the oldest queued job, statuses `queued`, `running`,
`done`, `failed`, and `get(id)`), and `test/queue.test.ts`.

Acceptance criteria shown to the agent:

1. A failed job is retried. Options `maxAttempts` (default 3), `baseDelayMs` (default 1000) and
   `maxDelayMs` (default 60000). After failed attempt `k`, the job may run again after
   `min(maxDelayMs, baseDelayMs × 2^(k-1)) × (0.5 + random() / 2)` milliseconds, where `random`
   and `now` are injectable options. A job is never run before that time.
2. After `maxAttempts` failures the job's status is `dead` and it keeps the last error message;
   `deadLetters()` lists dead jobs. The status `failed` no longer exists.
3. `JobQueue.open(path, options)` loads the queue from a JSON file and saves after every change.
   A save writes `<path>.tmp` and renames it over `<path>`, so the file is never half written.
4. A job saved as `running` (the process stopped during the job) is `queued` again after `open`,
   with its attempt count unchanged.
5. `stats()` returns the number of jobs per status: `queued`, `running`, `done`, `dead`.
6. A job whose type has no handler fails with the error `no handler for type <type>`.
7. IDs stay unique after reopening the file.

`task.md` also lists the fields of a job (`status`, `attempts`, `runAt`, `lastError`), says that
`open` returns the queue synchronously and saves before a handler runs, and says which job
`runNext` picks, because the hidden tests read these fields and reopen the file inside a handler.

Acceptance tests (`.acceptance/queue.test.ts`, 12 tests, at least 10 fail on the start): the delay
schedule with `random` returning 1, and with `random` returning 0; the cap at `maxDelayMs`; no run
before the retry time; `dead` after `maxAttempts` with the last error; `deadLetters()`; a round
trip through the file; no `.tmp` file left after a save and the file always parses; `running`
becomes `queued` on open; `stats()`; the missing-handler error; unique IDs after reopening.

#### Task `markdown-toc`: a table of contents generator (Python standard library, about 20 minutes)

Starting repository: package `toc/` with `headings.py` (`extract_headings(text)` returns
`Heading(level, title)` for `#` headings only), `render.py` (`render_toc(headings)` returns a
bullet list with anchors made by lower-casing and replacing spaces), `__main__.py` (`python3 -m toc
FILE` prints the table of contents), and `tests/test_headings.py`, `tests/test_render.py`.

Acceptance criteria shown to the agent:

1. Setext headings (`Title` followed by `===` for level 1 or `---` for level 2) are recognised, and
   closing hashes of `#` headings (`## Title ##`) are removed.
2. Headings inside fenced code blocks (``` or ~~~, at least three characters, closed by the same
   character at least as long) are ignored.
3. Anchors follow GitHub's rules: lower case; characters other than letters, digits, spaces,
   hyphens and underscores removed (letters outside ASCII are kept); spaces become hyphens; the
   second and later uses of the same anchor get `-1`, `-2` and so on.
4. `python3 -m toc FILE --max-depth N` keeps levels up to N.
5. `python3 -m toc FILE --write` replaces the text between `<!-- toc -->` and `<!-- tocstop -->`,
   keeps both markers, and running it twice gives the same file. Without the markers it prints
   `No <!-- toc --> marker in FILE` and exits with code 1.
6. Nested entries are indented by two spaces per level below the smallest level present.

`task.md` also says that `extract_headings` and `render_toc` keep their names and output format;
that a `#` inside a word, as in `## C#`, stays in the title; that fence lines may be indented by up
to three spaces; that every anchor is different, as on GitHub, so the titles `Usage`, `Usage` and
`Usage-1` get `usage`, `usage-1` and `usage-1-1`; that `--write` prints nothing; and that the
missing-marker message goes to standard error with FILE written as the path was given.

Acceptance tests (`.acceptance/test_toc.py`, 13 tests, at least 9 fail on the start): setext level
1 and level 2; closing hashes; a heading inside a backtick fence; a heading inside a tilde fence; a
longer closing fence; punctuation removed from anchors; non-ASCII letters kept; duplicate anchors
numbered; `--max-depth 2`; `--write` between markers; `--write` twice is identical; the missing
marker error and exit code 1; indentation relative to the smallest level.

### 4. How a fixture is stored and checked

```
eval/handoff/tasks/<task-id>/
  task.toml        metadata (below)
  task.md          goal and acceptance criteria; copied to .relay/task.md in the scratch repository
  .start/          the starting repository, copied as is
  .acceptance/     hidden acceptance tests
  solution/        the reference solution: files that overwrite or add to .start/
eval/handoff/runners/unittest_junit.py   runs a unittest directory and writes JUnit XML
```

`task.toml`, read with Bun's built-in TOML support:

```toml
id = "ledger-import"
title = "Add CSV import to the ledger tool"
language = "typescript"                  # or "python"
expected_agent_minutes = 25
visible_test_command = ["bun", "test", "--reporter=junit", "--reporter-outfile={junit}"]
visible_test_match = "bun test"          # a command_ran event containing this text is a test run
acceptance_test_command = ["bun", "test", "--reporter=junit", "--reporter-outfile={junit}", "./__acceptance__"]
acceptance_total = 15
acceptance_fail_at_start_min = 12
```

For the Python task the commands are `["python3", "{runners}/unittest_junit.py", "{junit}",
"tests"]` and `["python3", "{runners}/unittest_junit.py", "{junit}", "__acceptance__"]`, and
`visible_test_match = "unittest"`. `{junit}` is a temporary file path and `{runners}` the absolute
path of `eval/handoff/runners/`.

The starting repository and the acceptance tests are in directories whose names start with a dot
because Bun's test runner skips such directories during discovery. Checked with Bun 1.3.6 on
2026-10-07: a bare `bun test` did not run a test file under a dot directory; `pathIgnorePatterns`
in `bunfig.toml` had no effect; an explicit path such as `bun test ./eval/handoff/test` still runs.
So relay's own `bun test` never runs fixture tests, and nothing depends on how phase 1 lays out
relay's tests.

`check-fixtures` (task 2.4) runs, for each task, in a temporary copy: the visible tests on
`.start/` (all must pass), the acceptance tests on `.start/` (at least
`acceptance_fail_at_start_min` must fail), then both on `.start/` with `solution/` copied over it
(all must pass, and the acceptance run must report `acceptance_total` tests). It touches no
provider, so CI may run it.

### 5. Steps and interrupt points

Research proposes interrupting at "roughly 25%, 50% and 75% of the baseline's checkpoints"
(`architecture.md`, section 5). A headless baseline makes few checkpoints, so the harness uses steps
instead, which are frequent and recorded by relay for every provider.

- `N` is the median `steps_total` of the completed baselines for the same task and starting target
  in the same campaign. The result records `N` and how many baselines it came from.
- `steps:P` switches right after step `k = max(1, round(P / 100 × N))`.
- `event:first-test-run` switches right after the first `command_ran` whose command contains
  `visible_test_match`, provided at least one `file_changed` came before it. It models an agent
  stopped right after its first check of its own work.
- `event:untested-edit` switches right after the first `file_changed` whose step number is at
  least `max(1, round(0.5 × N))`. Switching right after an edit means the edit was not tested yet,
  which models a limit reached in the middle of a step, the case where research expects tier 2
  context to matter (`architecture.md`, section 5, "What goes into the continuation prompt").

Events arrive while the agent keeps working, so the agent may finish one or two more steps before
relay stops it. The result records `interrupt_step_target` and `steps_at_switch`.

The harness reads `events.jsonl` by polling every 500 ms from the last byte offset it read, and
ignores a final line without a line break until it is complete, as recommended for growing files in
earlier research on agent session formats ("How relay can use these formats safely").

### 6. Per-step snapshots in baseline runs

`N` of a baseline is known only when it ends, so the harness cannot place checkpoints at 25, 50
and 75 percent during the run. Instead, after every step of a baseline, it snapshots the job's
working directory into its own ref, built with a temporary index exactly like relay's checkpoints
(`architecture.md`, section 4, "How a checkpoint commit is built without touching the user's
work"):

```
GIT_INDEX_FILE=$RELAY_EVAL_HOME/tmp/<run-id>.index git add -A
git write-tree
git commit-tree <tree> -p <previous snapshot or base commit> -m "eval step <n>"
git update-ref refs/relay-eval/steps/<n> <commit>
```

Every git command the harness runs goes through `eval/handoff/src/git.ts`, which adds
`-c core.hooksPath=/dev/null -c core.fsmonitor=false` and the author
`-c user.name="relay eval" -c user.email="eval@relay.invalid"` (`security.md`, section 4, "Run git
defensively"). After the baseline, the snapshots at `round(0.25 N)`, `round(0.5 N)` and
`round(0.75 N)` serve as control points: the harness measures acceptance tests and rework from them
exactly as it does from a handoff checkpoint. A snapshot can catch a file half written; this is
accepted and noted in Risks.

Snapshot 0 is taken before `relay run` starts, in baselines and handoffs alike. It holds the
starting tree with the person's uncommitted line in `NOTES.md`, and the rework diffs of decision 7
start from it instead of the base commit, so that line never counts as one an agent added. Both
rework diffs leave out relay's job files in `.relay/`.

### 7. Measurements

| Measure | How it is computed |
|---|---|
| Acceptance tests | Take a final checkpoint with `relay checkpoint --message "eval final" --json`; `git archive <sha> \| tar -x -C <tmp>`; run `visible_test_command`; copy `.acceptance/` to `<tmp>/__acceptance__/`; run `acceptance_test_command`; parse the JUnit XML with Bun's `HTMLRewriter` (`testcase` elements; a `failure` or `error` child means failed). Tests missing from the XML, for example when a file fails to load, count as failed up to `acceptance_total`. |
| Solved | All `acceptance_total` acceptance tests passed. Decided by the tests, never by the agent's final message, because "a finished turn is not a finished job" (earlier research on agent session formats). |
| Regressions | Handoff runs: names of acceptance tests that pass on an export of the handoff checkpoint and fail on the final one. Baselines: the same from each control snapshot. |
| Wall-clock time | Per segment, from `worker_started` to `worker_ended`; `switch_seconds` is how long `relay switch` ran; `next_first_step_seconds` is from the switch to the next worker's first step; `wall_seconds_total` is from `relay run` to the final checkpoint. |
| Steps | Count of step events per segment and in total. |
| Usage | From the `usage` and `cost_usd_estimate` fields of `turn_completed` events, which phase 3 fills from each tool's own report: Claude Code's `result` message (`usage` and `total_cost_usd`, an estimate, not a bill) and Codex's last token-usage update of the turn (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). The harness sums the turns of one segment. Overlapping Codex records are never added together (earlier research on agent session formats, "Usage, rate limits, and stop events"). Tokens are compared only within one provider. `used_percent` from `relay status --json` is sampled before and after each segment when relay reports it. |
| Rework | `git diff --unified=0 --no-renames --no-color --no-ext-diff <base> <handoff>` gives the lines the first agent added, as line ranges in the handoff version; `git diff ... <handoff> <final>` gives the line ranges the next agent removed or replaced, in the same numbering. Their overlap per file is `lines_reverted`; files with any overlap are `files_reworked`; a deleted file counts all its added lines. `rework_ratio = lines_reverted / lines_added_before`, or null when nothing was added. |
| Claims found false | `data.mismatches` of the `handoff` event plus rows of `verify.md` whose Holds column is `no`. Rows marked `unclear` are `claims_unverified`. `verify_written` is false when the file is missing or has no table. |
| Safety | See decision 9. |

### 8. Plans, targets and campaigns

Plans are committed in `eval/handoff/plans/` and name target roles, not accounts. The founder maps
roles to his own accounts once in `$RELAY_EVAL_HOME/targets.toml` (default
`~/.relay-eval/targets.toml`):

```toml
claude = "claude:personal"
codex = "codex:personal"
claude_second = "claude:startup"   # optional; only the full plan uses it
```

`eval/handoff/plans/standard.toml`:

```toml
name = "standard"
repetitions = 3
max_minutes_per_segment = 120
baseline_roles = ["claude", "codex"]

[[handoffs]]
task = "ledger-import"
from = "claude"
to = "codex"
points = ["steps:25", "steps:50", "steps:75"]

[[handoffs]]
task = "job-queue"
from = "claude"
to = "codex"
points = ["steps:25", "steps:50", "steps:75"]

[[handoffs]]
task = "rate-limiter"
from = "codex"
to = "claude"
points = ["steps:25", "steps:50", "steps:75"]

[[handoffs]]
task = "markdown-toc"
from = "codex"
to = "claude"
points = ["steps:25", "steps:50", "steps:75"]
```

Baselines run every task listed in `[[handoffs]]` on every role in `baseline_roles`, because the
quality and reuse rules compare a handoff with both agents working alone.

A `[[handoffs]]` entry may say `optional = true`: it is left out when `targets.toml` does not map
both of its roles. The `full` plan uses it for its four handoffs to `claude_second`. Any other
role that `targets.toml` does not map stops `plan` and `run` with exit code 3.
A plan is invalid (exit code 2) when a handoff starts from a role that `baseline_roles` does not
list, because its interrupt point needs those baselines; when two entries or points expand to the
same run ID; or when a task name is not made of lower-case letters, digits and hyphens.

| Plan | Runs | Expected agent time | Purpose |
|---|---|---|---|
| `smoke` | 2: `rate-limiter` baseline on `claude`, then one handoff `claude` to `codex` at `steps:50` | about 35 minutes | Prove the harness works on real accounts |
| `standard` | 60: 24 baselines (4 tasks, 2 roles, 3 repetitions) and 36 handoffs (2 tasks per direction, 3 points, 3 repetitions) | about 25 hours | The decision |
| `full` | 144: 24 baselines and 120 handoffs (both directions on every task, the 3 step points and both event points, 3 repetitions), plus 12 handoffs `claude` to `claude_second` at `steps:50` when that role is mapped | about 63 hours, 68 with the same-provider runs | More evidence, if the standard result is close |

The expected time is the sum of `expected_agent_minutes`, multiplied by 1.2 for handoff runs. For
the same-provider handoffs, the `claude` baselines also serve as the "next agent alone" comparison,
since both accounts run the same model.

Run IDs are `<task>__baseline__<role>__r<n>` and `<task>__handoff__<from>-to-<to>__<point>__r<n>`,
with the colon of a point written as a hyphen (`steps-50`, `event-untested-edit`). Order:
baselines first, then handoffs; within each group, repetition 1 of every cell, then repetition 2,
then 3, so that a campaign stopped halfway still covers every cell; within a repetition, plan order.

A campaign lives in `$RELAY_EVAL_HOME/campaigns/<campaign>/`. The default name is
`<YYYY-MM-DD>-<plan>` on the day it starts. `campaign.json` records the plan name, the SHA-256 of
the plan file, the role-to-target mapping of every role the plan uses, the start time and the tool
versions at the start (`relay`, `claude` and `codex` from their `--version`, which starts no agent;
null for a program that is missing or fails). Continuing a campaign stops with exit code 3 when
the plan's hash or the mapping in `targets.toml` differs from the record.

### 9. Scratch repositories and the safety check

For each run the harness:

1. Creates `$RELAY_EVAL_HOME/work/<run-id>/repo`, fills it from the committed `.start/` with
   `git archive HEAD:eval/handoff/tasks/<task>/.start | tar -x`, and runs `git init -b main`,
   `git add -A` and one commit `fixture <task> at <task_version>`. Exporting the commit, not
   copying the folder, keeps out files git ignores, such as a local
   `.claude/settings.local.json` that would widen the agent's permissions, or `node_modules`. With
   `--allow-dirty-fixtures` it copies only the files `git ls-files --cached --others
   --exclude-standard` lists in that folder.
2. Appends `Uncommitted note from the person.` to `NOTES.md` without committing it. This stands for
   the person's uncommitted work.
3. Runs `relay init`, writes `task.md` to `.relay/task.md`, and checks that
   `git rev-parse --show-toplevel` equals the scratch path (earlier research on agent session formats,
   "relay must choose and verify the working directory").
4. Records `git rev-parse main`, the SHA-256 of `git reflog show --format=%H main`, the SHA-256 of
   the index entries (`git ls-files -s`), and the SHA-256 of `NOTES.md`. The index is compared by
   its entries, not by the bytes of `.git/index`, because the fixtures let agents run
   `git status`, which rewrites the index's stat cache without staging anything; a file staged
   or unstaged still changes the entries.

After the run it recomputes all four. Any difference is a safety violation, recorded with the
before and after values. This repeats, on real agents, the invariant that research asks relay's
own end-to-end tests to prove (`architecture.md`, section 4, "Rollback", last paragraph, and
section 9, item 4).

`task_version` is `git rev-parse HEAD:eval/handoff/tasks/<task>` in the relay repository. If
`git status --porcelain --ignored --untracked-files=all -- eval/handoff/tasks/<task>` is not empty
(ignored files count too), the harness refuses with
`The fixture <task> has uncommitted changes. Commit them so results can be traced to a version,
or pass --allow-dirty-fixtures.` (exit code 3); with the option it records `task_version` as
`dirty`.

After the result is written, the harness removes every worktree listed by `git worktree list
--porcelain` other than the scratch repository itself (`git worktree remove --force <path>`; these
are relay's job worktrees for this scratch repository only), then deletes
`$RELAY_EVAL_HOME/work/<run-id>`, unless `--keep-work` was given. Before each run it checks that
the file system holding `$RELAY_EVAL_HOME` has at least 1 GB free (parsed from `df -Pk`), and
otherwise stops with `Less than 1 GB free in <path>. Free space before running.` (exit code 3).

### 10. The result file

`$RELAY_EVAL_HOME/campaigns/<campaign>/runs/<run-id>/result.json`. Field names use
`snake_case`, like relay's event log. Abridged example of a handoff run:

```json
{
  "schema_version": 1,
  "run_id": "ledger-import__handoff__claude-to-codex__steps-50__r2",
  "campaign": "2026-10-12-standard",
  "plan": "standard",
  "task_id": "ledger-import",
  "task_version": "4b1d0c9e...",
  "kind": "handoff",
  "repetition": 2,
  "from_target": "claude:personal",
  "to_target": "codex:personal",
  "interrupt_point": "steps:50",
  "baseline_median_steps": 28,
  "baseline_runs_used": 3,
  "interrupt_step_target": 14,
  "steps_at_switch": 15,
  "status": "completed",
  "started_at": "2026-10-12T09:14:03Z",
  "ended_at": "2026-10-12T09:49:40Z",
  "wall_seconds_total": 2137,
  "steps_total": 31,
  "tools": { "relay": "0.1.0", "claude": "2.1.282", "codex": "0.160.0", "bun": "1.3.6", "git": "2.39.0", "python3": "3.11.3" },
  "base_sha": "...",
  "segments": [
    { "target": "claude:personal", "worker_id": "5d2e8f01", "model": "...", "started_at": "...", "ended_at": "...",
      "wall_seconds": 905, "steps": 15, "end_reason": "stopped_by_switch", "exit_code": 0,
      "usage": { "source": "turn_completed", "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_output_tokens": null, "cost_usd_estimate": 0 },
      "used_percent_before": 12, "used_percent_after": 19 },
    { "target": "codex:personal", "worker_id": "a41c7b09", "model": "...", "wall_seconds": 1180, "steps": 16, "end_reason": "exited", "exit_code": 0,
      "usage": { "source": "turn_completed", "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_output_tokens": 0, "cost_usd_estimate": null },
      "used_percent_before": null, "used_percent_after": null }
  ],
  "handoff": {
    "relay_exit_code": 0, "checkpoint_sha": "...", "switch_seconds": 38, "next_first_step_seconds": 51,
    "prompt_bytes": 6123, "claims_count": 7, "relay_mismatches": 1,
    "verify_written": true, "claims_found_false": 2, "claims_unverified": 1,
    "acceptance_at_handoff": { "passed": 4, "failed": 11, "total": 15 }
  },
  "outcome": {
    "final_checkpoint_sha": "...",
    "visible_tests": { "passed": 9, "failed": 0, "total": 9 },
    "acceptance_tests": { "passed": 14, "failed": 1, "total": 15, "failing": ["rejects thousands separators"] },
    "solved": false,
    "regressions": [],
    "lines_added_before": 212, "lines_reverted": 18, "rework_ratio": 0.085,
    "files_reworked": ["src/csv.ts"]
  },
  "control_points": null,
  "safety": { "ok": true, "violations": [], "bypass_flags_seen": false, "argv_recorded": true },
  "contamination": false,
  "notes": ""
}
```

A failed handoff also records relay's error text in `handoff.relay_error` (null otherwise).
A baseline has `to_target`, `interrupt_point` and `handoff` set to null, one segment, and
`control_points`, a list of three objects (`point`, `step`, `snapshot_sha`, `acceptance_at_point`,
`regressions`, `lines_added_before`, `lines_reverted`, `rework_ratio`, `files_reworked`).

`status` is one of:

| Status | Meaning | In the summary rules |
|---|---|---|
| `completed` | The run ended normally | Yes |
| `finished_before_interrupt` | The first agent ended before the interrupt point | Reported separately, excluded |
| `handoff_failed` | `relay switch` exited with a non-zero code | Yes, as a failed handoff and unsolved |
| `agent_failed` | A worker's last turn failed with a reason other than `usage_limit` or `rate_limit` (from `turn_failed`), its `relay run` exited with code 24, or the harness stopped it because of a permission bypass flag | Yes, unsolved |
| `timed_out` | A segment passed `max_minutes_per_segment`; the harness stopped it by interrupting its `relay run` process | Yes, unsolved |
| `contaminated` | An event referred to the fixture sources | Excluded, listed |
| `limit_reached`, `stopped_by_person`, `harness_error` | The run did not measure the handoff | Saved as `attempt-<n>.json`; the run stays pending (`harness_error` runs again only with `--retry-errors`) |

Artifacts next to `result.json`: `events.jsonl` (copy), `relay-run.log`, `relay-switch.log`,
`handoff-prompt.md`, `checkpoint.md`, `verify.md`, `visible-final.xml`, `acceptance-final.xml`,
`acceptance-handoff.xml` (or `acceptance-control-<point>.xml` for baselines). The harness never
copies provider transcripts, session files or anything under a profile directory.

`bun run eval:handoff annotate <campaign> <run-id> "<text>"` sets `notes`, for example to record
whether reworked files were reworked "for the same purpose", which research lists as the meaning of
rework but which a program cannot judge (`architecture.md`, section 5, "Metrics").

### 11. The summary and the decision rules

`bun run eval:handoff summarize <campaign>` writes `summary.md` and `summary.csv` in the campaign
directory and prints the verdict lines. It reads only result files, so it can be run at any time.

`summary.csv` has one row per run with these columns: `run_id, task_id, kind, from_target,
to_target, interrupt_point, repetition, status, solved, acceptance_passed, acceptance_total,
wall_minutes_total, first_minutes, next_minutes, steps_total, steps_at_switch, regressions,
lines_added_before, lines_reverted, rework_ratio, files_reworked, claims_found_false,
claims_unverified, verify_written, relay_exit_code, first_output_tokens, next_output_tokens,
safety_ok, contamination`.

`summary.md` has four parts:

1. A header: plan, campaign, runs complete out of planned, tool versions, and a warning if the
   `model` or a tool version changed between runs of the same target.
2. **Verdicts**, one line per handoff direction, for example `Claude to Codex: build failover. All
   six rules pass.`, `Codex to Claude: improve the handoff first. Reuse rule: 0.84, needs at most
   0.75.`, or `fix relay first`. A direction with fewer than 9 counted handoff runs at step points
   gets `not enough runs yet (<n> of 9)`.
3. **Outcomes**: one row per task, run kind, direction and point, with the columns Runs, Solved,
   Acceptance passed (mean percent), Median minutes, Median next-agent minutes, Rework (median
   ratio), Regressions, False claims found, verify.md written, Failed handoffs. Every rate is shown
   with its counts, for example `11 of 12`. Usage columns show `not reported` when no run had it.
4. **Runs that need a look**: every run with a status other than `completed`, a safety violation,
   a regression, contamination or a claim found false, with a link to its directory.

The rules, per direction, over handoff runs at step points (event points and same-provider runs are
reported but not used, to keep the comparison the same as the standard plan). The counts in
proposal.md are these shares for 18 runs.

| Rule | Passes when |
|---|---|
| Safety | No counted run of that direction, and no baseline of its two targets, has a safety violation or a bypass flag. |
| Reliability | At least 94 percent of handoffs have `relay_exit_code` 0 (17 of 18). |
| Quality | Solved share of handoffs is at least `min(solved share of baselines of the first target, of the next target) − 0.10`, both baselines over the same tasks; and at most 12 percent of handoffs have a regression (2 of 18). |
| Reuse | For `steps:50` and `steps:75` together, the median `next_minutes` is at most 0.75 times the median wall time of the next target's baselines on the same tasks. |
| Rework | Median handoff `rework_ratio` at most the median baseline control `rework_ratio` at the same points plus 0.15. |
| Verification | `verify_written` in at least 88 percent of handoffs (16 of 18). |

Verdict: `build failover` when all six pass; `fix relay first` when safety or reliability fails;
otherwise `improve the handoff first`, naming each failing rule with its value and threshold. These
thresholds are the recommendation pending Josué's decision (proposal.md). Time is used only in the
reuse rule, because the alternative to failover is waiting for a limit to reset, which takes hours,
so a few extra minutes of handoff overhead do not matter; what matters is that the work done before
the switch is kept.

### 12. The command line

```
bun run eval:handoff plan <plan>
bun run eval:handoff run <plan> [--campaign <name>] [--only <run-id>] [--max-runs <n>]
                                [--retry-errors] [--keep-work] [--allow-dirty-fixtures]
bun run eval:handoff summarize <campaign>
bun run eval:handoff check-fixtures [<task-id> ...]
bun run eval:handoff annotate <campaign> <run-id> <text>
```

`<plan>` is a name in `eval/handoff/plans/` (`smoke`, `standard`, `full`) or a path to a TOML file.
Environment: `RELAY_EVAL_HOME` (default `~/.relay-eval`) and `RELAY_BIN` (default `relay`).

Output follows the voice of the design notes: short, plain, honest. `plan standard` prints:

```
Plan standard: 60 runs on claude:personal and codex:personal.
24 baselines and 36 handoffs, 3 repetitions each.
Expected agent time: about 25 hours, split between both accounts.
This uses your real subscription limits. Nothing has run.
```

`run` asks once per session:

```
This campaign sends the fixture repositories to Anthropic through claude:personal
and to OpenAI through codex:personal. The fixtures are synthetic code written for this test.
It uses your real subscription limits: about 25 hours of agent time for 60 runs.
Type yes to start:
```

During a run:

```
[12 of 60] ledger-import, handoff from claude:personal to codex:personal at 50% of steps, repetition 2
  Step 14 of about 28 on claude:personal. Switching.
  Continuing on codex:personal.
  Done in 36 min. Acceptance tests: 14 of 15 passed. 2 claims found false.
Saved result ledger-import__handoff__claude-to-codex__steps-50__r2.
```

Every 5 minutes without a new step it prints `Still working: <n> steps, <m> min.`, so a silent
agent is visible without being killed.

| Exit code | Meaning |
|---|---|
| 0 | All requested work is done |
| 1 | At least one run ended in `harness_error`, a fixture check failed, or a bypass flag was seen |
| 2 | Wrong arguments or an invalid plan or targets file |
| 3 | A precondition is missing: relay not found, a role not mapped, baselines missing, a dirty fixture, low disk, the plan changed during the campaign |
| 4 | Refused: `CI` is set, no terminal, or the founder did not type `yes` |
| 5 | Paused because a target reached its limit |
| 130 | Stopped with Ctrl-C |

Other messages: `relay was not found. Build it first or set RELAY_BIN.`; `The plan uses the role
codex, but <path>/targets.toml does not map it to an account.`; `<target> is not available
(<status>). It resets at <time>.` before a run, when `relay status --json` says the target is
limited (exit code 5).

### 13. Agent permissions in the fixtures

Each `.start/.claude/settings.json`:

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": ["Read", "Edit", "Write", "Glob", "Grep",
              "Bash(bun test:*)", "Bash(bun src/cli.ts:*)",
              "Bash(git status:*)", "Bash(git diff:*)", "Bash(ls:*)"]
  },
  "sandbox": { "enabled": true, "allowUnsandboxedCommands": false }
}
```

For `markdown-toc` the two `bun` entries are replaced by `Bash(python3 -m unittest:*)` and
`Bash(python3 -m toc:*)`. Claude Code honours `defaultMode` from a project's `.claude/settings.json`
for every value except `auto` and `bypassPermissions`, and `dontAsk` denies anything not
pre-approved (Claude Code permission modes page); a repository may switch the sandbox on
(sandboxing page, repository settings table). relay's Claude adapter passes its own
`--permission-mode acceptEdits --permission-prompts none` to headless workers
(`add-provider-adapters`, `claude-code-adapter` "Headless command line"), which wins over
`defaultMode`; anything that would prompt is denied, the allow list and the sandbox setting still
apply, and the harness records the flags from `argv`. For Codex, relay's adapter runs the app
server with the sandbox `workspace-write` and the approval policy `never` (or `codex exec -s
workspace-write` as its fallback), where `.git` stays read-only and the network is off
(`security.md`, section 5). This satisfies the conditions research sets for work without a
person watching (`security.md`, section 5): a separate repository, the sandbox on, a permission
mode that never needs a human, no permission upgrade at the handoff, and a time limit per segment.

### 14. Process handling

From earlier research on agent session formats, "Lessons from jstack":

- The harness starts `relay` with `Bun.spawn`, standard input set to `"ignore"`, and drains standard
  output and error continuously into the run's log files.
- It sets the working directory to the absolute scratch path for every command, never relying on
  the shell's current directory.
- It signals only the `relay` processes it started, and stops an agent only by sending `SIGINT` to
  the `relay run` process that supervises it, so relay ends the worker through its adapter. It
  never kills by process name or port.
- It records base, handoff and final commit SHAs and runs tests on exported commits, so a result
  always names the code it measured.
- The jstack runbook says "no time caps, never auto-kill". The evaluation differs on purpose: each
  segment has a cap (`max_minutes_per_segment`, 120 by default, about four times the longest
  expected task), because every extra minute spends the founder's subscription and a run that long
  has already failed. The cap is in the plan file, so the founder can raise it.

### 15. Testing the harness

All harness tests live in `eval/handoff/test/` and run with `bun test ./eval/handoff/test`. None
starts a real provider. Sample inputs live in `eval/handoff/test/data/`: an `events.jsonl` from a
fake run, Bun and Python JUnit files, a `verify.md`, recorded `relay ... --json` outputs, and a set
of result files for the summary test with a golden `summary.md`. The end-to-end test uses the fake
agent targets phase 3 provides and a temporary `RELAY_EVAL_HOME` with a `targets.toml` that maps
`claude` and `codex` to them.

## Risks / Trade-offs

- [Phases 2 to 5 change a name in decision 2's table before they are built] → All relay calls and
  event names are in two modules; task 1.1 checks the table again first, and a missing interface
  goes to its own phase.
- [Four tasks and three repetitions are a small sample] → The rules have wide margins, the summary
  shows counts next to every rate, and a close result can be checked with the full plan.
- [Agents are non-deterministic and models change during a campaign] → Repetitions, the recorded
  model and tool versions, and a warning in the summary when they change.
- [An agent finds the acceptance tests by searching the disk] → The scratch repository is outside
  the relay repository, and any event that mentions the fixture sources marks the run
  `contaminated`.
- [A per-step snapshot catches a file half written] → It affects only baseline control numbers by
  a line or two; the run's own outcome uses relay's final checkpoint.
- [Rework counts lines changed for a different purpose] → The founder reviews flagged runs and can
  record his judgment with `annotate`.
- [The evaluation spends a large share of the founder's subscription windows] → The plan preview
  and confirmation show the expected time; campaigns stop and resume; the harness stops at a limit
  instead of switching to another account.
- [`dontAsk` and the sandbox's automatic approval of sandboxed commands interact in an unexpected
  way] → The smoke plan shows it in the first run; the setting is in the fixture, not in relay.

## Migration Plan

Nothing to migrate. Rollout once phases 1 to 5 are merged:

1. `bun run eval:handoff check-fixtures`, then `bun test ./eval/handoff/test`.
2. Create `~/.relay-eval/targets.toml`, then run the smoke plan and read both result files.
3. Run the standard plan over several days, then `summarize`, and copy `summary.md` to
   `docs/evaluations/handoff-<date>.md`.
4. Josué decides on phase 7 from the verdicts.

Undoing the change means deleting `eval/handoff/`, the `eval:handoff` script and
`~/.relay-eval/`; nothing else depends on them.

## Open Questions

- Whether Claude Code reports `rate_limits` usage percentages in headless mode. The status-line data
  appears only in sessions with a status line (`architecture.md`, section 6). If it does not, the
  Claude columns show `not reported`, which changes no rule.
- Whether the founder wants the same-provider runs at all. They exist only in the full plan.
