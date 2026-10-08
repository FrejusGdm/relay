# Jobs and checkpoints

This page describes how relay sets up a job in a git checkout, how it saves, lists and rolls back
checkpoints, and how it checks for secrets before it saves anything. The behaviour comes from the
OpenSpec change `add-checkpoint-engine` (`openspec/changes/add-checkpoint-engine/`). Today
`relay init`, `relay checkpoint`, `relay checkpoints`, `relay rollback` and the secret scan are
built. `relay accept-git-changes` comes with a later task of that change.

## Setting up a job

A job is one piece of coding work that relay follows in one git checkout. `relay init` sets one
up in the checkout that holds the current folder. It always works at the top folder of that
checkout (the worktree root), also when it is run from a subfolder.

```mermaid
flowchart TD
  start["relay init [--title text]"] --> checks{"Inside a git working tree that is not bare,<br/>with git 2.34 or newer?"}
  checks -- no --> refuse["Exit code 3.<br/>Nothing is created."]
  checks -- yes --> exists{"Is there a .relay folder<br/>at the worktree root?"}
  exists -- yes --> refuse
  exists -- no --> scanner{"Can gitleaks 8.28<br/>or newer run?"}
  scanner -- no --> refuse
  scanner -- yes --> excl{"Is info/exclude a regular file with one<br/>hard link, not a symbolic link, and writable?"}
  excl -- no --> refuse
  excl -- yes --> id["Draw a job ID: 8 random hexadecimal<br/>characters that no ref and no job folder uses"]
  id --> scan{"Does the secret scan find anything in the<br/>task.md, state.json and event texts?"}
  scan -- yes --> stop4["Exit code 4.<br/>Nothing is created."]
  scan -- no --> files
  subgraph project["In the project, at the worktree root"]
    files[".relay/task.md, checkpoint.md, decisions.md<br/>and events.jsonl"]
    state[".relay/state.json, written last"]
  end
  subgraph gitdir["In the common git folder"]
    exclude["info/exclude gets the lines<br/># relay: job files stay local<br/>/.relay/"]
  end
  subgraph home["In RELAY_HOME, outside the project"]
    trust["jobs/(job ID)/git-trust.json:<br/>hashes of the git settings and hooks"]
  end
  files --> exclude --> trust --> event["events.jsonl gets its first event, job_started"] --> state
  state --> baseline["Save checkpoint 1, the baseline<br/>(see Saving checkpoints)"]
```

The diagram shows what `relay init` checks and what it writes. Every check runs before relay
creates anything, so a refusal leaves the project, the git folder and `RELAY_HOME` as they were.
The title and the branch name come from the person or an agent, so relay scans the texts it is
about to write for secrets first. After the checks, relay writes four job files, adds the
exclude line, records the git trust record, appends the first event, and writes `state.json` last.
If one of these steps fails, or Control-C or `SIGTERM` stops relay, relay removes the files it
created in `.relay/` and the job's folder in `RELAY_HOME`, so `relay init` can run again; the
exclude line stays, because it does no harm and the next run finds it. A `.relay` folder without
`state.json` is therefore a set-up that did not finish, for example because the process was
killed; relay then says to delete the folder and run `relay init` again.

Last, `relay init` saves the first checkpoint of the job, called the baseline. It captures the
person's uncommitted work as it was when the job started, so the job can always return to that
point. When the baseline cannot be saved, for example because the secret scan found a token, the
job stays set up: relay prints why, exits with the code of that reason, and the next successful
`relay checkpoint` saves the baseline instead.

Here is a first run in a project in the home folder, followed by a second run in the same
place:

```
$ relay init --title Demo
Set up relay in ~/repo
Job 8e4650af
Wrote .relay/task.md, state.json, checkpoint.md, decisions.md, events.jsonl
Added /.relay/ to .git/info/exclude
Saved checkpoint 1 · 7ad5644 (baseline)
Next: write the goal in .relay/task.md
(exit code 0)

$ relay init
relay is already set up here (job 8e4650af).
(exit code 3)
```

Here the secret scan stopped the baseline, because an untracked file held a GitHub token:

```
$ relay init
relay is set up (job f6520256), but the baseline checkpoint was not saved.
Stopped: possible secret in src/config.ts line 2 (github-pat).
Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.
(exit code 4)
```

### The job files

