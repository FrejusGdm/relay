# Design: the checkpoint engine

## Context

See proposal.md for why this change exists and what is out of scope. The requirements are in `specs/`. This document explains how to build them.

Phase 1 (the scaffold) provides the `relay` binary, a command router, `RELAY_HOME` (default `~/.relay`, overridable by the environment variable), loading of `~/.relay/config.toml`, and logging. This change adds commands to that router and modules under its source folder. If the scaffold uses a different folder layout, keep the module names below and place them under the scaffold's source root.

Facts checked on 2026-10-07 on git 2.39.0 in a scratch repository, and used below:

- A copy of the person's index file used through `GIT_INDEX_FILE`, followed by `git add -A`, `git add -f -- .relay`, `git write-tree`, `git commit-tree` and `git update-ref --stdin`, produces a checkpoint commit while the bytes of the person's `.git/index` stay identical.
- A pathspec file containing `.` and `:(exclude,literal)<path>` entries, passed with `--pathspec-from-file=<file> --pathspec-file-nul`, leaves the excluded paths out of the temporary index.
- `git update-ref --stdin` with `start`, `create <ref> <sha>`, `prepare`, `commit` fails with "reference already exists" when the ref exists, so two checkpoints cannot take the same number.
- `git read-tree <commit>` into a second temporary index, then `git checkout-index -f -z --stdin` with a list of paths, writes those files into the working tree and leaves the person's index unchanged.
- `git for-each-ref --format=...%(trailers:key=Relay-Kind,valueonly=true)...` reads trailer values directly.
- In a linked worktree, `git rev-parse --git-path index` returns the worktree's own index, while `--git-path info/exclude`, `--git-path hooks` and all refs come from the shared (common) git folder.

