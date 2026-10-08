# Spec Delta: agent-switch

## Purpose

`relay switch` hands a job from the agent working on it to another agent or another account, in a fixed order of steps that never loses work, and with a defined, reversible result when any step fails.

## ADDED Requirements

### Requirement: Command line
`relay switch <provider[:account]>` SHALL accept the options `--yes`, `--no-summary`, `--no-start`, `--json`, `--check <command>` (repeatable) and `--permission <level>`. A provider alone SHALL resolve to its only account, or else to `defaults.account` when that account belongs to the provider. Anything else SHALL be a usage error with exit code 2.

#### Scenario: Provider with one account
- **WHEN** `config.toml` defines only `codex:personal` among Codex accounts and the person runs `relay switch codex`
- **THEN** relay switches to `codex:personal`

#### Scenario: Provider with two accounts
- **WHEN** `codex:personal` and `codex:work` exist, `defaults.account` is `claude:personal`, and the person runs `relay switch codex`
- **THEN** standard error shows `relay: You have two Codex accounts: codex:personal, codex:work. Name one, for example relay switch codex:personal.` and relay exits with code 2

#### Scenario: Unknown account
- **WHEN** the person runs `relay switch codex:home` and no such account exists
- **THEN** standard error shows `relay: codex:home is not one of your accounts. Add it with relay account add codex home.` and relay exits with code 2

#### Scenario: Already the current account
- **WHEN** Codex · personal is working on the job and the person runs `relay switch codex:personal`
- **THEN** standard error shows `relay: Codex · personal is already working on this job.` and relay exits with code 2

#### Scenario: No agent ever worked on the job
- **WHEN** the job was set up with `relay init` and never run, and the person runs `relay switch codex:personal`
- **THEN** standard error shows `relay: No agent has worked on this job yet. Start one with relay run codex:personal.` and relay exits with code 3

### Requirement: Order of steps
A switch SHALL run these steps in this order: checks that change nothing, stop the current agent, save a checkpoint of the work, get the handoff notes, run the job's checks, build the handoff, scan it for secrets, write the job files, record the handoff in git, start the next agent.

#### Scenario: Events of a successful switch
- **WHEN** a switch from `claude:personal` to `codex:personal` succeeds, with notes from Claude Code and one check
- **THEN** the events appended to `.relay/events.jsonl` have these types in this order: `worker_ended`, `checkpoint_saved`, `handoff_notes`, `check_run`, `handoff`, `worker_started`

#### Scenario: The checkpoint holds the work as the agent left it
- **WHEN** the outgoing agent wrote `src/a.ts` and the job's check rewrites `test/__snapshots__/a.snap` when it runs
- **THEN** the work checkpoint contains the outgoing agent's `src/a.ts` and the snapshot file as it was before the check ran

### Requirement: Progress output
A successful switch SHALL print one line per step to standard output in plain words, using the agent's display name and the account name, and SHALL end with `Continuing on <display name>.`

#### Scenario: Switch from Claude Code to Codex
- **WHEN** Claude Code · personal is working, `codex:personal` is already allowed, Claude Code answers the notes request, the job's only check is `bun test`, and it reports 231 passed and 1 failed
- **THEN** standard output is exactly:
  ```
  Stopping Claude Code · personal
  Saved checkpoint 912ec1
  Asking Claude Code for handoff notes
  Ran bun test · 231 passed, 1 failed
  Found 1 difference between the notes and the repository
  Wrote .relay/checkpoint.md
  Starting Codex · personal
  Continuing on Codex.
  ```
- **AND** `912ec1` is the first six characters of the checkpoint commit
- **AND** relay exits with code 0 once the next agent has started

#### Scenario: Nothing changed since the last checkpoint
- **WHEN** the working tree matches the job's latest checkpoint `912ec1` when the agent stops
- **THEN** the second line is `Using checkpoint 912ec1 (no changes since it was saved)` and no new checkpoint ref is created

#### Scenario: No agent running
- **WHEN** the job's last agent already exited and the person runs `relay switch codex:personal`
- **THEN** no `Stopping` line is printed and the output starts with the checkpoint line

### Requirement: Nothing changes before the agent is stopped
Before stopping the current agent, relay SHALL finish every check and question that can refuse the switch: the account, the next agent's program and sign-in, mode and permission, the git trust check, the allow list, and changed instruction files. A refusal or a "no" SHALL leave the agent running and every file, ref and event unchanged.

#### Scenario: Next account not signed in
- **WHEN** `codex:personal` is not signed in and the person runs `relay switch codex:personal`
- **THEN** relay prints phase 3's not-signed-in message, exits with phase 3's exit code, and Claude Code is still running

#### Scenario: Git configuration changed by the agent
- **WHEN** the running agent added `core.fsmonitor` to `.git/config` and the person runs `relay switch codex:personal`
- **THEN** relay prints phase 2's git-safety report, exits with code 5, the agent is still running, and the planted command never ran

