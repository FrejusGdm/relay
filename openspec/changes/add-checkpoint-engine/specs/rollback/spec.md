# Spec Delta: rollback

## Purpose

Rollback returns a job's working tree to the files of an earlier checkpoint, shows what will change before doing it, and saves the current state first so that every rollback can itself be undone, without moving a branch, rewriting history or changing the person's index.

## ADDED Requirements

### Requirement: Choosing the checkpoint to roll back to
`relay rollback [<checkpoint>] [--yes] [--dry-run]` SHALL accept a checkpoint number, or a commit prefix of at least 7 hexadecimal characters that matches exactly one checkpoint of the job. Without an argument it SHALL use the newest checkpoint whose kind is not `pre_rollback`.

#### Scenario: Default target
- **WHEN** checkpoints 1 (`baseline`), 2 (`manual`) and 3 (`pre_rollback`) exist and the person runs `relay rollback --yes`
- **THEN** relay rolls back to checkpoint 2

#### Scenario: Unknown checkpoint
- **WHEN** the person runs `relay rollback 9` and the job has no checkpoint 9
- **THEN** relay prints "Checkpoint 9 does not exist. See relay checkpoints." and exits with code 2

#### Scenario: Ambiguous prefix
- **WHEN** the given prefix matches two checkpoints of the job
- **THEN** relay prints "912ec1a matches more than one checkpoint. Use the checkpoint number." and exits with code 2

### Requirement: Rollback shows what will change before changing it
Before changing any file, `relay rollback` SHALL print the target checkpoint and every path it will modify, add or delete, then ask for confirmation in an interactive terminal. `--yes` SHALL skip the question. Without a terminal and without `--yes`, relay SHALL print the plan, change nothing and exit with code 7.

#### Scenario: Preview and confirmation
- **WHEN** the person runs `relay rollback 2` in a terminal and three files differ from checkpoint 2
- **THEN** relay prints, with real values:
  ```
  Roll back to checkpoint 2 · 912ec1a (2 hours ago, "Login form done")

    modify  src/auth.ts
    add     src/session.ts
    delete  src/new-helper.ts

  3 files will change. Your branch, commits and staged changes stay as they are.
  relay saves your current files as a checkpoint first, so you can undo this.
  Roll back? [y/N]
  ```
- **AND** any answer other than `y` or `yes` prints "Cancelled. Nothing changed." and exits with code 7

#### Scenario: Run by a program without --yes
- **WHEN** `relay rollback 2` runs without a terminal and without `--yes`
- **THEN** relay prints the plan followed by "Run again with --yes to roll back." and exits with code 7 without creating a checkpoint or changing a file

#### Scenario: Dry run
- **WHEN** the person runs `relay rollback 2 --dry-run`
- **THEN** relay prints the plan and exits with code 0 without creating a checkpoint or changing a file

#### Scenario: Nothing to roll back
- **WHEN** the working tree already matches checkpoint 2
- **THEN** relay prints "Nothing to roll back. Your files already match checkpoint 2." and exits with code 0

### Requirement: Rollback saves the current state first
After confirmation and before changing any file, `relay rollback` SHALL save the current working tree as a checkpoint of kind `pre_rollback` with the message "Before rolling back to checkpoint <n>", unless it equals the `latest` checkpoint apart from `state.json` and `events.jsonl`, in which case `latest` is the undo point.

#### Scenario: Undo a rollback
- **WHEN** the person rolls back to checkpoint 2, which saves checkpoint 8 of kind `pre_rollback`, and then runs `relay rollback 8 --yes`
- **THEN** every file outside `.relay/` is byte-for-byte what it was before the first rollback

#### Scenario: Output after rolling back
- **WHEN** a rollback to checkpoint 2 finishes and the undo point is checkpoint 8
- **THEN** relay prints:
  ```
  Saved checkpoint 8 · 1a2b3c4 (before rollback)
  Rolled back to checkpoint 2 · 912ec1a
  3 files changed
  To undo: relay rollback 8
  ```
- **AND** exits with code 0

#### Scenario: Current state cannot be saved
- **WHEN** the current files contain a secret, so the `pre_rollback` checkpoint is stopped by the secret scan
- **THEN** relay prints "relay could not save your current files before rolling back, so it changed nothing." followed by the secret-scan message, and exits with code 4

### Requirement: Rollback restores files only
`relay rollback` SHALL write and delete only working-tree files outside `.relay/`. It SHALL NOT move `HEAD` or any branch, change any index file, create commits on branches, change the stash, or run `git reset`, `git checkout`, `git restore`, `git clean` or `git stash`.

#### Scenario: Branch and index untouched
- **WHEN** a rollback finishes
- **THEN** a capture of the state described in design.md section 15 is identical before and after, except for working-tree files outside `.relay/`

#### Scenario: Commits made after the checkpoint
- **WHEN** the person committed twice on `main` after checkpoint 2 and then rolls back to checkpoint 2
- **THEN** `main` still points to the newest commit, the restored files show as uncommitted changes, and relay prints "Your branch still points to <short hash>. The restored files show as uncommitted changes."

#### Scenario: Job files kept
- **WHEN** `.relay/task.md` changed after checkpoint 2 and the person rolls back to checkpoint 2
- **THEN** `.relay/task.md` keeps its current content, and `events.jsonl` keeps all earlier events and gains a `rollback` event with `to_checkpoint`, `to_commit`, `undo_checkpoint`, `files_written` and `files_deleted`

#### Scenario: Modes and symbolic links
- **WHEN** after checkpoint 2 a script lost its executable bit and a symbolic link was replaced by a regular file
- **THEN** after rolling back to checkpoint 2 the script is executable again and the symbolic link is restored

### Requirement: Rollback never destroys unsaved files
`relay rollback` SHALL NOT write, overwrite or delete a path whose current content is not saved in the undo checkpoint: ignored files, files left out for size, and untracked files with secret-like names. If the plan would touch such a path, relay SHALL change nothing and exit with code 8.

#### Scenario: Ignored files survive
- **WHEN** `node_modules/` and `.env` are ignored and the person rolls back
- **THEN** both are unchanged

#### Scenario: Unsaved file in the way
- **WHEN** checkpoint 2 contains `config/local.json`, the file is now ignored and has different content, and the person runs `relay rollback 2 --yes`
- **THEN** relay prints "Rolling back would overwrite files relay has not saved: config/local.json. Move them or delete them yourself, then try again." and exits with code 8
- **AND** no file changed and no checkpoint was created

#### Scenario: Folders emptied by the rollback
- **WHEN** a rollback deletes the only files of a folder that did not exist in the target checkpoint
- **THEN** the empty folder is removed, and a folder that still holds any file is kept

### Requirement: Rollback checks its result
After restoring, `relay rollback` SHALL compare the working tree with the target checkpoint, ignoring `.relay/` and unsaved paths, and report any difference.

#### Scenario: Result differs
- **WHEN** a file could not be written during the rollback
- **THEN** relay prints "Rollback finished, but these files do not match checkpoint <n>: <paths>" and the undo command, and exits with code 1
