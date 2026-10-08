# Spec Delta: provider-allow-list

## Purpose

Moving a job to another account sends the project's code to the company behind that account. This capability decides which accounts may receive a job, asks the person before the first handoff to a new one, and remembers the answer outside the repository.

## ADDED Requirements

### Requirement: Allow list per project
The accounts that may receive a job SHALL be the `allow` list of the `[[projects]]` entry in `config.toml` whose `path` is the job's worktree root or the main worktree root of the same repository. Nothing inside the repository SHALL add an account to it.

#### Scenario: Linked worktree uses the main entry
- **WHEN** `config.toml` has a `[[projects]]` entry for `/Users/josue/projects/app` with `allow = ["claude:personal"]`, and the job runs in a linked worktree of that repository at `/Users/josue/projects/app-auth`
- **THEN** relay uses that entry's list for the job

#### Scenario: Repository file cannot grant access
- **WHEN** the repository contains a file `.relay/allow` or any other file naming `codex:personal`
- **THEN** relay still asks the first-handoff question for `codex:personal`

### Requirement: First handoff to a new account asks first
When the next account is not on the allow list, relay SHALL ask, before stopping any agent, `This sends the repository and the job notes to <company> through the account <account>. Continue? [y/N]`, where the company comes from the adapter's policy (Anthropic for `claude`, OpenAI for `codex`).

#### Scenario: Yes adds the account
- **WHEN** `codex:personal` is not on the list and the person answers `y`
- **THEN** relay adds `codex:personal` to the entry's `allow` list, keeps every other line of `config.toml` as it was, appends a `provider_allowed` event with `company` `OpenAI` and `how` `terminal`, and continues the switch

#### Scenario: Asked once
- **WHEN** the person switches to `codex:personal` a second time in the same project
- **THEN** relay does not ask again

#### Scenario: No answers no
- **WHEN** the person presses Enter without typing
- **THEN** relay treats it as no, prints `relay: Nothing changed. Claude Code · personal is still working.`, and exits with code 7

### Requirement: The question needs a terminal or --yes
Without a terminal on standard input and standard output, relay SHALL NOT wait for an answer. Without `--yes` it SHALL exit with code 7 before changing anything. `--yes` SHALL answer only relay's own questions, never an agent's prompt, and SHALL be recorded.

#### Scenario: Script without --yes
- **WHEN** a script without a terminal runs `relay switch codex:personal --no-start` and `codex:personal` is not on the list
- **THEN** standard error shows `relay: codex:personal has not worked on this project before. Sending the repository to OpenAI needs your yes.` and `Run "relay switch codex:personal" in a terminal, or add --yes.`, and relay exits with code 7

#### Scenario: Script with --yes
- **WHEN** the same script adds `--yes`
- **THEN** relay adds the account to the list, and the `provider_allowed` event has `how` `flag`

### Requirement: Second account of the same provider
Before the first handoff to another account of the outgoing agent's provider, relay SHALL print the adapter policy's note on moving work between one's own accounts, then ask the first-handoff question. relay SHALL never make such a switch on its own.

#### Scenario: Claude account to Claude account
- **WHEN** the job runs on `claude:personal`, `claude:work` is not on the list, and the person runs `relay switch claude:work`
- **THEN** relay prints `Anthropic says Pro and Max limits assume ordinary, individual use. Moving this job between your own Claude accounts is your choice.` and then `This sends the repository and the job notes to Anthropic through the account claude:work. Continue? [y/N]`

#### Scenario: The next agent uses the other profile
- **WHEN** the person answers yes
- **THEN** the next Claude Code starts with `CLAUDE_CONFIG_DIR` set to the profile folder of `claude:work`

### Requirement: Work code moving to a personal account
When the outgoing account has `kind = "work"` and the next account has `kind = "personal"`, relay SHALL print a warning and ask `Continue? [y/N]` on every such switch, even when the next account is on the allow list.

#### Scenario: Work to personal
- **WHEN** the job runs on `claude:work` (kind work) and the person runs `relay switch codex:personal` (kind personal), which is on the list
- **THEN** relay prints `This job ran on a work account (claude:work). codex:personal is marked personal.` and asks `Continue? [y/N]`

#### Scenario: Personal to work
- **WHEN** the job moves from a personal account to a work account that is on the list
- **THEN** relay asks nothing

### Requirement: relay run asks instead of refusing
`relay run <account>` on an account that is not on the project's allow list SHALL ask the first-handoff question instead of refusing, when the project already has an allow list. The first `relay run` in a project without an entry SHALL create the entry with that account and ask nothing.

#### Scenario: First run in a project
- **WHEN** `config.toml` has no `[[projects]]` entry for the project and the person runs `relay run claude:personal`
- **THEN** relay adds an entry with this project's path and `allow = ["claude:personal"]` and asks nothing

#### Scenario: Run on a new account
- **WHEN** the project's list is `["claude:personal"]` and the person runs `relay run codex:personal`
- **THEN** relay asks the first-handoff question naming OpenAI before starting Codex
