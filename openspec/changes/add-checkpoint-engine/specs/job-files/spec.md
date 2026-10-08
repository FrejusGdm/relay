# Spec Delta: job-files

## Purpose

The `.relay/` folder holds a job's portable record (task, latest handoff, decisions, machine-readable state and an append-only event log) inside the project, so any agent can read it, while keeping it out of the person's own commits.

## ADDED Requirements

### Requirement: relay init creates a job in the current checkout
`relay init [--title <text>]` SHALL create a job in the git working tree that contains the current folder. It SHALL use the worktree root even when run from a subfolder, create a job ID of 8 random lowercase hexadecimal characters, create the `.relay/` folder with exactly five files, and save the baseline checkpoint described in the `checkpoints` spec.

#### Scenario: First run in a repository with uncommitted work
- **WHEN** the person runs `relay init` in `~/projects/app` on branch `main`, with gitleaks installed and no `.relay/` folder
- **THEN** relay creates `.relay/task.md`, `.relay/state.json`, `.relay/checkpoint.md`, `.relay/decisions.md` and `.relay/events.jsonl`
- **AND** prints exactly these lines, with the real job ID, path and short commit hash:
  ```
  Set up relay in ~/projects/app
  Job 3f9a2c1d
  Wrote .relay/task.md, state.json, checkpoint.md, decisions.md, events.jsonl
  Added /.relay/ to .git/info/exclude
  Saved checkpoint 1 · 4be81c0 (baseline)
  Next: write the goal in .relay/task.md
  ```
- **AND** exits with code 0

#### Scenario: Run from a subfolder
- **WHEN** the person runs `relay init` in `~/projects/app/src/lib`
- **THEN** `.relay/` is created in `~/projects/app`, not in `src/lib`

#### Scenario: Job ID format
- **WHEN** `relay init` succeeds
- **THEN** the job ID in `state.json` matches `^[0-9a-f]{8}$` and no ref under `refs/relay/jobs/<job ID>/` existed before the command

### Requirement: relay init refuses when it cannot set up a job safely
`relay init` SHALL stop with exit code 3, without creating or changing any file, when the folder is not inside a git working tree, when the repository is bare, when `.relay/` already exists at the worktree root, when git is older than 2.34, or when gitleaks 8.28 or newer cannot be run.

#### Scenario: Not a git repository
- **WHEN** the person runs `relay init` in a folder that is not inside a git working tree
- **THEN** relay prints "This folder is not inside a git repository. Run relay init inside your project." and exits with code 3

#### Scenario: Already set up
- **WHEN** `.relay/state.json` exists with job ID `3f9a2c1d` and the person runs `relay init`
- **THEN** relay prints "relay is already set up here (job 3f9a2c1d)." and exits with code 3, leaving every file unchanged

#### Scenario: Bare repository
- **WHEN** the person runs `relay init` inside a bare repository
- **THEN** relay prints "This repository has no working tree. relay needs one." and exits with code 3

#### Scenario: gitleaks missing
- **WHEN** no `gitleaks` program can be run
- **THEN** relay prints "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks" and exits with code 3

### Requirement: task.md template
`relay init` SHALL write `.relay/task.md` from this exact template, replacing `{title}` and `{job_id}`. The title is the `--title` value, or else the current branch name, or else the worktree folder name; newlines become spaces, invisible characters are removed, and it is cut to 120 characters.

#### Scenario: Default title from the branch
- **WHEN** the person runs `relay init` on branch `auth-refactor` without `--title`, and the job ID is `3f9a2c1d`
- **THEN** `.relay/task.md` contains exactly:
  ```
  # auth-refactor

  <!-- relay job 3f9a2c1d. Agents read this file first. Keep it current. -->

  ## Goal

  Describe what this job should achieve.

  ## Acceptance criteria

  - [ ] Describe how to tell the job is done.

  ## Plan

  ## Done

  ## In progress

  ## Left to do
  ```

#### Scenario: Title given
- **WHEN** the person runs `relay init --title "Build authentication"`
- **THEN** the first line of `.relay/task.md` is `# Build authentication` and `state.json` has `"title": "Build authentication"`

### Requirement: checkpoint.md and decisions.md templates
`relay init` SHALL write `.relay/checkpoint.md` and `.relay/decisions.md` from fixed templates. The commands in this change SHALL NOT change either file after `relay init`; the handoff (a later change) writes `checkpoint.md`, and people and agents write `decisions.md`.

#### Scenario: Templates written
- **WHEN** `relay init` succeeds with job ID `3f9a2c1d`
- **THEN** `.relay/checkpoint.md` contains exactly:
  ```
  # Checkpoint

  <!-- relay job 3f9a2c1d. The latest handoff, written for the next agent. -->

  No handoff yet. relay writes this file when work moves to another agent.
  ```
- **AND** `.relay/decisions.md` contains exactly:
  ```
  # Decisions

  <!-- relay job 3f9a2c1d. One entry per decision, newest last: the date, the decision, and why. -->
  ```

