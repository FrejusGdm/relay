# Proposal: the checkpoint engine (phase 2)

## Why

relay's promise is that work survives when an agent stops, and that a bad agent run can be undone. Both depend on one thing being safe and reliable before any agent is involved: saving the state of a project as a git commit, and restoring it, without ever disturbing the person's branch, staging area, stash or uncommitted work. This is phase 2 of `docs/ROADMAP.md`, and every later phase (adapters, `relay switch`, the daemon) builds on it.

## What Changes

- **`relay init`** sets up a job in the current git checkout. It creates the `.relay/` folder with five files (`task.md`, `state.json`, `checkpoint.md`, `decisions.md`, `events.jsonl`) from fixed templates and schemas (a sixth job file, `verify.md`, is written later by agents during handoffs and stored in checkpoints when it exists), adds `/.relay/` to `.git/info/exclude`, creates a random job ID, records SHA-256 hashes of the git configuration files, `.git/info/attributes` and the hooks folder, and saves a first checkpoint (the "baseline") that captures the person's uncommitted work.
- **`relay checkpoint`** saves the whole working tree (tracked changes, staged changes, and untracked files that are not ignored) plus the `.relay/` job files as a commit under `refs/relay/jobs/<job>/checkpoints/<n>`. The same code is exposed as one function, `saveCheckpoint`, which later changes call with their own checkpoint kinds (`handoff` and `auto` from `add-relay-switch`). It builds the commit with a temporary git index file, so the person's branch, index and stash are never touched. Before writing anything it refuses to continue if the git configuration or hooks changed since `relay init`, and it runs a secret scan (gitleaks) on the checkpoint diff, the `.relay/` files and the checkpoint message. A finding stops the checkpoint. A second function, `scanTexts`, scans texts that are not files yet (used by `add-relay-switch` for handoff prompts). Each checkpoint appends one event to `events.jsonl` through `appendEvent`, the only function that writes that file, which holds a short lock so two relay processes never write at the same time.
- **`relay checkpoints`** lists the job's checkpoints, newest first, as text or JSON.
- **`relay rollback [<checkpoint>]`** shows which files will change, asks for confirmation, saves the current state as a new checkpoint first (so the rollback can be undone), then restores the files of the chosen checkpoint into the working tree. It never moves a branch, never changes the index, and never deletes a file that relay has not saved.
- **`relay accept-git-changes`** lets the person, in an interactive terminal only, accept a change to the git configuration or hooks after reviewing it, so checkpoints can continue.
- **One list of invisible characters.** `src/text/invisible.ts` removes zero-width, bidirectional and tag characters from checkpoint messages and titles; the adapters and the handoff use the same module.
- **A single safe git runner.** Every git command relay runs goes through one module that adds `-c core.fsmonitor=false -c core.hooksPath=/dev/null` and other overrides, and removes inherited `GIT_*` environment variables.
- **Behaviour in linked worktrees, with a detached HEAD and in a repository with no commits yet** is defined and tested.
- **Scratch-repository tests** prove that the person's branch tips, reflogs, index file bytes, stash and uncommitted files are identical before and after every command, and a tampering test proves that a planted `core.fsmonitor` command or hook never runs.

## Capabilities

### New Capabilities

- `job-files`: the `.relay/` folder of a job, its job files (the five that `relay init` creates, plus `verify.md` when an agent wrote it) with their templates and schemas, the locked event writer, how `relay init` creates the folder, and how it is kept out of the person's commits.
- `checkpoints`: saving the working tree as a commit under `refs/relay/...`, the ref layout, the commit message format, the size limit, the "nothing changed" case, listing checkpoints, and the guarantee that the person's branch, index, stash and files are untouched.
- `rollback`: restoring a chosen checkpoint into the working tree, with a preview, a confirmation, a checkpoint of the current state saved first, and the rules for files relay has not saved.
- `git-safety`: how relay runs git (hooks and file-system monitor disabled, sanitized environment, no signing, no pager), the hashes of git configuration and hooks recorded at `relay init`, the refusal when they change, and accepting a change.
- `secret-scanning`: scanning everything relay is about to write into a checkpoint, scanning texts on request (`scanTexts`), refusing untracked files whose names suggest secrets, and stopping on a finding without ever printing the secret.

