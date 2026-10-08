# Spec Delta: run-continuation

## Purpose

`relay run <provider[:account]>` starts an agent inside a relay job. This capability covers what it tells the agent, how it continues work that another agent began, how it stays reachable for `relay switch`, and how it saves the work when the agent exits.

## ADDED Requirements

### Requirement: Instructions for every agent in a job
Every agent a handoff starts SHALL receive, through the adapter's instructions channel, the same instructions text that `add-provider-adapters` defines for `relay run` (`agent-runs` requirement "Default instructions and prompt"), with the job ID and the worktree root filled in, and nothing written by an agent.

#### Scenario: Same instructions after a handoff
- **WHEN** a switch from `claude:personal` to `codex:personal` starts fake Codex in job `3f9a2c1d` with `RELAY_FAKE_RECORD` set
- **THEN** the recorded `developer_instructions` value is byte for byte the text that `src/run/instructions.ts` renders for job `3f9a2c1d` and the job's worktree root, and it contains no line of `.relay/checkpoint.md`

### Requirement: Start prompt for a new job
When no agent has worked on the job before, `relay run` SHALL give the agent the start prompt: read the project instructions that exist (`AGENTS.md`, `CLAUDE.md`), read `.relay/task.md`, work on the task and keep `task.md` current, and, when checks are recorded, which checks relay runs at handoffs.

#### Scenario: Start prompt with both instruction files and one check
- **WHEN** job `3f9a2c1d` titled `Build authentication` has `AGENTS.md` and `CLAUDE.md` at the worktree root, the check `bun test`, and no earlier worker
- **THEN** the first prompt is exactly:
  ```
  Start relay job 3f9a2c1d: Build authentication.

  1. Read the project instructions in AGENTS.md and CLAUDE.md.
  2. Read .relay/task.md: the goal, the acceptance criteria and the plan.
  3. Work on the task. Keep the Plan, Done, In progress and Left to do sections of .relay/task.md current.

  relay runs these checks when the job moves to another agent: `bun test`.
  ```

#### Scenario: No instruction files
- **WHEN** neither `AGENTS.md` nor `CLAUDE.md` exists at the worktree root
- **THEN** the start prompt has no step about project instructions and its steps are numbered 1 and 2

#### Scenario: Request given with --prompt
- **WHEN** a headless run is started with `--prompt "Add the logout route."`
- **THEN** the start prompt ends with a blank line and `Your request: Add the logout route.`

### Requirement: A job with earlier work continues through a handoff
When another worker worked on the job before and none is running, `relay run <account>` SHALL perform the same handoff as `relay switch` without the stop step, including the notes request, the checks, the secret scan and the allow-list question, and SHALL start the agent with the continuation prompt.

#### Scenario: Claude Code exited, Codex continues
- **WHEN** Claude Code · personal exited by itself and the person runs `relay run codex:personal`
- **THEN** relay prints no `Stopping` line, prints the checkpoint, notes, checks and `Wrote .relay/checkpoint.md` lines, then `Starting Codex · personal` and `Continuing on Codex.`
- **AND** a `handoff` event is appended with `from_worker_id` set to Claude Code's worker

#### Scenario: Same account again
- **WHEN** Claude Code · personal exited by itself and the person runs `relay run claude:personal`
- **THEN** relay builds a handoff to `claude:personal` and starts a new Claude Code session with the continuation prompt

#### Scenario: An agent is still running
- **WHEN** a `relay run` of this job is running its agent and the person runs `relay run codex:personal` in another terminal
- **THEN** standard error shows `relay: Claude Code · personal is working on this job. To hand it over, run relay switch codex:personal.` and relay exits with code 6

### Requirement: Reusing a prepared handoff
When the newest handoff of the job is `prepared` or `start_failed`, targets the account given to `relay run`, and the working tree still matches its checkpoint (ignoring `.relay/state.json` and `.relay/events.jsonl`), `relay run` SHALL start the agent with that handoff's saved instructions and prompt instead of building a new handoff.

#### Scenario: Start after --no-start
- **WHEN** the person ran `relay switch codex:personal --no-start` and then runs `relay run codex:personal` without changing any file
- **THEN** relay prints `Using the prepared handoff 3`, `Starting Codex · personal` and `Continuing on Codex.`, runs no check, and the handoff's outcome becomes `started`

#### Scenario: Files changed since the handoff was prepared
- **WHEN** a file changed after the handoff was prepared
- **THEN** relay builds a new handoff instead

### Requirement: relay run stays reachable for relay switch
While its agent runs, `relay run` SHALL keep its record in phase 3's worker lock file `RELAY_HOME/locks/<job>.worker.lock` (mode 0600), adding its process start time, worker ID and mode to the process ID and account that phase 3 writes there, SHALL accept switch requests signalled with `SIGUSR1`, and SHALL remove the file when it releases the lock on exit. relay SHALL NOT keep a second file for this record.

#### Scenario: Record while working
- **WHEN** `relay run claude:personal` has started its agent
- **THEN** the worker lock file exists with mode 0600 and names the `relay run` process, its start time, the worker ID and the account

#### Scenario: Stale record
- **WHEN** the worker lock file names a process ID that now belongs to another program with a different start time
- **THEN** relay treats the job as having no running `relay run`, never signals that process, and removes the stale file

### Requirement: Control-C belongs to the agent
While an interactive agent runs, `relay run` SHALL ignore `SIGINT`, so that Control-C reaches only the agent. On `SIGTERM` or `SIGHUP`, `relay run` SHALL stop the agent through its adapter, save a checkpoint of kind `auto`, and exit with code 143.

#### Scenario: Control-C in Claude Code
- **WHEN** the person presses Control-C once inside an interactive Claude Code started by `relay run`
- **THEN** `relay run` keeps running and Claude Code handles the key

#### Scenario: Terminal closed
- **WHEN** the terminal that runs `relay run` is closed
- **THEN** relay stops the agent, saves a checkpoint of kind `auto` when files changed, appends `worker_ended` with `end_reason` `relay_stopped`, and exits

### Requirement: Checkpoint when the agent exits
When the agent exits by itself, `relay run` SHALL append `worker_ended` with `end_reason` `exited`, save a checkpoint of kind `auto` unless nothing changed, print what happened, and exit with the agent's exit code.

#### Scenario: Agent exits after editing files
- **WHEN** an interactive Claude Code changed two files and exits with code 0
- **THEN** standard output ends with `Claude Code · personal stopped (exit code 0)` and `Saved checkpoint 4c2a91`, and relay exits with code 0

#### Scenario: Agent exits without changes
- **WHEN** the agent exits with code 1 and no file changed since checkpoint `912ec1`
- **THEN** standard output ends with `Claude Code · personal stopped (exit code 1)` and `No changes since checkpoint 912ec1`, and relay exits with code 1

#### Scenario: Secret in the work
- **WHEN** the agent exits after writing a private key into a tracked file
- **THEN** relay prints phase 2's secret finding, saves no checkpoint, and exits with code 4

### Requirement: Interactive Claude Code sessions can be asked for notes
A switch SHALL take the provider session ID of an interactive Claude Code worker from the `provider_session_id` that `add-provider-adapters` records when it starts the session with `--session-id <uuid>`, and SHALL use it to ask that session for handoff notes.

#### Scenario: Session ID reused for the notes request
- **WHEN** `relay run claude:personal` started fake Claude Code with session ID `7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f` and the person runs `relay switch codex:personal`
- **THEN** the notes request resumes `7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f` on `claude:personal`, and that value equals the `provider_session_id` of the outgoing worker's `worker_started` event