#### Scenario: Person answers no
- **WHEN** relay asks the first-handoff question and the person answers `n`
- **THEN** standard error shows `relay: Nothing changed. Claude Code · personal is still working.` and relay exits with code 7, and `captureState()` and the `.relay/` files are identical before and after

### Requirement: Stopping the current agent through its adapter
relay SHALL stop the outgoing agent through its adapter's `stop` operation (specified in `add-provider-adapters`): the tool's own interrupt for a headless agent, `SIGTERM` for an interactive one, and `SIGKILL` only when it is still running after `handoff.stop_timeout_seconds`. relay SHALL signal only the agent process it started and still holds, and SHALL record how the agent stopped.

#### Scenario: Interactive Claude Code stops on SIGTERM
- **WHEN** a fake interactive Claude Code exits with code 143 on `SIGTERM`
- **THEN** the `worker_ended` event has `end_reason` `stopped_by_switch`, `stop_how` `terminated` and `exit_code` 143

#### Scenario: An agent that ignores SIGTERM
- **WHEN** a fake agent ignores `SIGTERM` and `handoff.stop_timeout_seconds` is 5
- **THEN** relay sends `SIGKILL` after 5 seconds, records `stop_how` `killed`, and continues the switch

#### Scenario: Agent process whose relay run is gone
- **WHEN** the worker record names a live process with a matching start time but the `relay run` that started it is gone
- **THEN** relay sends no signal, prints `relay: Claude Code (process 4242) is still running, but the relay run that started it is gone. Stop it yourself, then try again.` and exits with code 33

#### Scenario: Terminal restored
- **WHEN** an interactive agent is stopped in the terminal of its `relay run`
- **THEN** relay leaves the alternate screen, shows the cursor and resets the terminal modes before printing its next line

### Requirement: Work checkpoint
Right after the agent stops, relay SHALL save a phase 2 checkpoint of kind `handoff` with the message `Handoff from <from account> to <to account>` and the trailers `Relay-Worker` and `Relay-Target`. When the working tree matches the latest checkpoint, relay SHALL use that checkpoint instead of saving a new one.

#### Scenario: Checkpoint trailers
- **WHEN** worker `5d2e8f01` on `claude:personal` is stopped for a switch to `codex:personal`
- **THEN** the new checkpoint commit's message has the subject `relay checkpoint 7: Handoff from claude:personal to codex:personal` and the trailers `Relay-Kind: handoff`, `Relay-Worker: 5d2e8f01` and `Relay-Target: claude:personal`

### Requirement: Starting the next agent
relay SHALL start the next agent through its adapter, with the account's profile folder, relay's instructions and the continuation prompt, in the job's worktree root. An interactive agent SHALL get the terminal of the process that runs the switch. A start SHALL count as failed when the program cannot start or exits with a non-zero code within `handoff.start_check_seconds`.

#### Scenario: Codex gets the right account and prompt
- **WHEN** the switch to `codex:personal` starts fake Codex with `RELAY_FAKE_RECORD` set
- **THEN** the recording shows `CODEX_HOME` set to the account's profile folder, no variable whose name starts with `ANTHROPIC_`, working directory equal to the worktree root, and a first prompt equal to the content of `RELAY_HOME/jobs/<job>/handoffs/<n>/prompt.md`

#### Scenario: Record of the new worker
- **WHEN** the next agent started
- **THEN** `.relay/state.json` has `current_worker` with the new worker ID and `from_handoff` equal to the handoff number, and the handoff's outcome is `started`

### Requirement: A failed start keeps the handoff ready
When the next agent does not start, relay SHALL keep the checkpoint, the job files and the handoff record, mark the handoff `start_failed`, set `current_worker` to null, append `handoff_failed`, print how to retry or go back, and exit with code 31. relay SHALL NOT restart the outgoing agent.

#### Scenario: Codex exits right away
- **WHEN** fake Codex exits with code 1 two seconds after starting
- **THEN** standard error shows:
  ```
  relay: Codex · personal did not start: codex exited with code 1 after 2 seconds.
  relay: Your work is saved in checkpoint 912ec1, and the handoff is ready.
  Run "relay run codex:personal" to try again, or "relay run claude:personal" to go back.
  ```
- **AND** relay exits with code 31

### Requirement: Failures after the stop are rolled back
When a step after the stop fails, relay SHALL keep the work checkpoint if it was saved, put back the `.relay/` files and delete the handoff ref it had written, append a `handoff_failed` event naming the step, leave the outgoing agent stopped, and say where the work is saved.

#### Scenario: Writing the job files fails
- **WHEN** writing `.relay/state.json` fails after `.relay/checkpoint.md` was replaced
- **THEN** both files have their content from before the switch, no ref `refs/relay/jobs/<job>/handoffs/<n>` exists, the last event is `handoff_failed` with `step` `write`, and relay exits with code 1