### Requirement: state.json schema
`.relay/state.json` SHALL be a JSON object with `schema_version` 1 and the fields `job_id`, `title`, `status` (`active`), `created_at`, `updated_at`, `relay_version`, `repository`, `start`, `latest_checkpoint`, `checkpoint_count`, `approved_paths` and `last_rollback`, as shown in the scenario. Times are UTC ISO 8601 with milliseconds. relay SHALL replace the file atomically. Readers SHALL ignore fields they do not know, so later changes can add fields without a new schema version.

#### Scenario: State after relay init
- **WHEN** `relay init` succeeds in `/Users/josue/projects/app` on branch `main` at commit `86300b0b…`
- **THEN** `.relay/state.json` has this shape, with real values:
  ```json
  {
    "schema_version": 1,
    "job_id": "3f9a2c1d",
    "title": "main",
    "status": "active",
    "created_at": "2026-10-07T20:31:05.123Z",
    "updated_at": "2026-10-07T20:31:05.456Z",
    "relay_version": "0.1.0",
    "repository": {
      "worktree_root": "/Users/josue/projects/app",
      "common_git_dir": "/Users/josue/projects/app/.git",
      "linked_worktree": false
    },
    "start": { "head": "86300b0b37343e5c06a5dfeb6be71f64dddfbed3", "branch": "main", "detached": false },
    "latest_checkpoint": {
      "number": 1,
      "commit": "4be81c0d9e2f…",
      "ref": "refs/relay/jobs/3f9a2c1d/checkpoints/1",
      "kind": "baseline",
      "created_at": "2026-10-07T20:31:05.400Z"
    },
    "checkpoint_count": 1,
    "approved_paths": [],
    "last_rollback": null
  }
  ```

#### Scenario: Repository with no commits
- **WHEN** `relay init` runs in a repository with no commits on branch `main`
- **THEN** `start` is `{ "head": null, "branch": "main", "detached": false }`

#### Scenario: Interrupted write
- **WHEN** relay is killed while updating `state.json`
- **THEN** `state.json` holds either the complete old content or the complete new content

### Requirement: events.jsonl format
`.relay/events.jsonl` SHALL hold one JSON object per line with the fields `v` (1), `id` (an integer that increases by 1 from 1), `ts`, `job`, `type`, `actor` (`relay`) and `data`. relay SHALL only append, and every append SHALL go through one function, `appendEvent`, which holds the lock `locks/<job>.events.lock` under `RELAY_HOME` while it reads the last `id` and writes one complete line. Events SHALL NOT contain environment variables, command output or secret values.

#### Scenario: First event
- **WHEN** `relay init` succeeds
- **THEN** the first line of `.relay/events.jsonl` is a `job_started` event such as `{"v":1,"id":1,"ts":"2026-10-07T20:31:05.124Z","job":"3f9a2c1d","type":"job_started","actor":"relay","data":{"title":"main","worktree_root":"/Users/josue/projects/app","head":"86300b0b…","branch":"main","detached":false,"linked_worktree":false}}`
- **AND** the second line is the `checkpoint_saved` event of the baseline checkpoint

#### Scenario: Event types in this change
- **WHEN** any command of this change appends an event
- **THEN** its `type` is one of `job_started`, `checkpoint_saved`, `checkpoint_refused`, `rollback` or `git_changes_accepted`, with the `data` fields listed in design.md section 16 and the specs of each command

#### Scenario: Two processes append at once
- **WHEN** two relay processes each append 100 events to the same job at the same time
- **THEN** the file gains 200 complete lines whose `id` values continue one by one in file order

#### Scenario: Interrupted append
- **WHEN** the last line of `events.jsonl` does not end with a newline because a write was interrupted
- **THEN** relay ignores that partial line when reading, starts the next event on a new line, and gives it the `id` after the last complete event

### Requirement: .relay is kept out of the person's commits
`relay init` SHALL add the line `/.relay/` to the info/exclude file of the repository's common git folder, creating the file if needed, unless the exact line is already present. relay SHALL NOT edit any tracked `.gitignore` file. This follows the recommendation pending Josué's decision that `.relay/` stays local.

#### Scenario: Exclude line added once
- **WHEN** `relay init` runs in the main checkout and later in a linked worktree of the same repository
- **THEN** `.git/info/exclude` contains the line `/.relay/` exactly once, preceded by the comment line `# relay: job files stay local`

#### Scenario: Files invisible to git status
- **WHEN** `relay init` has succeeded
- **THEN** `git status --porcelain` shows no path under `.relay/`

### Requirement: Only the job files are stored in checkpoints
Checkpoints SHALL include exactly the job files from `.relay/`: the five files `relay init` creates, plus `.relay/verify.md` when it exists (the next agent writes it after a handoff). No other file that may be placed in that folder SHALL be stored.

#### Scenario: Stray file in .relay
- **WHEN** a file `.relay/notes.tmp` exists and the person runs `relay checkpoint`
- **THEN** the checkpoint commit contains the five job files and does not contain `.relay/notes.tmp`

#### Scenario: Verification file present
- **WHEN** an agent wrote `.relay/verify.md` and the person runs `relay checkpoint`
- **THEN** the checkpoint commit contains `.relay/verify.md` with its current content
