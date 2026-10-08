# Spec Delta: handoff-safety

## Purpose

A handoff writes files and commits and sends text to another agent, possibly at another company. This capability keeps secrets out of everything a handoff writes or sends, pauses when an agent changed the files that instruct agents, removes hidden characters, and makes sure the next agent never gets more permission or less supervision than the job had.

## ADDED Requirements

### Requirement: Secret scan before anything is written or sent
Before writing any `.relay/` file, recording the handoff or starting the next agent, relay SHALL scan with gitleaks the new `checkpoint.md`, the new `state.json`, the new events, the outgoing agent's notes, the instructions and the prompt. The work diff SHALL already have been scanned by the checkpoint. A finding SHALL stop the handoff.

#### Scenario: Secret in the agent's notes
- **WHEN** Claude Code's notes contain an API key on line 12 and the person runs `relay switch codex:personal`
- **THEN** standard error shows:
  ```
  relay: Stopped: possible secret in Claude Code's handoff notes, line 12 (generic-api-key).
  relay: Nothing was written or sent. Claude Code is stopped, and your work is saved in checkpoint 912ec1.
  Run "relay switch codex:personal --no-summary" to hand off without Claude Code's notes.
  ```
- **AND** relay exits with code 4
- **AND** the bytes of `.relay/checkpoint.md` and `.relay/state.json` are unchanged, no ref `refs/relay/jobs/<job>/handoffs/<n>` exists, and fake Codex was never started
- **AND** after relay exits, the key appears in no output, no event, no file under `.relay/` and no file under `RELAY_HOME`

#### Scenario: Retry without the notes
- **WHEN** the person then runs `relay switch codex:personal --no-summary`
- **THEN** relay uses checkpoint 912ec1 without saving another, builds the notes itself, and the switch succeeds

#### Scenario: Secret in a check's output
- **WHEN** a failing check prints an AWS access key that is not the value of an environment variable
- **THEN** relay stops with exit code 4, names `the new .relay/checkpoint.md` and the line, and the hint is `Fix the output of the check, or change the checks with --check.`

#### Scenario: Scanner fails
- **WHEN** gitleaks exits with an error that is not a finding
- **THEN** relay prints `relay: The secret scan did not finish: <first line of gitleaks' error>. Nothing was written or sent.` and exits with code 1

### Requirement: Files that instruct agents
Before stopping the current agent, relay SHALL check whether `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json`, `.codex/`, `.cursor/`, `.agents/`, `.github/copilot-instructions.md`, or any `AGENTS.md` or `CLAUDE.md` in a subfolder changed since the outgoing agent started, and if so list them and ask before continuing.

#### Scenario: Agent edited AGENTS.md and its settings
- **WHEN** Claude Code changed `AGENTS.md` and `.claude/settings.json` and the person runs `relay switch codex:personal` in a terminal
- **THEN** before stopping Claude Code, relay prints:
  ```
  Claude Code changed files that tell agents what to do:
    AGENTS.md
    .claude/settings.json
  Review them with: git diff 4be81c0 -- AGENTS.md .claude/settings.json
  Start Codex with these files? [y/N]
  ```
- **AND** on `y` the switch continues and the `handoff` event lists both paths in `instruction_files_changed`

#### Scenario: No terminal
- **WHEN** the same change exists and the switch runs without a terminal and without `--yes`
- **THEN** relay prints `relay: Claude Code changed files that tell agents what to do. Review them, then run relay switch codex:personal in a terminal, or add --yes.`, exits with code 7, and Claude Code is still running

#### Scenario: Changed between the question and the stop
- **WHEN** the person answered yes for `AGENTS.md` and the agent then changed `.mcp.json` before it stopped
- **THEN** after the work checkpoint relay asks again, listing `AGENTS.md` and `.mcp.json`, and a "no" exits with code 7 with the work checkpoint kept

### Requirement: Invisible characters
relay SHALL remove U+00AD, U+180E, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FE00 to U+FE0F (variation selectors), U+FEFF, U+E0000 to U+E007F and U+E0100 to U+E01EF from everything a handoff writes or sends, SHALL report how many it removed from agent text, and SHALL warn about them in instruction files without changing those files.

#### Scenario: Hidden text in the notes
- **WHEN** Claude Code's notes contain three tag characters (U+E0041 to U+E0043) and one U+202E
- **THEN** `checkpoint.md` contains none of them, the progress output contains `Removed 4 invisible characters from Claude Code's notes.`, and the `handoff` event has `invisible_removed` 4

#### Scenario: Hidden text in AGENTS.md
- **WHEN** `AGENTS.md` contains 3 zero-width spaces, the first on line 12, and changed during the job
- **THEN** the instruction-files question also says `AGENTS.md contains 3 invisible characters (first on line 12). relay does not change this file.` and the file's bytes are unchanged

### Requirement: Supervision never goes down
A job that ran its agents in the person's terminal SHALL hand off only to an agent in the person's terminal. A request to start the next agent headless SHALL be refused before anything is stopped.

#### Scenario: Headless start of an interactive job
- **WHEN** the switch function is called with start mode `headless` for a job whose mode is `interactive`
- **THEN** it fails with exit code 32 and `This job runs agents in your terminal. relay switch never starts the next agent with less supervision than that.`, and the outgoing agent is still running

### Requirement: Permission never goes up
For a headless job, the next agent SHALL run at the level given with `--permission` or else the outgoing agent's level, never above the job's recorded ceiling. The ceiling SHALL be stored outside the project, in `RELAY_HOME/jobs/<job>/handoff-settings.json`.

#### Scenario: Higher level refused
- **WHEN** a headless job's ceiling is `read-only` and the switch asks for `--permission edit-in-workspace`
- **THEN** relay prints `relay: This job allows read-only. relay switch never gives the next agent more than that.` and exits with code 32 before stopping anything

#### Scenario: Lower level accepted
- **WHEN** a headless job's ceiling is `edit-in-workspace` and the switch asks for `--permission read-only`
- **THEN** the next agent starts at `read-only` and the ceiling stays `edit-in-workspace`

#### Scenario: Editing state.json does not raise the ceiling
- **WHEN** an agent writes `"permission": "full-access"` into `.relay/state.json`
- **THEN** the next agent still starts at the ceiling recorded in `handoff-settings.json`

### Requirement: No bypass flags and no answers for the person
No handoff SHALL pass a permission-bypass flag to any agent, the notes request SHALL run at `read-only`, and relay SHALL NOT answer a permission prompt of the outgoing or the next agent.

#### Scenario: Arguments checked in every switch test
- **WHEN** any switch test starts any fake agent, including the notes request
- **THEN** the recorded arguments contain none of `--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo` or `danger-full-access`

#### Scenario: Notes request asks for approval
- **WHEN** the outgoing agent, while writing its notes, asks for approval to run a command
- **THEN** relay does not approve it, stops that agent, and builds the notes itself with the reason `the request failed: the agent asked for permission`