### Modified Capabilities

None. No specs exist yet.

## Decisions pending Josué's decision

Approving this proposal approves the recommendations below. Each is listed in `docs/ROADMAP.md` under "Decisions waiting for Josué".

1. **Is `.relay/` committed to the project? Pending Josué's decision.** Recommendation: no. `.relay/` stays local, is listed in `.git/info/exclude`, and is stored only inside checkpoint commits. A `--share-task` option that commits `task.md` and `decisions.md` is not built in this change. Sources: `docs/research/security.md` section 3 ("A gitignore policy for `.relay/`") and `docs/research/architecture.md` section 3.
2. **Are checkpoint refs pushed? Pending Josué's decision.** Recommendation: no. relay never pushes in this change and has no setting to push. Pushing (for example to continue on the Omarchy machine) belongs to the multi-machine work. Sources: `docs/research/security.md` section 4 ("Rules relay should never break") and `docs/research/architecture.md` section 4 ("Hidden refs").
3. **Runtime.** This change assumes the runtime chosen in phase 1 (recommended: TypeScript on Bun, also pending). Source: `docs/research/architecture.md` section 1.

Two smaller choices are made by this proposal and are also approved with it: the job ID is 8 random lowercase hexadecimal characters (design.md, decision 1), and the secret scanner is the gitleaks program, which the person installs with `brew install gitleaks` (design.md, decision 6).

## Out of scope

- Agents, adapters and `relay run` (phase 3).
- Handoffs, `relay switch`, writing `checkpoint.md` content, and scanning handoff prompts (phase 4).
- The daemon, the local API, SQLite and `relay status` (phase 5). In every phase the process that runs a command writes the `.relay/` files and events itself; phase 5 keeps this.
- Creating worktrees for jobs. This change works in whichever checkout the person runs it in, including a linked worktree they created.
- Pushing or fetching checkpoint refs, `relay gc` and removing old checkpoints.
- Redacting secrets inside files (relay stops instead of cleaning), restoring the person's staging area, and capturing changes inside git submodules.

## Security

This change runs git outside any sandbox in repositories where agents work, and writes commits into the person's repository, so it follows `docs/research/security.md` section 4 in full:

- relay never runs `reset`, `clean`, `checkout -- .`, `stash`, `rebase`, `commit --amend`, `push`, or any command that moves a branch or writes the person's index. Checkpoints are built with `GIT_INDEX_FILE` pointing at a temporary file and recorded with `git update-ref` under `refs/relay/` only (security.md section 4, "Checkpoints on private references").
- Every git command runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`, with inherited `GIT_*` variables removed (security.md section 4, "Run git defensively", item 1). This addresses the "Beltdown" and "GitSpawn" attacks cited there.
- Hashes of every git configuration file, `.git/info/attributes` and the hooks folder are recorded at `relay init` and checked before every checkpoint and rollback; any change stops relay (security.md section 4, item 2). The hashes are stored under `RELAY_HOME`, outside the project, so an agent working inside the project cannot quietly update them.
- A secret scan runs before every checkpoint is recorded, and untracked files with secret-like names are refused unless the person includes them once (security.md section 3, recommendations 3, 4 and 6).
- Every rollback first saves the current state (security.md section 4, "Rollback guarantees").
- What relay cannot protect against: a program running as the same user without a sandbox can change anything relay can, including the stored hashes. This is stated in the documentation.

## Impact

- New source modules under `src/` (listed in design.md) and new tests under `test/checkpoint/`.
- New commands: `relay init`, `relay checkpoint`, `relay checkpoints`, `relay rollback`, `relay accept-git-changes`.
- New setting in `~/.relay/config.toml`: `[checkpoint] max_file_size_mb` (default 20).
- New files under `RELAY_HOME`: `jobs/<job>/git-trust.json`, `locks/` (the job lock `<job>.lock` and the event lock `<job>.events.lock`), `tmp/`.
- New external requirements: git 2.34 or newer, and gitleaks 8.28 or newer on `PATH` (checked by `relay init`; tests and CI install it).
- Depends on phase 1 (the scaffold): the `relay` binary and command router, `RELAY_HOME`, `config.toml` loading and logging.
