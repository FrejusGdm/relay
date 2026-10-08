# Spec Delta: checkpoints

## Purpose

Checkpoints save the full state of a job's working tree, including uncommitted and untracked work and the `.relay/` job files, as git commits under private refs, so work can be continued or restored later without ever touching the person's branch, index, stash or files.

## ADDED Requirements

### Requirement: relay checkpoint saves the working tree under a private ref
`relay checkpoint [-m <message>] [--include <path>]... [--json]` SHALL save a commit whose tree holds the current content of every tracked file, every untracked file that git does not ignore, and the `.relay/` job files, and SHALL record it as `refs/relay/jobs/<job>/checkpoints/<n>` and `refs/relay/jobs/<job>/latest`, with `<n>` one more than the highest existing number.

#### Scenario: Staged, unstaged and untracked work
- **WHEN** the repository has a staged new file `s.txt` that was edited again after staging, an unstaged change to `a.txt`, an untracked file `u.txt` and an ignored file `debug.log`, and the person runs `relay checkpoint -m "Login form done"`
- **THEN** the new checkpoint's tree has the working-tree content of `s.txt`, `a.txt` and `u.txt`, has the five `.relay/` job files, and has no `debug.log`
- **AND** relay prints exactly these lines, with real values:
  ```
  Saved checkpoint 2 · 912ec1a
  3 files changed since checkpoint 1
  ```
- **AND** exits with code 0

#### Scenario: Numbering and latest
- **WHEN** checkpoints 1 to 4 exist and a checkpoint is saved
- **THEN** `refs/relay/jobs/<job>/checkpoints/5` and `refs/relay/jobs/<job>/latest` both point to the new commit

#### Scenario: Two checkpoints at the same time
- **WHEN** two `relay checkpoint` commands run at the same time for the same job
- **THEN** either both succeed with different numbers, or one exits with code 6 and prints "Another relay command is working on this job (relay checkpoint, process <pid>). Try again when it finishes."
- **AND** no checkpoint ref is ever overwritten

### Requirement: Checkpoint commit parent and message
The first checkpoint of a job SHALL have the current `HEAD` commit as its parent, or no parent in a repository with no commits; later checkpoints SHALL have the previous `latest` checkpoint as parent. The message SHALL follow the format in design.md decision 4, with the trailers `Relay-Job`, `Relay-Checkpoint`, `Relay-Kind`, `Relay-Head`, `Relay-Branch` and `Relay-Version`.

#### Scenario: Message with trailers
- **WHEN** the person runs `relay checkpoint -m "OAuth callback works"` on branch `main` and it becomes checkpoint 5 of job `3f9a2c1d`
- **THEN** the commit message starts with the line `relay checkpoint 5: OAuth callback works`
- **AND** its trailers include `Relay-Job: 3f9a2c1d`, `Relay-Checkpoint: 5`, `Relay-Kind: manual`, `Relay-Branch: main` and `Relay-Head: <the HEAD commit>`

#### Scenario: No message
- **WHEN** the person runs `relay checkpoint` without `-m`
- **THEN** the subject line is `relay checkpoint <n>`

#### Scenario: Message cleaned
- **WHEN** the message contains a newline or a zero-width space
- **THEN** the newline becomes a space, the zero-width space is removed, and the subject is cut to 200 characters of message

#### Scenario: Commit signing configured
- **WHEN** the person's configuration sets `commit.gpgSign=true` and `gpg.program` to a program
- **THEN** the checkpoint commit is created unsigned and that program is never started

### Requirement: Checkpoint kinds
Every checkpoint SHALL have one kind, recorded in the `Relay-Kind` trailer and the `checkpoint_saved` event: `baseline` (the first checkpoint of a job), `manual` (`relay checkpoint`), `pre_rollback` (saved before a rollback), `handoff` (the work checkpoint of a switch) or `auto` (saved by `relay run` when its agent exits). The commands of this change create the first three; `add-relay-switch` creates the last two through the same `saveCheckpoint` function.

#### Scenario: Kind given by a caller
- **WHEN** a caller saves a checkpoint through `saveCheckpoint` with kind `handoff` and the extra trailers `Relay-Worker: 5d2e8f01` and `Relay-Target: claude:personal`
- **THEN** the commit has `Relay-Kind: handoff` and both extra trailers, and `relay checkpoints` shows its kind as `handoff`

### Requirement: Baseline checkpoint
The first checkpoint of every job SHALL have the kind `baseline`. `relay init` SHALL try to save it. If the secret scan stops it, the job SHALL stay set up and the next `relay checkpoint` SHALL save the baseline instead.

#### Scenario: Baseline captures the person's uncommitted work
- **WHEN** the person has uncommitted changes and runs `relay init`
- **THEN** checkpoint 1 exists with `Relay-Kind: baseline` and its tree contains those changes

#### Scenario: Baseline stopped by a secret
- **WHEN** the person runs `relay init` and an untracked file contains a GitHub token
- **THEN** relay creates `.relay/`, prints "relay is set up (job 3f9a2c1d), but the baseline checkpoint was not saved." followed by the secret-scan message from the `secret-scanning` spec, and exits with code 4
- **AND** the next successful `relay checkpoint` creates checkpoint 1 with kind `baseline`