| File | What it holds |
|---|---|
| `.relay/task.md` | The goal, the acceptance criteria and the plan. Its first line is `# <title>`, where the title is the `--title` value, or else the branch name, or else the worktree folder name. Newlines become spaces, invisible characters are removed, and the title is cut to 120 characters. |
| `.relay/state.json` | relay's record of the job: its ID, title, repository, starting commit and branch, latest checkpoint, approved paths and last rollback. relay replaces it whole, through a temporary file and a rename, so it is never half written. |
| `.relay/checkpoint.md` | A placeholder. The handoff (`relay switch`, a later change) writes the latest handoff here. |
| `.relay/decisions.md` | A heading for decisions about the job, which people and agents add. |
| `.relay/events.jsonl` | One JSON object per line for each fact relay records. Only `appendEvent` in `src/job/events.ts` writes it, while it holds a short lock in `RELAY_HOME/locks/`, so two relay processes never write at the same time. |

The exact templates and the `state.json` fields are in the `job-files` spec of the change. Events
hold the job's facts only: never environment values, command output or secret values.

### Why .relay stays local

relay adds `/.relay/` to the `info/exclude` file of the repository's common git folder, after the
comment `# relay: job files stay local`. That file works like a `.gitignore` that only this
clone sees, and it applies to every worktree of the repository, so the job files never show up in
`git status` and never enter the person's commits. relay never edits a tracked `.gitignore`. The
line is added once: in a linked worktree of a repository that already has it, relay says so
instead of adding it again. Here `~/wt` is a linked worktree of `~/repo`, which already has a job:

```
$ relay init
Set up relay in ~/wt
Job 1d5d2737
Wrote .relay/task.md, state.json, checkpoint.md, decisions.md, events.jsonl
/.relay/ is already in ~/repo/.git/info/exclude
Saved checkpoint 1 · 372a98b (baseline)
Next: write the goal in .relay/task.md
(exit code 0)
```

Keeping `.relay/` local is the recommendation of the change, pending Josué's decision. The job
files will still travel with the work, because every checkpoint stores them.

### When relay init refuses

| Exit code | When | Message |
|---|---|---|
| 3 | The folder is not inside a git repository | `This folder is not inside a git repository. Run relay init inside your project.` |
| 3 | The repository is bare | `This repository has no working tree. relay needs one.` |
| 3 | `.relay/` already exists at the worktree root | `relay is already set up here (job <id>).` |
| 3 | git is older than 2.34 | `relay needs git 2.34 or newer. You have git <version>.` |
| 3 | gitleaks is missing or older than 8.28 | `relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks` |
| 3 | `.git/info/exclude` or its folder is a symbolic link, the file has a second hard link, or the person cannot write to it | `relay cannot add /.relay/ to <path>: <reason>.` |
| 3 | `.relay` is a file, not a folder | `<path> exists but is not a folder. Move it away, then run relay init again.` |
| 4 | The secret scan found something in the title or the branch name | `Stopped: possible secret in .relay/task.md line 1 (github-pat).` and `Nothing was set up. Remove the secret from the title or the branch name, then run relay init again.` |
| 1 | A later step failed, for example the git trust record could not be written | the reason |
| 6 | Another relay process held the event lock for more than 2 seconds | `Another relay process (process <pid>) is writing to this job's event log. Try again when it finishes.` |
| 1, 3 to 6 | The job is set up, but the baseline was not saved | `relay is set up (job <id>), but the baseline checkpoint was not saved.`, then the reason, as for `relay checkpoint` below |

These samples come from the tests:

```
$ relay init
This folder is not inside a git repository. Run relay init inside your project.
(exit code 3)

$ relay init
This repository has no working tree. relay needs one.
(exit code 3)

$ relay init
relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks
(exit code 3)
```

When `.relay/` exists but its `state.json` cannot be read, relay still refuses, names the
problem, for example `relay is already set up here, but the job file <path> is missing.`, and
adds `If an earlier relay init was stopped before it finished, delete the .relay folder and run
relay init again.`

## Saving checkpoints

A checkpoint is a git commit that holds the whole state of the job's files at one moment: tracked
files with their current content, staged or not, untracked files that git does not ignore, and the
job files in `.relay/`. relay stores it under a private ref, `refs/relay/jobs/<job>/checkpoints/<n>`,
and never on a branch. Your branch, your staging area (the index), your stash and your files stay
exactly as they were. Run it whenever the work reaches a point worth keeping:

```
relay checkpoint [-m <text>] [--include <path>]... [--json]
```

`relay init` (for the baseline) and `relay checkpoint` both call one function,
`saveCheckpoint` in `src/checkpoint/save.ts`. `relay rollback` calls the same function for the
checkpoint it saves before a rollback, and a later change calls it for the checkpoint of a handoff.