gitleaks facts, from its README and releases page on 2026-10-07 (https://github.com/gitleaks/gitleaks): the latest release is 8.30.1 (March 2026); the commands are `dir`, `git` and `stdin`; the flags `--config`, `--exit-code`, `--report-format json`, `--report-path`, `--redact`, `--gitleaks-ignore-path`, `--ignore-gitleaks-allow`, `--no-banner` and `--log-level` exist; without `--config` it loads `GITLEAKS_CONFIG`, `GITLEAKS_CONFIG_TOML` or a `.gitleaks.toml` from the scanned folder; exit code 1 means "leaks or errors"; JSON findings have the fields `RuleID`, `Description`, `StartLine`, `EndLine`, `File`, `Fingerprint` and others.

## Goals / Non-Goals

**Goals:**

- One code path that builds a checkpoint tree from the working tree, used by `relay init` (baseline), `relay checkpoint` and `relay rollback` (the checkpoint saved before rolling back).
- A git runner that makes it impossible to call git without the safety overrides.
- Exact, testable output text and exit codes.
- Tests that compare a full snapshot of the person's repository state before and after every command.

**Non-Goals:**

- Speed work for very large repositories beyond copying the person's index (see decision 3).
- Restoring the person's staging area during a rollback. Rollback restores files only.
- Windows support. The runner uses `/dev/null` for `core.hooksPath`.

## Decisions

### 1. Job ID: 8 random lowercase hexadecimal characters

`relay init` creates the job ID from 4 random bytes (`crypto.getRandomValues`) written as 8 lowercase hexadecimal characters, for example `3f9a2c1d`. Valid IDs match `^[0-9a-f]{8}$`. If `refs/relay/jobs/<id>/` already has refs, relay draws again (at most 5 times).

Why: refs, folder names and worktree names must be built only from relay's own IDs, never from text an agent or repository provides (security.md section 4, "Run git defensively", item 3). A random ID does not collide when refs from two machines meet later; a counter per repository would.

Alternative considered: a sequential number (`relay://job/184` in VISION.md). Rejected for now because it needs one counter shared by all machines. Phase 5 can add a short number in SQLite as a display alias.

### 2. Ref layout and checkpoint numbers

From architecture.md section 4 ("Hidden refs, not branches"):

```
refs/relay/jobs/<job>/checkpoints/<n>    one ref per checkpoint, n = 1, 2, 3, ...
refs/relay/jobs/<job>/latest             the newest checkpoint of any kind
```

The next number is the highest existing `<n>` plus one, read with `git for-each-ref --format=%(refname) refs/relay/jobs/<job>/checkpoints/`. Both refs are written in one transaction:

```
git update-ref --stdin
start
create refs/relay/jobs/<job>/checkpoints/<n> <sha>
update refs/relay/jobs/<job>/latest <sha> <previous latest sha>     (or: create refs/relay/jobs/<job>/latest <sha>)
prepare
commit
```

If the transaction fails because the ref exists, relay reads the numbers again and retries once; a second failure ends with exit code 6 and "Another relay command is saving a checkpoint for this job. Try again." The job lock (decision 10) makes this rare.

Refs outside `refs/heads/` are not shown by `git branch`, not pushed by a plain `git push`, and are shared by all worktrees (architecture.md section 4; security.md section 4, "Checkpoints on private references").

### 3. Building a checkpoint tree with a temporary index

From architecture.md section 4 ("How a checkpoint commit is built") and security.md section 4. Module `src/checkpoint/snapshot.ts`, function `buildSnapshotTree(repo, options) -> { tree, leftOut, added, changedPaths }`:

1. `tmp = $RELAY_HOME/tmp/<job>-<8 random hex>.index`. The folder `$RELAY_HOME/tmp` is created with mode 0700.
2. If the person's index exists (`git rev-parse --git-path index`), copy its bytes to `tmp` with a plain file copy (read only). Copying keeps git's cached file timestamps, so `git add -A` does not re-read every file. If there is no index (a new repository), start with no file; git treats a missing index as empty.
3. Find left-out paths (decision 5): list untracked files with `git ls-files -z --others --exclude-standard` and changed tracked files with `git ls-files -z --modified`, then `lstat` each in the working tree. A regular file larger than `max_file_size_mb` is left out. Untracked files whose names look secret are checked here too (decision 7).
4. Write a pathspec file `tmp.pathspec` with NUL-separated entries: `.` then `:(exclude,literal)<path>` for each left-out path and `:(exclude,literal).relay`.
5. `GIT_INDEX_FILE=tmp git add -A --pathspec-from-file=tmp.pathspec --pathspec-file-nul`
6. `GIT_INDEX_FILE=tmp git add -f -- .relay/task.md .relay/state.json .relay/checkpoint.md .relay/decisions.md .relay/events.jsonl`, plus `.relay/verify.md` when that file exists (`-f` because `/.relay/` is excluded; only the known job files, so a stray file in `.relay/` is never captured). `verify.md` is written by the next agent after a handoff (`add-relay-switch`, decision 13).
7. `tree = GIT_INDEX_FILE=tmp git write-tree`
8. Delete `tmp` and `tmp.pathspec` in a `finally` block.

The tree holds the working-tree version of every tracked file (staged or not) and every untracked, non-ignored file, never ignored files such as `node_modules` or `.env`. A tracked file that is left out keeps the version from the person's index copy, and its path is listed in `leftOut` so rollback never trusts it (decision 9). A file the person already staged, and has not changed since, is kept as staged whatever its size, because its content is already in the repository.

Alternative considered: `git read-tree HEAD` into the temporary index. Simpler, but git must then hash every file in the repository on every checkpoint. Alternative considered: `git stash create`. Rejected because it ignores untracked files and is easy to confuse with the person's stash (security.md section 4, "Rules relay should never break").

### 4. The checkpoint commit

`git commit-tree <tree> [-p <parent>] --no-gpg-sign` with the message on standard input:

- Parent: the job's `latest` checkpoint; for the first checkpoint, the current `HEAD` commit; no parent if the repository has no commits yet.
- `--no-gpg-sign`: `git commit-tree` honours `commit.gpgSign`, which would start `gpg` or `ssh-keygen` (and, on this Mac, a password prompt). Checkpoint commits are never signed.
- Author and committer: the person's `user.name` and `user.email` read with `git config --get`; if either is missing, `relay` and `relay@localhost`. They are passed as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` (earlier research on agent session formats, "Provider accounts, git identity, and remote authentication are separate", records commits failing for missing identity).

Message format (trailers from architecture.md section 4; `saveCheckpoint` accepts extra trailers from its caller, which `add-relay-switch` uses for `Relay-Worker` and `Relay-Target`):

```
relay checkpoint 5: OAuth callback works

Relay-Job: 3f9a2c1d
Relay-Checkpoint: 5
Relay-Kind: manual
Relay-Head: 86300b0b37343e5c06a5dfeb6be71f64dddfbed3
Relay-Branch: main
Relay-Left-Out: assets/video.mov
Relay-Version: 0.1.0
```

- The subject is `relay checkpoint <n>` alone when there is no message. The message is one line, at most 200 characters; newlines are replaced with spaces and invisible characters are removed with `removeInvisible` from `src/text/invisible.ts` (security.md section 5 "Prompt injection", recommendation 2). That module holds the one list of invisible characters for the whole program, which the adapters and the handoff also use: U+00AD, U+061C, U+180E, U+200B to U+200F, U+2028 and U+2029, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF, U+E0000 to U+E007F (tag characters, used to hide text) and U+E0100 to U+E01EF. `removeInvisible(text)` returns `{ text, removed }`.
- `Relay-Kind` is `baseline`, `manual` or `pre_rollback` (names from architecture.md section 3, `checkpoints.kind`), or one of the two kinds `add-relay-switch` saves through `saveCheckpoint`: `handoff` (the work checkpoint of a switch) and `auto` (saved by `relay run` when its agent exits). `relay checkpoints` shows them as `baseline`, `manual`, `before rollback`, `handoff` and `auto`.
- `Relay-Head` is the `HEAD` commit or `none`. `Relay-Branch` is the short branch name or `(detached)`.
- One `Relay-Left-Out` trailer per left-out path, at most 50; if more, the last one reads `and <k> more`.

### 5. Size limit

From architecture.md section 4: "refuse to snapshot files over a limit (for example 20 MB) and list them in the checkpoint instead". Setting `[checkpoint] max_file_size_mb = 20` in `~/.relay/config.toml`, an integer from 1 to 1024. Left-out files are printed, listed in the commit trailers and in the event, and are never changed by a rollback.

### 6. Secret scan with gitleaks, run by relay on text relay prepares

From security.md section 3, recommendation 3. Module `src/secrets/scan.ts`, with two exported functions: `scanCheckpoint(repo, { jobId, parentTree, newTree, message })`, described here, and `scanTexts(parts)`, described after it. Both also accept the command's environment (`env`, which names `RELAY_HOME` and `RELAY_GITLEAKS`; `process.env` when not given) and, for tests, a shorter time limit.

relay never lets gitleaks run git itself (its `git` command calls `git log -p` without relay's overrides). Instead relay builds the scan input:

1. The added lines of the checkpoint diff: `git diff-tree -p --text -U0 --inter-hunk-context=0 --no-renames --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -r <parent tree> <new tree>` (or against the empty tree, `git hash-object -t tree /dev/null`, when there is no parent). relay walks the patch: `--text` makes git show the added lines of every file, also of files that a NUL byte, the `binary` attribute or `-diff` (in `.gitattributes` or `info/attributes`) would otherwise reduce to "Binary files differ". `+++ b/<path>` gives the path (C-style quoted paths are unquoted; the tab git puts after an unquoted path with a space is removed), `@@ -a,b +c,d @@` gives the new line number, each line starting with `+` is copied to the input, and a context line (starting with a space) only takes a line number. A table maps each input line number to `{ path, line }`.
2. The full text of the `.relay/` job files in the new tree, mapped the same way.
3. The checkpoint message, mapped to `{ path: "(checkpoint message)", line: 1 }`.

The input is written to `$RELAY_HOME/tmp/<job>-<pid>-<hex>.scan` (mode 0600; `<pid>` is relay's process ID, and `scanTexts` uses `texts` in place of `<job>`) and scanned with:

```
gitleaks stdin --config <RELAY_HOME>/gitleaks.toml --gitleaks-ignore-path <RELAY_HOME>/tmp/<job>-<pid>-<hex>.ignore \
  --ignore-gitleaks-allow --redact --no-banner --log-level error \
  --report-format json --report-path <RELAY_HOME>/tmp/<job>-<pid>-<hex>.report.json --exit-code 42 < input
```

- `--config` points at a file relay writes at every scan with the content `[extend]\nuseDefault = true\n`, so a `.gitleaks.toml`, `GITLEAKS_CONFIG` or `GITLEAKS_CONFIG_TOML` cannot add allow rules. relay also removes those two variables from gitleaks' environment.
- `--gitleaks-ignore-path` points at an empty file, so a `.gitleaksignore` in the project cannot hide findings.
- `--ignore-gitleaks-allow` makes inline `gitleaks:allow` comments count as findings anyway, because an agent can write them.
- Result: exit 0 and an empty report means clean; exit 42 and a non-empty report means findings; anything else means the scan failed, and the checkpoint stops with exit code 1 and "The secret scan did not finish: <first line of gitleaks' error output>. Nothing was saved."
- Each finding becomes `{ path, line, rule }` using `StartLine` and the table; `Secret`, `Match` and `Line` from the report are never read into output or events. The scan input, the report and the ignore file are deleted in a `finally` block, and also when a signal stops relay (`src/core/cleanup.ts`, run by `main.ts`, which also stops gitleaks). Each scan first deletes scan files whose process ID no longer runs, left by a process that was killed. gitleaks that runs longer than 120 seconds is stopped, and the scan ends with "The secret scan did not finish: gitleaks did not finish within 120 seconds, so relay stopped it. Nothing was saved."

`scanTexts(parts: { label: string; text: string }[]): Promise<{ label: string; line: number; rule: string }[]>` scans texts that are not in a checkpoint yet (`add-relay-switch` uses it for the new `checkpoint.md`, the handoff notes, the instructions and the prompt). It builds one input from the parts with the same line-mapping table, where each part's label takes the place of a path, and runs the same `gitleaks stdin` command, configuration override, empty ignore file and clean-up. It returns the findings and never the secret; a scan that cannot finish throws the same error as above.

Why gitleaks: security.md section 3 names gitleaks and TruffleHog as the standard open-source scanners, and says gitleaks "can be embedded or called as a binary". relay is TypeScript, so it calls the binary. `relay init` checks `gitleaks version` and requires 8.28.0 or newer. Because the title and the branch name come from the person or an agent, `relay init` also scans the `task.md`, `state.json` and `job_started` texts it is about to write with `scanTexts`; a finding stops it with exit code 4 before anything is created.

Alternatives considered: TruffleHog (heavier, verifies secrets over the network, which relay should not do by default); a scanner written inside relay (more code to maintain, fewer rules). A known gap: the blob objects for a refused checkpoint already exist in `.git/objects` as unreferenced objects. They are never pushed, git's garbage collection removes them, and the secret is in the person's working tree anyway.

### 7. Untracked files whose names look secret

From security.md section 3, recommendation 4. While building the snapshot, an untracked, non-ignored file whose base name matches one of these patterns stops the checkpoint with exit code 4, unless the person approved it: `.env`, `.env.*` (except `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials.json`, `.npmrc`, `.pypirc`, `.netrc`, `kubeconfig`, `*.keystore`, `*.jks`. Matching is case-insensitive.

Approval: `relay checkpoint --include <path>` (repeatable). The path, relative to the worktree root, is added to `approved_paths` in `state.json`; approved files are still scanned by gitleaks. Approvals belong to the job (one job per checkout in this phase).

### 8. The safe git runner

From security.md section 4 ("Run git defensively"). Module `src/git/run.ts` exports `git(repo, args, options) -> { stdout: Uint8Array, stderr: string, code }`. It is the only place in the code that starts a git process. Two checks hold this: task 1.3's test fails if any other source file names `git` next to a process start, and in tests a guard program `test/fixtures/fake-provider/guard-bin/git`, first on `PATH`, exits with code 97 unless `RELAY_GIT_RUNNER=1` is set, which the runner sets for its own child (test helpers that build scratch repositories set it in plain view).

Every call runs `git` with these leading arguments, which take precedence over every configuration file:

```
-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c core.quotePath=false
-c diff.external= -c gc.auto=0 -c maintenance.auto=false -c commit.gpgSign=false
-c log.showSignature=false -c gpg.program=false -c gpg.ssh.program=false -c gpg.x509.program=false
-c core.logAllRefUpdates=false -c core.splitIndex=false
-c credential.helper= -c protocol.allow=never -c color.ui=false
-c hook.<event>.enabled=false   (once for each of the 28 hook events listed in githooks(5))
```

`core.hooksPath=/dev/null` does not stop hooks defined in configuration (`hook.<name>.command` and `hook.<name>.event`, git 2.54 and newer); `hook.<event>.enabled=false` does, and older versions ignore the unknown keys. `log.showSignature=false` stops `git log` and `git show` from checking signatures, and the three `gpg.*program=false` settings make any other signature check (for example a named format in the configuration that uses `%G?`) run `false`, a program that does nothing. `core.logAllRefUpdates=false` means relay's refs get no reflog, so a linked `logs/refs/relay` folder cannot make git append to a branch's reflog. `core.splitIndex=false` stops `git add` on a temporary index from writing a `sharedindex.*` file into the person's `.git` folder. Changed on 2026-10-08 after the protected-path review of task group 1, which ran a planted configuration hook through `update-ref` and `add`.

The environment is the parent environment with every variable starting with `GIT_` removed, then `GIT_OPTIONAL_LOCKS=0` (stops read commands from refreshing and rewriting the person's index), `GIT_ALLOW_PROTOCOL=` (empty: no transport is allowed, whatever a `protocol.<name>.allow` setting says, which also stops the lazy fetch of a partial clone), `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `LC_ALL=C`, `RELAY_GIT_RUNNER=1`, `GIT_INDEX_FILE` only when the caller passes a temporary index path, and `GIT_AUTHOR_*` and `GIT_COMMITTER_*` only when the caller passes an identity for `commit-tree` (decision 4). The working directory is always the worktree root (earlier research on agent session formats, "relay must choose and verify the working directory"). Standard input is closed unless the caller passes input. Git starts in its own process group. A call that runs longer than 120 seconds is stopped: the runner kills that whole group (git and any filter program it started) and throws "git <command> did not finish within 120 seconds, so relay stopped it." A git process killed while writing refs can leave a lock file such as `packed-refs.lock`; the next git command that needs it fails with git's own "Unable to create ... .lock: File exists" message, which relay prints with exit code 1. Removing that file is left to the person, after checking that no git command is running. Because git runs in its own process group, Control-C in the terminal reaches relay, not git. After git exits, the runner also ends the rest of its process group (`SIGTERM`, then `SIGKILL` after half a second), so a program a filter left in the background cannot keep running or hold the output pipes; the runner then reads what git wrote and waits at most 200 milliseconds for pipes that something outside the group still holds. The runner keeps the process groups of the git processes it started until each group is empty, and exports `stopGitProcesses()`, which sends `SIGTERM` to each group, waits up to half a second and then sends `SIGKILL` to what is left. `src/cli/main.ts` calls it in its `SIGINT` and `SIGTERM` handlers and before its normal exit, and keeps the interrupt's exit code when the command finishes while git is being stopped.

The runner allows only the commands relay uses in this change, `add-provider-adapters` and `add-relay-switch`, each with rules for its arguments, and throws before starting a process otherwise. This replaces the first deny list, which let through commands such as `worktree add -f -B`, `config <key> <value>`, `maintenance register`, `sparse-checkout`, `fast-import` and `merge-file`.

| Command | What is allowed |
|---|---|
| `version` | no arguments |
| `rev-parse`, `status`, `ls-files` | any arguments (they only read) |
| `symbolic-ref` | only `symbolic-ref [-q] [--short] HEAD` |
| `config` | only reading: `--get <key>`, `--get-all <key>` or `--list`, with `--file <path>`, `--show-origin`, `--show-scope`, `-z`, `--name-only`, `--includes` and the scope options |
| `for-each-ref` | any arguments except a format with `%(signature` |
| `cat-file` | any arguments except `--textconv` and `--filters` |
| `rev-list` | any arguments except `--show-signature` and `%G` format codes |
| `diff`, `diff-tree`, `log`, `show` | the runner adds `--no-ext-diff --no-textconv`; `--ext-diff`, `--textconv`, `--output`, `--show-signature` and any option with a `%G` format code (`%G?`, `%GS`, `%GK` and the others) are refused |
| `hash-object` | `-w`, `--stdin`, `--no-filters`, `-t <type>` and paths |
| `add` | with a temporary index; not `-e`, `-i`, `-p` or their long forms |
| `read-tree` | with a temporary index; exactly one tree, no options |
| `write-tree` | with a temporary index; no arguments |
| `checkout-index` | with a temporary index; only `-f`, `-z`, `--stdin`, `-q`, `-u`, `--index`, `-a` |
| `update-index` | with a temporary index; only `--add`, `--remove`, `--force-remove`, `--cacheinfo`, `--index-info`, `-z`, `--stdin`, `--refresh`, `-q` |
| `commit-tree` | `-p <commit>`, `--no-gpg-sign` and the tree |
| `update-ref` | refs under `refs/relay/` only, never `--create-reflog`, in the forms `[-m <reason>] [-d] <ref> ...` or `--stdin` with the commands `start`, `prepare`, `commit`, `abort`, `update`, `create`, `delete` and `verify`; never `-z`, quoted refs or the `symref-` and `option` commands |

`--output`, which makes `diff`, `log`, `show` and `rev-list` write to any file (`rev-list --output=.git/index` truncates the person's index), is refused for every command. git accepts any unambiguous beginning of a long option (`--textc` for `--textconv`), so a refused long option is also refused when shortened. An option whose full name is also the beginning of a refused one, such as `--text` (which `diff-tree` uses), is allowed, because git takes an exact name first. The runner adds `--no-deref` to every `update-ref`, so a ref under `refs/relay/` that was turned into a symbolic ref is replaced instead of moving the ref it points to. Before any `update-ref`, it also checks with `lstat` that `refs`, `refs/relay` and every folder down to the ref in the common git folder, and the ref file itself, are not symbolic links, and does the same for the ref's reflog path under `logs/`; a link there would make git write a branch or its reflog. No file on those paths may have a second hard link, and no reflog may exist for the ref at all: `core.logAllRefUpdates=false` stops git from creating reflogs, but git still appends to one that exists, and a planted one can be a hard link to the person's index or a branch's reflog. In tests the runner keeps a log of every argument list, so tests can assert which commands ran; when `RELAY_TEST_GIT_LOG=1` is set it also appends each argument list as one JSON line to `$RELAY_HOME/logs/git-calls.jsonl`, so tests that run the compiled binary can read it.

Filter programs (`filter.<name>.clean`, `smudge` and `process`) cannot be turned off for every name at once from the command line, and `git add` and `git status` run them. They come from configuration that the trust record (decision 11) covers, so a planted filter stops relay before it runs git; filters the person set up themselves, such as Git LFS, run as they would for the person.

Minimum git version: 2.34, checked once per command with `git version`.

### 9. Rollback

From architecture.md section 4 ("Rollback") and security.md section 4 ("Rollback guarantees"). Module `src/checkpoint/rollback.ts`.

1. Resolve the target: a checkpoint number, a commit prefix of at least 7 hexadecimal characters that matches exactly one checkpoint of this job, or nothing (the newest checkpoint whose kind is not `pre_rollback`).
2. Build the current snapshot tree (decision 3). Here untracked files with secret-like names (decision 7) that are not approved do not stop the command; they are added to `leftOut`, so they are protected as unsaved files in step 4.
3. Plan: `git diff-tree -r -z --no-renames --name-status <current tree> <target tree> -- . ':(exclude).relay'`. Status `A`, `M` and `T` mean "write the target version"; `D` means "delete".
4. Protect unsaved files. A path is unsaved if it exists on disk and either is in the current `leftOut` list or is not in the current tree (ignored files). Three more kinds of file stop the rollback, each with its own sentence in the exit-code-8 message: a file whose bytes on disk differ from the blob git stores for it (line-ending conversion, a clean filter or Git LFS), because the undo checkpoint could not give those exact bytes back; a file marked assume-unchanged or skip-worktree in the person's index whose content on disk differs from the index, because a checkpoint does not see it (the message names the flag and the `git update-index --no-<flag>` command); and a file or folder standing where the plan writes. Paths are compared as raw bytes, so names that are not valid UTF-8 are never confused. A file at a path the plan adds that is the same file (same device and inode) as one the plan deletes is a case-only rename on a file system that ignores case, not a file in the way. If any path to write or delete is unsaved, stop with exit code 8 and change nothing.
   Paths the target checkpoint left out (its `Relay-Left-Out` trailers and its `checkpoint_saved` event) are not part of the plan: the target's tree holds no current version of them.
5. If the plan is empty and no flagged file differs from the index: print "Nothing to roll back. Your files already match checkpoint <n>." and exit 0.
6. Show the plan and ask for confirmation (spec `rollback`). `--yes` skips the question; without a terminal and without `--yes`, exit 7.
7. Save the current state: if the current tree, ignoring `.relay/state.json` and `.relay/events.jsonl`, equals the tree of `latest`, reuse `latest` as the undo point; otherwise commit it as a `pre_rollback` checkpoint (decisions 2 and 4) after the secret scan. A finding stops the rollback before any file changes.
8. Delete planned `D` paths with `unlink`, then remove folders that became empty, walking up from each deleted file and stopping at the worktree root or at the first folder that is not empty.
9. Write planned `A`, `M`, `T` paths: `GIT_INDEX_FILE=<tmp2> git read-tree <target>` then `GIT_INDEX_FILE=<tmp2> git checkout-index -f -z --stdin` with the paths on standard input. This applies the person's line-ending and filter settings like a normal checkout, and keeps the person's index untouched.
10. Verify: build the snapshot tree again and compare it with the target, ignoring `.relay/`, unsaved paths, the paths the target left out, and files that were ignored before the rollback (restoring a `.gitignore` can make them visible). A difference ends with exit code 1, "Rollback finished, but these files do not match checkpoint <n>: ...", and the undo command.
11. Append a `rollback` event and update `state.json`.

`.relay/` is never restored or deleted by a rollback: the event log is append-only, and the task and decisions describe the job, not the code. Rollback never runs `git reset`, `git checkout` or `git restore`, never moves `HEAD` and never changes the index. If the person committed after the target checkpoint, their commits stay; the restored files then show as uncommitted changes.

### 10. Locking

A command that writes (`init`, `checkpoint`, `rollback`, `accept-git-changes`) holds `$RELAY_HOME/locks/<job>.lock`, created with the exclusive-create flag (`wx`), containing `{"pid":4121,"command":"checkpoint","started_at":"...","host":"..."}`. If the file exists and its process is gone on the same host (`process.kill(pid, 0)` fails with `ESRCH`), relay removes it and tries again. Only one process removes a stale lock at a time: it holds `<job>.lock.recover`, created with the exclusive-create flag, re-reads the lock under it, and removes it only if it still holds the same owner whose process is gone, so a live owner's lock is never removed. A recovery lock older than 10 seconds was left by a process that stopped while recovering, and is removed. Otherwise exit 6: "Another relay command is working on this job (relay checkpoint, process 4121). Try again when it finishes." `relay init` has no job yet; it relies on `mkdir .relay` failing when the folder exists.

### 11. The trust record for git configuration and hooks

From security.md section 4, "Run git defensively", item 2. Module `src/git/trust.ts`. Written at `relay init` to `$RELAY_HOME/jobs/<job>/git-trust.json` (folder 0700, file 0600), outside the project so that a sandboxed agent cannot rewrite it.

What is hashed (SHA-256 of the bytes; a missing file is recorded with `"sha256": null`; a file that is not a regular file, such as a pipe or a device, or that is larger than 10 MB, stops the command instead of being read, because reading it might never end; before the first `git config` call relay also checks that the global, XDG, system and repository configuration files are regular files or absent, because git itself would wait on a pipe there):

- Every configuration file git reads, found with `git config --list --show-origin --show-scope -z` (entries whose origin is `command line:` are skipped). This includes the system, global, repository and worktree files and any included files. The repository file (`git rev-parse --git-path config`) and, when `extensions.worktreeConfig` is on, `config.worktree` are always recorded, even if empty.
- `<common git folder>/info/attributes`.
- Every entry of `<common git folder>/hooks/`, and of the folder named by `core.hooksPath` when it is set and lies outside the worktree's own files (a folder inside the git folder counts as outside): name, file type and all permission bits as six octal digits (`stat.mode & 0o177777`, such as `100755`), and SHA-256 of the content (or of the link target for a symbolic link). The `core.hooksPath` folder is stored as `hooks_path`, `null` when there is none. Its value is expanded like git does (`~/` to the home folder, `~user/` to that user's home folder from `/etc/passwd`; a user relay cannot find stops the command), and symbolic links are resolved before deciding whether the folder is inside the project, so a project link such as `.husky` pointing outside the project is recorded.

Global configuration is included even though security.md names only `.git/config`, because git reads it the same way and an agent without a sandbox can edit it. The files and their keys come from one call, `git config --list --show-origin --show-scope -z`, which lists every key with the file it comes from. For each configuration file relay stores each key name with its number of occurrences (`count`) and an HMAC-SHA256 of its values in order (`values_hmac`), keyed with a random 32-byte salt kept in the record (`values_salt`). It also stores the same count and HMAC for each key across all files (`keys`), over the full ordered list of values exactly as `git config --list` reports them (all scopes, in git's order), and always compares both, even when no file's bytes changed: an `includeIf "onbranch:..."` that includes a file a second time, or an `include` moved past a key it overrides, changes which value wins without changing any file's bytes or keys. A key that changed only in this list is reported under "Stopped: the order in which git reads its settings changed since this job started." It never stores the values themselves. This lets a refusal name every key that was added, removed or changed, without copying secrets such as tokens in remote URLs: comparing key names alone missed a changed value whenever another key was added at the same time. The keyed hash is not the value, but whoever can read the record can test guesses of a short value against it; the file is readable only by the person. Key names that contain a URL (`url.<base>.insteadOf`, `http.<url>.*`, `credential.<url>.*`) are stored with the URL's user name and password replaced by `***`, and its query string and fragment replaced by `?***` or `#***`.

```json
{
  "schema_version": 1,
  "job_id": "3f9a2c1d",
  "recorded_at": "2026-10-07T20:31:05.123Z",
  "worktree_root": "/Users/josue/projects/app",
  "values_salt": "5be1…",
  "keys": [ { "name": "core.bare", "count": 1, "values_hmac": "a91f…" } ],
  "config_files": [
    { "path": "/Users/josue/projects/app/.git/config", "scope": "local", "sha256": "9b1c…", "keys": [
      { "name": "core.bare", "count": 1, "values_hmac": "07d4…" },
      { "name": "remote.origin.url", "count": 1, "values_hmac": "c2e8…" }
    ] }
  ],
  "attributes_file": { "path": "/Users/josue/projects/app/.git/info/attributes", "sha256": null },
  "hooks": {
    "dir": "/Users/josue/projects/app/.git/hooks",
    "entries": [ { "name": "pre-commit.sample", "mode": "100755", "sha256": "4f2a…" } ]
  },
  "hooks_path": null
}
```

The check runs before any other git command in `checkpoint`, `rollback` and `checkpoints`; only `git rev-parse` and `git config --list` run before it, and neither starts hooks or the file-system monitor. A mismatch ends with exit code 5 and the message in the `git-safety` spec. `recordTrust` removes a stale `git-trust.json.tmp` (or a link planted under that name), creates the temporary file with exclusive-create and no-follow flags and mode 0600, flushes it to disk, renames it over `git-trust.json` and flushes the folder. A missing or damaged record (any field of any element missing or of the wrong type) throws `TrustRecordError` with "The git trust record <path> is missing." or "... is damaged.", so `relay accept-git-changes` can offer to write a new one. Before printing, every key name, path and hook name has its control characters (C0, DEL, C1) shown as `\xNN`, and the invisible characters of decision 4 and, in addition, every other Unicode format character and line or paragraph separator (categories Cf, Zl and Zp, such as U+061C, U+2028 and U+2029) shown as `\u{NNNN}`, so a crafted name cannot move the cursor or hide text in the report the person is asked to approve. Keys that can run programs are marked "(can run commands)": `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `core.askPass`, `core.gitProxy`, `core.alternateRefsCommand`, `diff.external`, `diff.*.textconv`, `diff.*.command`, `diff.tool`, `diff.guitool`, `merge.tool`, `merge.guitool`, `filter.*.clean`, `filter.*.smudge`, `filter.*.process`, `merge.*.driver`, `credential.helper`, `credential.*.helper`, `gpg.program`, `gpg.*.program`, `gpg.ssh.defaultKeyCommand`, `sequence.editor`, `include.path`, `includeIf.*.path`, `alias.*`, `uploadpack.packObjectsHook`, `hook.*.command`, `hook.*.event`, `pager.*`, `trailer.*.command`, `trailer.*.cmd`, `remote.*.uploadpack`, `remote.*.receivepack`, `remote.*.vcs`, `submodule.*.update`, `interactive.diffFilter`, `gc.recentObjectsHook`, `tar.*.command`, `imap.tunnel`, `sendemail.*Cmd` and `sendemail.smtpServer` (also with an identity, `sendemail.<identity>.*`), `difftool.*.cmd`, `difftool.*.path`, `mergetool.*.cmd`, `mergetool.*.path`, `guitool.*.cmd`, `browser.*.cmd`, `browser.*.path`, `man.viewer`, `man.*.cmd`, `man.*.path`, `web.browser`, `help.browser`, `instaweb.browser`, `instaweb.httpd`. `core.worktree` is marked "(changes where git writes files)".

`relay accept-git-changes` prints the same report without its last two lines (which point to this command) and without the leading "Stopped: " (a sentence that then starts with a word starts with a capital letter), asks "Trust these changes? Type yes to continue:", and on `yes` reads the settings and hooks again. If they differ in any hash from what the report described, it writes nothing and exits 7 with "The git settings or hooks changed while relay was waiting. Nothing was trusted. Run relay accept-git-changes again."; otherwise it writes the state the report described as the new `git-trust.json` and appends a `git_changes_accepted` event. When the record is missing or damaged, it prints the `TrustRecordError` message, says that it cannot tell what changed, lists the settings git reads now that are marked "(can run commands)" or "(changes where git writes files)" and the hooks that exist now (without `*.sample` files, which git never runs), and asks "Trust the current git configuration and hooks? Type yes to continue:". A record that is missing or damaged is never used to decide whether the job belongs to the checkout, so this recovery is always offered. The command refuses without an interactive terminal (standard input and standard output both TTYs), because agents run commands without one. This is not a proof that a person answered: a program running as the person, outside a sandbox, can start its own pseudo-terminal and answer, and it could also edit `git-trust.json` directly. That is the limit stated in proposal.md; agents must be sandboxed so they cannot write `RELAY_HOME`.

### 12. The `.relay/` files

Module `src/job/files.ts` (templates and writing), `src/job/state.ts` (the `state.json` type and validation), `src/job/events.ts` (appending and reading events). Exact templates and schemas are in the `job-files` spec. Choices:

- `state.json` is written whole to `state.json.tmp` and renamed, so a crash never leaves half a file. The engines keep writing it in every later phase; phase 5 reads it and does not generate it from SQLite (`add-daemon-api-and-status`, decision 9, a deliberate departure from architecture.md section 3, rule 2). Readers ignore fields they do not know, because later changes add fields (`current_worker` and `last_handoff` from `add-relay-switch`).
- `events.jsonl` gets one JSON object per line. Every append in the whole program goes through `appendEvent(job: JobRef, type: string, data: object)` in `src/job/events.ts`, and `readEvents(job)` reads the file; a test fails if any other file opens `events.jsonl` for writing. `appendEvent` holds `$RELAY_HOME/locks/<job>.events.lock` only while it reads the last complete line's `id`, assigns the next integer and appends the line with a single write that ends in `\n`. In this change the lock is a file created with the exclusive-create flag, retried every 10 ms for up to 2 seconds, with the same stale-process rule as the job lock (decision 10); `add-daemon-api-and-status` replaces the mechanism with `flock` without changing the function. A final line without `\n` (an interrupted write) is ignored when reading, unless it is a whole event whose newline was never written, which keeps its id; either way it is preceded by `\n` on the next append, so no two events share an id. Only relay writes events (architecture.md section 3, rule 1); every relay process that runs a command writes them through this one function, including the daemon in phase 5.
- Events never contain environment variables, secret values or command output (security.md section 3, recommendation 1).

### 13. Linked worktrees, detached HEAD, new repositories

Module `src/git/repo.ts`, function `openRepository(cwd)` returns `{ worktreeRoot, gitDir, commonDir, indexPath, isLinkedWorktree, head: { sha | null, branch | null, detached } }` from one call: `git rev-parse --is-bare-repository --is-inside-work-tree --path-format=absolute --show-toplevel --git-dir --git-common-dir` (`--path-format=absolute` matters: without it `--git-common-dir` prints a relative `.git`), then `git rev-parse --path-format=absolute --git-path index`, `git symbolic-ref -q --short HEAD` and `git rev-parse -q --verify HEAD^{commit}`.

- Run from a subfolder, relay uses the worktree root.
- In a linked worktree, `.relay/` lives at that worktree's root, the index copied is that worktree's index, and `info/exclude`, hooks and refs come from the common folder. Each worktree can hold its own job; refs do not collide because they contain the job ID. The exclude line `/.relay/` applies to every worktree's root.
- With a detached HEAD, everything works the same; `Relay-Branch` is `(detached)` and `state.json` records `"detached": true`.
- In a repository with no commits, the first checkpoint has no parent and `Relay-Head` is `none`.
- A bare repository, a folder outside any repository, and running inside the `.git` folder are refused with exit code 3.

### 14. Module layout

```
src/cli/commands/init.ts            relay init
src/cli/commands/checkpoint.ts      relay checkpoint
src/cli/commands/checkpoints.ts     relay checkpoints
src/cli/commands/rollback.ts        relay rollback
src/cli/commands/accept-git-changes.ts
src/cli/exit-codes.ts               phase 1 file; this change adds codes 3 to 8 (section 16)
src/cli/output.ts                   relative times ("2 minutes ago"), short hashes, prompts
src/git/run.ts                      the safe git runner (decision 8)
src/git/repo.ts                     repository discovery (decision 13)
src/git/trust.ts                    trust record and check (decision 11)
src/checkpoint/snapshot.ts          snapshot tree (decision 3), left-out and secret-name checks
src/checkpoint/save.ts              saveCheckpoint(): the one checkpoint function (below)
src/checkpoint/commit.ts            commit message, commit-tree, ref transaction (decisions 2, 4)
src/checkpoint/list.ts              reading checkpoints from refs
src/checkpoint/rollback.ts          rollback (decision 9)
src/secrets/scan.ts                 scanCheckpoint() and scanTexts() with gitleaks (decision 6)
src/text/invisible.ts               removeInvisible(): the one list of invisible characters (decision 4)
src/secrets/names.ts                secret-like file names (decision 7)
src/job/files.ts, state.ts, events.ts, id.ts, lock.ts
test/helpers/scratch-repo.ts        creates a temporary repository and RELAY_HOME
test/helpers/invariants.ts          snapshot of the person's state (below)
test/helpers/fake-gitleaks.ts       stand-in scanner for unit tests, selected with RELAY_GITLEAKS=<path>
test/checkpoint/*.test.ts
```

`saveCheckpoint(repo, { jobId, kind, message?, include?, trailers?, lockHeld? })` in `src/checkpoint/save.ts` runs the whole checkpoint sequence (trust check, lock, snapshot, secret-name check, comparison with `latest`, scan, commit, refs, event, `state.json`) and returns `{ saved, number, commit, ref, filesChanged, leftOut }`. `relay init`, `relay checkpoint`, `relay rollback`, `relay switch` and the daemon's checkpoint endpoint all call it. `lockHeld: true` means the caller already holds the job lock (`add-relay-switch` holds it for a whole switch), so the function does not take it again. It throws typed errors that each caller maps to exit codes (section 16) or API errors.

`RELAY_GITLEAKS` (path to the scanner program, default `gitleaks` on `PATH`; a relative path is resolved against the folder relay started in) exists so unit tests can use a fake. Integration tests use the real gitleaks. `RELAY_DOC_SAMPLES=1` makes the command tests print each command and its exact output, so the examples in `docs/checkpoints.md` are copied from real runs.

### 15. How the tests prove nothing of the person's is touched

`test/helpers/invariants.ts` exports `captureState(repoPath)`, run with `GIT_OPTIONAL_LOCKS=0` so the capture itself writes nothing. It records:

- `HEAD`: the output of `git symbolic-ref -q HEAD` and `git rev-parse HEAD`;
- every ref outside `refs/relay/` with its commit (`git for-each-ref --format='%(refname) %(objectname)'`), which includes branches, tags and `refs/stash`;
- `git stash list`;
- the bytes (SHA-256) of every file under `.git/logs/` (all reflogs) and of the index file of every worktree;
- every file in the working tree except `.git` and `.relay/`, including ignored files: path, mode, and SHA-256 of the content (link target for symbolic links);
- `git status --porcelain=v2 -z --untracked-files=all --ignored`.

Each command test calls `captureState` before and after and asserts deep equality, except rollback tests, which assert equality for everything except the working-tree files and then check those files separately. Tests run with `bun test`; scratch repositories and `RELAY_HOME` live in a fresh folder from `fs.mkdtemp(os.tmpdir() + "/relay-test-")`, removed after each test. Tests set `max_file_size_mb = 1` so the size-limit test writes a 2 MB file, not 21 MB. Following AGENTS.md, tests run on the Omarchy machine (the Mac has almost no free disk).

### 16. Exit codes and fixed messages

`src/cli/exit-codes.ts` defines these codes for every command in this change. If the scaffold already defines a table, these values are added to it.

| Code | Meaning | Example message |
|---|---|---|
| 0 | Done, including "nothing changed" and `--dry-run` | `Saved checkpoint 5 · 912ec1a` |
| 1 | Unexpected failure (git error, scan did not finish, rollback result differs) | `The secret scan did not finish: <reason>. Nothing was saved.` |
| 2 | Wrong arguments | `Checkpoint 9 does not exist. See relay checkpoints.` |
| 3 | Not possible here: not a repository, bare repository, not set up, already set up, damaged `state.json`, git older than 2.34, gitleaks missing | `relay is not set up here. Run relay init first.` |
| 4 | Stopped by the secret scan or by an untracked file with a secret-like name | `Stopped: possible secret in src/config.ts line 12 (github-pat).` |
| 5 | Git configuration or hooks changed since `relay init` | `Stopped: .git/config changed since this job started.` |
| 6 | Another relay command holds the job lock | `Another relay command is working on this job (relay checkpoint, process 4121). Try again when it finishes.` |
| 7 | Needs the person: cancelled, no terminal without `--yes`, `accept-git-changes` without a terminal, or the git settings or hooks changed while `accept-git-changes` waited | `Run again with --yes to roll back.` |
| 8 | Rollback would touch files relay has not saved | `Rolling back would overwrite files relay has not saved: <paths>. Move them or delete them yourself, then try again.` |

Other fixed messages:

- Git too old: `relay needs git 2.34 or newer. You have git <version>.`
- First checkpoint saved by `relay checkpoint` (its parent is `HEAD`): second line `<k> files differ from commit <short HEAD>`; in a repository with no commits: `<k> files saved`.
- Later checkpoints: second line `<k> files changed since checkpoint <n-1>` (`1 file changed` in the singular).
- Each left-out file adds a line `Left out <path> (<size> MB, over the <limit> MB limit)`.
- Untracked files included for the first time add a line `Included <path> (you approved it)`.

Event `data` fields, in addition to the common fields in the `job-files` spec:

| Type | `data` fields |
|---|---|
| `job_started` | `title`, `worktree_root`, `head`, `branch`, `detached`, `linked_worktree` |
| `checkpoint_saved` | `number`, `commit`, `kind`, `message`, `parent`, `head`, `branch`, `files_changed`, `left_out` |
| `checkpoint_refused` | `command` (`init`, `checkpoint` or `rollback`), `reason` (`secret_found`, `secret_like_file` or `git_changed`), and `findings` (`path`, `line`, `rule`), `files` or `changed` (paths) depending on the reason |
| `rollback` | `to_checkpoint`, `to_commit`, `undo_checkpoint`, `files_written`, `files_deleted` |
| `git_changes_accepted` | `changed` (paths of the files whose hashes changed), and `trust_record` (`missing` or `damaged`) only when the person rewrote a record relay could not read |

## Risks / Trade-offs

- [A program running as the same user without a sandbox can rewrite `git-trust.json`, `.relay/` and git's configuration.] → Stated as a limit in the documentation (security.md "Before a public open-source release" asks for a threat model). The runner's `-c` overrides still stop fsmonitor and hooks even if the trust check is bypassed.
- [Global configuration changes made by the person (for example a new `user.email`) stop checkpoints.] → The message says what changed and how to accept it in one command.
- [Copying the person's index brings flags such as `assume-unchanged` and `skip-worktree`; `git add -A` does not pick up changes to those files.] → Documented; such files keep their index version in the checkpoint. Sparse checkouts therefore work without deleting files that are not checked out.
- [`git add` runs `filter.*.clean` programs from configuration, for example Git LFS.] → Those programs come from configuration that is in the trust record, so a planted filter stops relay before `git add` runs.
- [A refused checkpoint leaves unreferenced blob objects in `.git/objects`.] → Never pushed; removed by git's normal garbage collection; see decision 6.
- [Changes inside git submodules are not captured; only the submodule's commit is recorded.] → Listed as out of scope.
- [Partial clones may fetch missing objects from the remote during `git add` or `diff-tree`.] → `protocol.allow=never` makes such a fetch fail instead of reaching the network; relay then exits 1 with git's message.
- [gitleaks may report false positives.] → The message names the file, line and rule, and says how to fix it; relay offers no way to skip the scan, by design (security.md section 3).
- [In-place rollback while an agent is still writing files would race with it.] → Agents are not managed in this phase; phase 3 must stop the agent before a rollback.

## Migration Plan

New feature, nothing to migrate. To undo the change for a project, delete `.relay/`, remove the `/.relay/` line from `.git/info/exclude`, and delete refs with `git for-each-ref --format='delete %(refname)' refs/relay/ | git update-ref --stdin`. `relay gc` comes later.

## Open Questions

- How GitHub stores and shows pushed `refs/relay/*` refs (architecture.md, "What I could not verify"). It only matters once pushing is decided.