### Requirement: Nothing changed means no new checkpoint
`relay checkpoint` SHALL NOT create a commit when the new tree equals the tree of `latest` apart from `.relay/state.json` and `.relay/events.jsonl`.

#### Scenario: No changes since the last checkpoint
- **WHEN** checkpoint 7 is the latest and no file outside `.relay/state.json` and `.relay/events.jsonl` changed since
- **THEN** relay prints "Nothing changed since checkpoint 7." and exits with code 0 without creating a ref or appending an event

#### Scenario: Only the task changed
- **WHEN** only `.relay/task.md` changed since the latest checkpoint
- **THEN** a new checkpoint is saved

### Requirement: Large files are left out and listed
A file larger than `max_file_size_mb` (setting `[checkpoint] max_file_size_mb` in `~/.relay/config.toml`, default 20) SHALL be left out of the checkpoint, listed in the output, recorded in `Relay-Left-Out` trailers and in the event, and never changed by a rollback.

#### Scenario: Untracked video over the limit
- **WHEN** an untracked 48 MB file `assets/demo.mov` exists and the person runs `relay checkpoint`
- **THEN** the checkpoint does not contain `assets/demo.mov`
- **AND** the output includes the line `Left out assets/demo.mov (48 MB, over the 20 MB limit)`
- **AND** the commit has the trailer `Relay-Left-Out: assets/demo.mov`

### Requirement: Checkpoint event
Each saved checkpoint SHALL append a `checkpoint_saved` event and update `latest_checkpoint`, `checkpoint_count` and `updated_at` in `state.json`. Both changes SHALL be written after the refs are recorded, so they appear in the next checkpoint.

#### Scenario: Event content
- **WHEN** checkpoint 5 is saved with message "OAuth callback works" and one left-out file
- **THEN** `events.jsonl` gains one line with `"type":"checkpoint_saved"` and `data` holding `number` 5, `commit`, `kind` `manual`, `message`, `parent`, `head`, `branch`, `files_changed` and `left_out`

### Requirement: The person's state is never touched
`relay init`, `relay checkpoint` and `relay checkpoints` SHALL leave unchanged: what `HEAD` points to, every ref outside `refs/relay/`, every reflog, the bytes of every index file, the stash, and every file in the working tree outside `.relay/`.

#### Scenario: Full invariant check
- **WHEN** a scratch repository has a second branch, a tag, a stash entry, staged changes, unstaged changes, untracked files and ignored files, and the person runs `relay init` then `relay checkpoint`
- **THEN** a capture of the state described in design.md section 15, taken before and after, is identical

#### Scenario: Detached HEAD
- **WHEN** `HEAD` is detached at commit `abc1234` and the person runs `relay checkpoint`
- **THEN** the checkpoint is saved with `Relay-Branch: (detached)` and `HEAD` is still detached at `abc1234`

#### Scenario: Linked worktree
- **WHEN** the person runs `relay init` and `relay checkpoint` inside a linked worktree
- **THEN** the checkpoint contains that worktree's files, the index files of the main checkout and of the linked worktree are byte-for-byte unchanged, and the refs are visible from the main checkout

#### Scenario: Two worktrees, two jobs
- **WHEN** the main checkout and a linked worktree each have their own job
- **THEN** their checkpoints are stored under different `refs/relay/jobs/<job>/` prefixes and neither command reads or changes the other job's files

### Requirement: Commands need a job
`relay checkpoint`, `relay checkpoints` and `relay rollback` SHALL stop with exit code 3 when `.relay/state.json` is missing or invalid at the worktree root.

#### Scenario: Not set up
- **WHEN** the person runs `relay checkpoint` in a repository without `.relay/`
- **THEN** relay prints "relay is not set up here. Run relay init first." and exits with code 3

#### Scenario: Invalid state file
- **WHEN** `.relay/state.json` is not valid JSON or fails the schema
- **THEN** relay prints ".relay/state.json is damaged: <reason>. relay changed nothing." and exits with code 3

### Requirement: Listing checkpoints
`relay checkpoints [--json]` SHALL list the job's checkpoints, newest first, reading only the refs under `refs/relay/jobs/<job>/checkpoints/`.

#### Scenario: Text list
- **WHEN** job `3f9a2c1d` titled "Build authentication" has three checkpoints and the person runs `relay checkpoints`
- **THEN** relay prints a header line and one aligned row per checkpoint, for example:
  ```
  Job 3f9a2c1d · Build authentication

  3  1a2b3c4  before rollback  5 minutes ago  Before rolling back to checkpoint 2
  2  912ec1a  manual           2 hours ago    Login form done
  1  4be81c0  baseline         3 hours ago
  ```
- **AND** exits with code 0

#### Scenario: JSON list
- **WHEN** the person runs `relay checkpoints --json`
- **THEN** relay prints one JSON array, newest first, of objects with `number`, `commit`, `ref`, `kind` (`baseline`, `manual`, `pre_rollback`, `handoff` or `auto`), `message` (or null), `created_at`, `head` (or null) and `left_out`

#### Scenario: Checkpoint JSON output
- **WHEN** the person runs `relay checkpoint --json` and a checkpoint is saved
- **THEN** relay prints one JSON object with `saved` true, `number`, `commit`, `ref`, `files_changed` and `left_out`; when nothing changed it prints `{"saved":false,"latest":<n>}`