```mermaid
sequenceDiagram
  participant C as relay checkpoint
  participant S as saveCheckpoint
  participant H as RELAY_HOME
  participant G as git, through src/git/run.ts
  participant L as gitleaks
  participant J as .relay/ files
  C->>S: the message and the --include paths
  S->>J: read state.json (job ID, approved paths)
  S->>G: git config --list, compared with jobs/(job)/git-trust.json
  Note over S,G: a changed setting or hook stops here with exit code 5
  S->>H: take the job lock locks/(job).lock, or stop with exit code 6
  S->>G: for-each-ref refs/relay/jobs/(job)/ for the numbers and latest
  S->>H: copy the person's index to tmp/(job)-(random).index
  S->>G: ls-files, add -A, add -f the job files and write-tree, all on the copy
  G-->>S: the new tree
  S->>H: delete the copy and the pathspec file
  Note over S: an unapproved secret-like file name stops here with exit code 4
  S->>G: diff-tree from the latest checkpoint to the new tree
  Note over S: nothing changed apart from state.json and events.jsonl, so stop with exit code 0
  S->>L: the added lines, the job files and the message
  L-->>S: no findings, or findings that stop with exit code 4
  S->>G: commit-tree --no-gpg-sign with the parent
  S->>G: update-ref --stdin creates checkpoints/(n) and moves latest
  S->>J: append checkpoint_saved to events.jsonl, rewrite state.json
  S->>H: release the job lock
  S-->>C: number, commit, files changed, files left out
```