#### Scenario: Checkpoint refused by the secret scan
- **WHEN** the work diff contains a GitHub token
- **THEN** relay prints phase 2's finding, adds `relay: Claude Code is stopped. Nothing was sent to Codex.`, exits with code 4, and `.relay/state.json` has `current_worker` null

### Requirement: Recovery after a crash
A switch SHALL record each completed step in `RELAY_HOME/jobs/<job>/switch.json`. When `relay switch` or `relay run` finds that file and its process is gone, relay SHALL undo the files of an unrecorded handoff, keep a recorded one as ready, append `handoff_failed`, print what it did, and then continue with the command the person typed.

#### Scenario: Crash after writing files
- **WHEN** relay exits during a switch after writing `.relay/checkpoint.md` and before recording the handoff, and the person then runs `relay switch codex:personal`
- **THEN** relay prints `The last switch to Codex · personal did not finish. relay cleaned it up. Your work is saved in checkpoint 912ec1.`, restores the earlier `.relay/checkpoint.md`, and completes the new switch using checkpoint 912ec1 without saving another checkpoint

#### Scenario: Switch still running
- **WHEN** `switch.json` names a process that is still running
- **THEN** relay prints `relay: A switch to codex:personal is already running (process 4121). Try again when it finishes.` and exits with code 6

### Requirement: Switching an agent that runs under relay run elsewhere
When the job's agent runs under a `relay run` in another terminal, `relay switch` SHALL ask its questions in its own terminal, hand the switch to that `relay run`, print the same progress lines, and exit with the switch's exit code. The next agent SHALL start in the terminal of that `relay run`.

#### Scenario: Two terminals
- **WHEN** `relay run claude:personal` runs in terminal A and the person runs `relay switch codex:personal` in terminal B
- **THEN** terminal B shows the progress lines and exits with code 0, Codex starts in terminal A, and terminal A shows the same lines before Codex starts

#### Scenario: The switching terminal disappears
- **WHEN** the `relay switch` process in terminal B is killed after the request was taken
- **THEN** the `relay run` in terminal A completes the switch

#### Scenario: relay run does not answer
- **WHEN** the `relay run` process does not take the request within 5 seconds
- **THEN** relay deletes the request, prints `relay: The relay run for this job (process 4121) did not answer within 5 seconds. Nothing changed.` and exits with code 33

### Requirement: Preparing without starting
With `--no-start`, relay SHALL perform every step except starting the next agent, mark the handoff `prepared`, and print how to start it. This SHALL work without a terminal.

#### Scenario: Prepared handoff
- **WHEN** the person runs `relay switch codex:personal --no-start`
- **THEN** the last two lines are `Ready for Codex · personal.` and `Run "relay run codex:personal" to start it.`, and relay exits with code 0

### Requirement: Interactive start needs a terminal
When the next agent would start interactively and standard input or standard output is not a terminal, and `--no-start` is not given, relay SHALL refuse before stopping anything.

#### Scenario: Run from a script
- **WHEN** a script without a terminal runs `relay switch codex:personal` on an interactive job
- **THEN** standard error shows `relay: This switch needs a terminal. Run relay switch codex:personal in the project.`, relay exits with code 7, and the outgoing agent is still running

### Requirement: JSON result
With `--json`, relay SHALL print no progress lines and, on success, exactly one JSON object with `handoff_id`, `checkpoint_sha`, `prompt_path`, `to_worker_id`, `outcome`, `notes_source` and `mismatches`. On failure standard output SHALL be empty.

#### Scenario: JSON after a prepared handoff
- **WHEN** the person runs `relay switch codex:personal --no-start --json --yes`
- **THEN** standard output is one JSON object with `"handoff_id": 3`, the full checkpoint commit, the prompt path, `"to_worker_id": null` and `"outcome": "prepared"`

### Requirement: Control-C during a switch
Control-C before the agent is stopped SHALL cancel the switch without changes. After the agent is stopped, relay SHALL finish the current step, roll back as for a failure at that step, and exit with code 130.

#### Scenario: Control-C during the checks
- **WHEN** the person presses Control-C while relay runs the job's checks
- **THEN** relay stops the check's process group, writes no handoff, keeps the work checkpoint, appends `handoff_failed` with `step` `checks`, and exits with code 130

### Requirement: Exit codes
`relay switch` SHALL use 0 for success, 1 for a failure after the switch started, 2 for wrong arguments, 3 when relay is not set up or no agent worked on the job, 4 for the secret scan, 5 for changed git configuration, 6 when the job is busy, 7 when the person's answer is missing or "no", phase 3's codes for an account that is not ready, 31 when the next agent did not start, 32 when permissions would go up, 33 when the current agent could not be stopped, and 130 for Control-C.

#### Scenario: Busy job
- **WHEN** `relay checkpoint` holds the job lock and the person runs `relay switch codex:personal`
- **THEN** relay prints phase 2's lock message and exits with code 6 without stopping the agent