The diagram shows one checkpoint, from top to bottom. relay first reads `state.json` to learn the
job, then checks that the git settings and hooks are the ones recorded when the job started; until
that check passes, it runs only `git rev-parse` and `git config`, which start no hooks. It then
takes the job lock, so two relay commands never save for the same job at once. To build the tree,
relay copies the person's index file to a temporary file under `RELAY_HOME/tmp` and points
`GIT_INDEX_FILE` at the copy, so `git add` and `git write-tree` write only the copy. The copy and
the list of excluded paths are deleted as soon as the tree exists, also when a step fails. If the
new tree differs from the latest checkpoint only in `.relay/state.json` and `.relay/events.jsonl`,
relay stops without saving. Otherwise gitleaks scans what the checkpoint adds (see "The secret
scan" below). Only then does relay create the commit, without signing it, and record it with one
`git update-ref` transaction that writes only under `refs/relay/`. The event and `state.json` are
written last, after the refs, so the next checkpoint stores them.

### What a checkpoint holds and leaves out

| Holds | Leaves out |
|---|---|
| Every tracked file, with its content in the working tree, whether or not it is staged | Files git ignores, such as `node_modules/` or `.env` |
| Every untracked file that git does not ignore | Files larger than the size limit (below) |
| In a sparse checkout, files outside the sparse definition, with the version in your index | Untracked folders that are git repositories of their own (listed as `Left out <folder>/ (a separate git repository)`) |
| `.relay/task.md`, `state.json`, `checkpoint.md`, `decisions.md` and `events.jsonl`, and `.relay/verify.md` when it exists | Any other file in `.relay/` |
| An untracked file whose name suggests secrets, once you include it | Such a file that you have not included: the checkpoint stops instead |

Before anything else, relay checks that the job named in `state.json` is the one `relay init` set
up in this checkout: its job ID and worktree root must match the trust record in `RELAY_HOME`.
Otherwise it stops with exit code 3, so a `state.json` changed to another checkout's job ID cannot
make relay write that job's refs.

The first checkpoint of a job has the commit `HEAD` pointed to as its parent, or no parent in a
repository without commits. Each later checkpoint has the previous one as its parent. The commit
message names the checkpoint and carries trailers that describe it:

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

The message given with `-m` becomes one line: newlines and tabs become spaces, other control
characters and invisible characters are removed, and it is cut to 200 characters. `Relay-Kind` is `baseline` for the first checkpoint of a
job, `manual` for `relay checkpoint` and `pre_rollback` for the checkpoint `relay rollback` saves
first; a later change adds `handoff` and `auto`.
`Relay-Head` is the commit `HEAD` pointed to (`none` without commits), and `Relay-Branch` is the
branch name, or `(detached)`. The author and committer are your `user.name` and `user.email`, or
`relay` and `relay@localhost` when they are not set. A checkpoint commit is never signed, even
when `commit.gpgSign` is set, so no signing program or password prompt starts.

An untracked folder that holds a git repository of its own is left out, because git would store
it only as a pointer to one of its commits, or fail when it has none yet. Like a large file, it
is listed in the output, the trailers and the event.

relay copies your index, so a file you marked with `git update-index --assume-unchanged` or
`--skip-worktree` keeps its index version in the checkpoint. Changes inside git submodules are not
stored; only the submodule's commit is.

### Files over the size limit

A file larger than `max_file_size_mb` megabytes (setting `[checkpoint] max_file_size_mb` in
`config.toml`, default 20, see `docs/config.md`) is left out. relay lists it in the output, in a
`Relay-Left-Out` trailer of the commit (at most 50 trailers; the last one then says
`and <k> more`) and in the event. A tracked file that is left out keeps the version in your index.
A file you staged earlier and did not change since stays in the checkpoint at any size, because
git already stores its content. When the only new file is one that is left out, nothing is saved,
and relay still lists the file under `Nothing changed since checkpoint <n>.`. Here the limit was
set to 1 MB:

```
$ relay checkpoint
Saved checkpoint 2 · 25c2cc8
1 file changed since checkpoint 1
Left out assets/demo.mov (2 MB, over the 1 MB limit)
(exit code 0)
```

### The secret scan and --include

Before relay records a checkpoint, gitleaks scans the lines it adds compared with its parent, the
full text of the job files and the message. A finding stops the checkpoint: relay creates no ref,
appends a `checkpoint_refused` event that holds only the path, line and rule of each finding, and
never prints or stores the secret. relay prints at most 20 findings, then the number of the
others.

```
$ relay checkpoint
Stopped: possible secret in src/config.ts line 12 (github-pat).
Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.
(exit code 4)

$ relay checkpoint -m "use token ghp_…"
Stopped: possible secret in (checkpoint message) line 1 (github-pat).
Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.
(exit code 4)
```

An untracked file that git does not ignore and whose name suggests secrets, such as `.env.local`,
`id_rsa` or `server.pem`, stops the checkpoint until you include it once with `--include`. relay
then adds the path to `approved_paths` in `state.json`, and later checkpoints include it without
the option. Only an `--include` path that named such a file, saved in that checkpoint, is added. An included file is still scanned. Example files such as `.env.example` need no
approval.

```
$ relay checkpoint
Stopped: .env.local is not ignored by git and may hold secrets.
Add it to .gitignore, or include it with: relay checkpoint --include .env.local
(exit code 4)

$ relay checkpoint --include .env.local
Saved checkpoint 2 · ff251b7
2 files changed since checkpoint 1
Included .env.local (you approved it)
(exit code 0)
```

### Where checkpoints live

```
refs/relay/jobs/<job>/checkpoints/<n>    one ref per checkpoint, n = 1, 2, 3, ...
refs/relay/jobs/<job>/latest             the newest checkpoint of any kind
```

The next number is the highest existing number plus one. Both refs are written in one
transaction that fails when the number is already taken, so a checkpoint ref is never
overwritten; relay then reads the numbers again and tries once more. Refs under `refs/relay/` are
not branches: `git branch` does not show them, a plain `git push` does not send them, and every
worktree of the repository shares them. relay never pushes them. To see them, run
`git for-each-ref refs/relay/`.

### Output and exit codes

```
$ relay checkpoint -m "Login form done"
Saved checkpoint 3 · 8348ca5
3 files changed since checkpoint 2
(exit code 0)

$ relay checkpoint
Nothing changed since checkpoint 1.
(exit code 0)

$ relay checkpoint --json
{"saved":false,"latest":1}
(exit code 0)

$ relay checkpoint -m "OAuth callback works" --json
{"saved":true,"number":2,"commit":"477a52eedeec2a01bf4a42a5bfbf8d0f155b0fb1","ref":"refs/relay/jobs/073fe2dd/checkpoints/2","files_changed":1,"left_out":[]}
(exit code 0)
```

The second line counts the files that changed since the previous checkpoint, not counting
`.relay/state.json` and `.relay/events.jsonl`. When `relay checkpoint` saves the first checkpoint
of a job, because the baseline was stopped, it says `<k> files differ from commit <short HEAD>`,
counting only your files, or `<k> files saved` in a repository without commits:

```
$ relay checkpoint
Saved checkpoint 1 · 4e42b5c
2 files saved
(exit code 0)
```

| Exit code | When | Message |
|---|---|---|
| 0 | Saved, or nothing changed | `Saved checkpoint <n> · <short commit>`, or `Nothing changed since checkpoint <n>.` |
| 1 | gitleaks did not finish, or git failed | `The secret scan did not finish: <reason>. Nothing was saved.` |
| 2 | An `--include` path outside the project | `relay: --include needs a path relative to the top folder of the project, not "../x".` |
| 3 | No job here, a damaged `state.json`, a `state.json` that names another checkout's job, or gitleaks missing | `relay is not set up here. Run relay init first.`, `.relay/state.json is damaged: <reason>. relay changed nothing.`, `.relay/state.json names job <id>, which relay init did not set up in this checkout. relay changed nothing.` |
| 4 | A possible secret, or an unapproved secret-like file name | see above |
| 5 | The git settings or hooks changed since `relay init` | `Stopped: .git/config changed since this job started.` and what changed (`docs/git-safety.md`) |
| 130 | Control-C or `SIGTERM` stopped relay while git was working | `relay was stopped before it finished. Nothing was saved.` |
| 6 | Another relay command holds the job lock | `Another relay command is working on this job (relay rollback, process 237063). Try again when it finishes.` |

Each saved checkpoint appends a `checkpoint_saved` event with `number`, `commit`, `kind`,
`message`, `parent`, `head`, `branch`, `files_changed` and `left_out`, and updates
`latest_checkpoint`, `checkpoint_count` and `updated_at` in `state.json`. A checkpoint stopped by
the trust check, a secret-like file name or the secret scan appends a `checkpoint_refused` event
with the reason `git_changed`, `secret_like_file` or `secret_found`.

## Listing checkpoints

`relay checkpoints` lists the job's checkpoints, newest first. It reads them with one
`git for-each-ref` call over `refs/relay/jobs/<job>/checkpoints/`, and takes the kind, the commit
`HEAD` pointed to and the left-out files from the trailers of each commit. It only reads: it
takes no lock, appends no event and changes no file. Like `relay checkpoint`, it first checks the
git trust record, and stops with exit code 5 when the git settings or hooks changed.

```
relay checkpoints [--json]
```

Each row shows the number, the short commit, the kind, how long ago the checkpoint was saved, and
the message given with `-m`. The kind `pre_rollback` is shown as `before rollback`.

```
$ relay checkpoints
Job 3712730d · main

3  f36427a  before rollback  1 second ago   Before rolling back to checkpoint 2
2  7d0b08a  manual           2 seconds ago  Login form done
1  a639714  baseline         3 seconds ago
(exit code 0)
```

With `--json`, relay prints one JSON array with the fields `number`, `commit`, `ref`, `kind`,
`message` (null without `-m`), `created_at`, `head` (null in a repository without commits) and
`left_out`:

```
$ relay checkpoints --json
[{"number":1,"commit":"ae5e9936d58952dd658e130d0b211ed080a0d8ed","ref":"refs/relay/jobs/8d117bdd/checkpoints/1","kind":"baseline","message":null,"created_at":"2026-10-08T03:09:03.000Z","head":null,"left_out":[]}]
(exit code 0)
```

## Rolling back

`relay rollback` returns the job's files to an earlier checkpoint. It is the only relay command
that writes the person's files, so it shows what will change first, saves the current files as a
new checkpoint before it changes anything, and never touches a file whose content relay has not
saved.

```
relay rollback [<checkpoint>] [--yes] [--dry-run]
```

The checkpoint is a number, or the beginning of its commit (at least 7 hexadecimal characters)
when that matches exactly one checkpoint of the job. Without one, relay uses the newest checkpoint
that was not saved before a rollback, so running `relay rollback` twice does not undo the first
rollback.

```mermaid
flowchart TD
  start["relay rollback"] --> trust{"Do the git settings and hooks<br/>match the trust record?"}
  trust -- no --> stop5["Exit code 5"]
  trust -- yes --> lock["Take the job lock, or exit code 6"]
  lock --> target{"Which checkpoint?"}
  target -- "unknown or ambiguous" --> stop2["Exit code 2"]
  target -- found --> snapshot["Build a tree of the current files<br/>on a copy of the index"]
  snapshot --> plan["Compare it with the checkpoint:<br/>the files to modify, add and delete,<br/>outside .relay/"]
  plan --> unsaved{"Would the plan write or delete<br/>a file relay has not saved?"}
  unsaved -- yes --> stop8["Exit code 8"]
  unsaved -- no --> empty{"Is the plan empty?"}
  empty -- yes --> nothing["Nothing to roll back, exit code 0"]
  empty -- no --> show["Print the plan"]
  show --> ask{"--dry-run, --yes,<br/>or the person's answer"}
  ask -- "--dry-run" --> dry["Exit code 0"]
  ask -- "no terminal, or not y" --> stop7["Exit code 7"]
  ask -- "--yes, or y" --> undo["Save the current files as the<br/>undo checkpoint, after the secret scan"]
  undo -- "a secret, or the files<br/>changed meanwhile" --> stopped["Exit code 4 or 7"]
  undo -- saved --> delete["Delete the planned files and<br/>the folders they leave empty"]
  delete --> write["Write the planned files with read-tree<br/>and checkout-index on a temporary index"]
  write --> check{"Do the files now match<br/>the checkpoint?"}
  check -- no --> fail["Exit code 1 and the undo command"]
  check -- yes --> done["Append the rollback event, update<br/>state.json, print the undo command"]
```

The diagram shows one rollback, from top to bottom. Every step down to the question changes
nothing: at each exit on the way, the files, the refs and the event log are as they were. relay
first checks the git trust record and takes the job lock, which it holds until the end, so no
other relay command saves a checkpoint while the person reads the plan. It builds a tree of the
current files the same way a checkpoint does, and compares it with the checkpoint's tree. `.relay/`
is never part of the plan. If a path in the plan holds a file relay has not saved, relay stops
with exit code 8 before it asks anything.

After the person agrees, relay saves the current files as a checkpoint of kind `pre_rollback`
with the message `Before rolling back to checkpoint <n>`. This is the undo checkpoint. When the
files equal the latest checkpoint apart from `.relay/state.json` and `.relay/events.jsonl`, the
latest checkpoint is the undo checkpoint and nothing new is saved. The undo checkpoint goes
through the secret scan like any other; when the scan finds something, relay stops before any
file changes. relay also checks that the files it just saved are the ones the plan was made from;
if they changed while relay was waiting for the answer, it stops with exit code 7 and asks the
person to run the command again.

Only then does relay change files. It deletes the planned files with `unlink`, and removes the
folders that became empty, walking up from each deleted file and stopping at the first folder
that still holds something. It reads the checkpoint into a temporary index file under
`RELAY_HOME/tmp` with `git read-tree`, and writes the planned files from it with
`git checkout-index -f -z --stdin`, which applies the person's line-ending and filter settings
like a normal checkout. Last, it builds a tree of the files again and compares it with the
checkpoint. A file that could not be written shows up here.

### What you see

relay prints the plan, then asks. `--dry-run` prints the plan and stops:

```
$ relay rollback 2 --dry-run
Roll back to checkpoint 2 · cb15386 (1 second ago, "Login form done")

  modify  src/auth.ts
  delete  src/new-helper.ts
  add     src/session.ts

3 files will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.
(exit code 0)
```

In a terminal, relay asks `Roll back? [y/N]`. Only `y` or `yes` rolls back; any other answer
prints `Cancelled. Nothing changed.` and exits with code 7.

```
$ relay rollback
Roll back to checkpoint 2 · 7e781fa (0 seconds ago, "Notes done")

  modify  notes.txt

1 file will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.
Roll back? [y/N] y
Saved checkpoint 3 · d059f61 (before rollback)
Rolled back to checkpoint 2 · 7e781fa
1 file changed
To undo: relay rollback 3
(exit code 0)
```

A program, such as an agent, runs relay without a terminal. Without `--yes`, relay prints the
plan, changes nothing and exits with code 7:

```
$ relay rollback 2
Roll back to checkpoint 2 · b92905e (1 second ago, "Login form done")

  modify  src/auth.ts
  delete  src/new-helper.ts
  add     src/session.ts

3 files will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.
Run again with --yes to roll back.
(exit code 7)
```

With `--yes`, relay prints the plan and rolls back without asking. Here a file lost its
executable bit (`run.sh`) and a symbolic link was replaced by a regular file (`link-to-readme`);
both come back as they were:

```
$ relay rollback 2 --yes
Roll back to checkpoint 2 · a2c3c95 (1 second ago, "Login form done")

  delete  gone/only.txt
  delete  keep/new.txt
  add     lib/a.ts
  modify  link-to-readme
  modify  run.sh
  modify  src/app.ts
  delete  src/new.ts

7 files will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.

Saved checkpoint 3 · 33bb125 (before rollback)
Rolled back to checkpoint 2 · a2c3c95
7 files changed
To undo: relay rollback 3
(exit code 0)
```

### Undoing a rollback

The last line names the undo checkpoint. Rolling back to it returns every file the rollback
changed to what it was before, byte for byte, and saves another undo checkpoint on the way. To keep
that promise, relay refuses (exit code 8) to roll back over a file whose bytes git would change when
it stores them (line endings, a clean filter or Git LFS), and over a file marked assume-unchanged or
skip-worktree whose changes git does not show; the message says which, and how to clear a flag:

```
$ relay rollback 3 --yes
Roll back to checkpoint 3 · 33bb125 (1 second ago, "Before rolling back to checkpoint 2")

  add     gone/only.txt
  add     keep/new.txt
  delete  lib/a.ts
  modify  link-to-readme
  modify  run.sh
  modify  src/app.ts
  add     src/new.ts

7 files will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.

Saved checkpoint 4 · 4831d51 (before rollback)
Rolled back to checkpoint 3 · 33bb125
7 files changed
To undo: relay rollback 4
(exit code 0)
```

When Control-C or `SIGTERM` stops relay while it writes files, relay stops git, removes its
temporary index and the job lock, and prints the undo command, because the undo checkpoint was
saved before the first file changed:

```
relay was stopped before the rollback finished.
To undo: relay rollback 3
```

### What a rollback never changes

A rollback writes and deletes only files in the working tree, outside `.relay/`. It never runs
`git checkout`, `git reset`, `git restore`, `git clean` or `git stash`, and the only index it
writes is its own temporary one. So:

- Your branch and `HEAD` stay where they are, and so do your commits. When you committed after
  the checkpoint, the restored files show as uncommitted changes, and relay says so:

  ```
  $ relay rollback 2 --yes
  Roll back to checkpoint 2 · 0ad441d (1 second ago)

    delete  one.txt
    delete  two.txt

  2 files will change. Your branch, commits and staged changes stay as they are.
  relay saves your current files as a checkpoint first, so you can undo this.

  Saved checkpoint 3 · ffb59d9 (before rollback)
  Rolled back to checkpoint 2 · 0ad441d
  2 files changed
  Your branch still points to 48f317a. The restored files show as uncommitted changes.
  To undo: relay rollback 3
  (exit code 0)
  ```

- Your staged changes (the index), your stash, your tags and your reflogs stay as they are.
- `.relay/` stays as it is: the task and the decisions describe the job, not the code, and the
  event log only grows. The rollback appends a `rollback` event with `to_checkpoint`,
  `to_commit`, `undo_checkpoint`, `files_written` and `files_deleted` (numbers, never file
  contents), and `state.json` records the same values in `last_rollback`.
- Files relay has not saved stay as they are: ignored files such as `node_modules/` or `.env`,
  files left out for their size, untracked files with secret-like names that you have not
  included, files you marked with `git update-index --assume-unchanged` or `--skip-worktree`
  (a checkpoint holds their index version, not what is on disk), folders that hold a git
  repository of their own, and submodules. When the plan would write or delete one of them,
  relay changes nothing and exits with code 8:

  ```
  $ relay rollback 2 --yes
  Rolling back would overwrite files relay has not saved: config/local.json. Move them or delete them yourself, then try again.
  (exit code 8)
  ```

relay never writes or deletes through a symbolic link. When a file or a symbolic link stands where
the checkpoint has a folder, relay deletes it first only if it is saved in the undo checkpoint;
otherwise it stops with exit code 8 and names it. A path in a checkpoint that leads outside the
project or into `.git` stops the rollback before anything changes.

### Output and exit codes

```
$ relay rollback 2 --yes
Nothing to roll back. Your files already match checkpoint 2.
(exit code 0)

$ relay rollback 9
Checkpoint 9 does not exist. See relay checkpoints.
(exit code 2)

$ relay rollback 9366907
9366907 matches more than one checkpoint. Use the checkpoint number.
(exit code 2)
```

When a file could not be written, for example because its folder is read-only, relay reports it
after the check and names the undo checkpoint:

```
$ relay rollback 2 --yes
Roll back to checkpoint 2 · a45dc82 (0 seconds ago)

  modify  locked/a.txt

1 file will change. Your branch, commits and staged changes stay as they are.
relay saves your current files as a checkpoint first, so you can undo this.

Saved checkpoint 3 · 534f541 (before rollback)
Rollback finished, but these files do not match checkpoint 2: locked/a.txt
To undo: relay rollback 3
(exit code 1)
```

| Exit code | When | Message |
|---|---|---|
| 0 | Rolled back, nothing to roll back, or `--dry-run` | `Rolled back to checkpoint <n> · <short commit>` |
| 1 | A file does not match the checkpoint afterwards, or git failed | `Rollback finished, but these files do not match checkpoint <n>: <paths>` |
| 2 | An unknown checkpoint, an ambiguous commit prefix, or a wrong argument | `Checkpoint 9 does not exist. See relay checkpoints.` |
| 3 | No job here, a damaged `state.json`, or a job without any checkpoint | `relay is not set up here. Run relay init first.` |
| 4 | The undo checkpoint was stopped by the secret scan | `relay could not save your current files before rolling back, so it changed nothing.`, then the secret-scan message |
| 5 | The git settings or hooks changed since `relay init` | `Stopped: .git/config changed since this job started.` |
| 6 | Another relay command holds the job lock | `Another relay command is working on this job (relay checkpoint, process 4121). Try again when it finishes.` |
| 7 | No terminal and no `--yes`, an answer other than `y`, or the files changed while relay waited | `Run again with --yes to roll back.`, `Cancelled. Nothing changed.` |
| 8 | The plan would write or delete a file relay has not saved | `Rolling back would overwrite files relay has not saved: <paths>. Move them or delete them yourself, then try again.` |
| 130 | Control-C or `SIGTERM` stopped relay | `relay was stopped before the rollback finished.` and the undo command |

A rollback while an agent is still writing files in the same checkout would race with it. Agents
are not managed yet; the change that starts agents (`add-provider-adapters`) must stop the agent
before a rollback.

## The secret scan

Checkpoint commits may be shared later, so relay scans everything it is about to store in one
before it records it, with the open-source scanner gitleaks. `src/secrets/scan.ts` holds two
functions: `scanCheckpoint`, which every checkpoint calls, and `scanTexts`, which the
handoff (a later change) calls for texts that are not files yet. Untracked files whose names
suggest secrets, such as `.env.local` or `server.pem`, are matched by `src/secrets/names.ts` and
stop a checkpoint until the person includes them once.

```mermaid
flowchart TD
  added["Lines the checkpoint adds:<br/>git diff-tree -p --text -U0<br/>--inter-hunk-context=0 between<br/>the parent tree and the new tree"] --> input
  jobfiles["The full text of the job files<br/>in the new tree"] --> input
  message["The checkpoint message"] --> input
  texts["Or, for scanTexts:<br/>labelled texts"] --> input
  input["One scan input in RELAY_HOME/tmp, mode 0600,<br/>and a table from each input line<br/>to its file or label and line"] --> run["gitleaks stdin with relay's own configuration,<br/>an empty ignore file, and allow comments ignored"]
  run --> result{"Result"}
  result -- "exit 0, empty report" --> clean["No findings"]
  result -- "exit 42, findings" --> findings["Each finding becomes path, line and rule.<br/>Secret, Match and Line are dropped."]
  result -- "anything else, or more<br/>than 120 seconds" --> failed["Exit code 1: The secret scan did not finish"]
  result -- "gitleaks cannot run" --> missing["Exit code 3: install gitleaks"]
  clean & findings & failed & missing --> cleanup["The input, the report and<br/>the ignore file are deleted"]
```

The diagram shows one scan. relay never lets gitleaks run git, because gitleaks would run it
without relay's safety settings. Instead relay builds the text to scan itself: the lines the
checkpoint adds compared with its parent, the full text of the job files, and the message. A
secret that was already committed on the person's branch is not reported again, because only
added lines are scanned. `--text` makes git show the lines of every file, so a NUL byte, the
`binary` attribute or `-diff` in `.gitattributes` cannot hide a file's lines from the scan. A
table remembers where each line of the input came from, so a finding can name the file and line,
such as `src/config.ts line 12`.

relay writes its own gitleaks configuration (`RELAY_HOME/gitleaks.toml`, which only turns on
gitleaks' default rules), passes an empty ignore file, turns off `gitleaks:allow` comments, and
removes the `GITLEAKS_CONFIG` and `GITLEAKS_CONFIG_TOML` variables. So nothing in the project, and
nothing an agent writes, can hide a finding. A finding holds the place and the rule, never the
secret, and the temporary files are deleted whether the scan succeeds or fails, and also when
Control-C or `SIGTERM` stops relay. Their names hold relay's process ID, so each scan also deletes
the files that a killed process left behind. gitleaks that runs longer than 120 seconds is
stopped, and the scan did not finish.

`relay init` checks that gitleaks 8.28 or newer can run, with `gitleaks version`, before it
creates anything. The environment variable `RELAY_GITLEAKS` names another scanner program; the
unit tests use it to run `test/helpers/fake-gitleaks.ts`. A relative path is resolved against the folder relay started in.
