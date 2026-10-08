# Spec Delta: git-safety

## Purpose

relay runs git outside any sandbox in repositories where agents work. This capability makes every git command relay runs immune to hooks, file-system monitors and other programs planted in git configuration, and stops relay when the git configuration or hooks change during a job.

## ADDED Requirements

### Requirement: Every git command runs with hooks and the file-system monitor disabled
Every git process relay starts SHALL receive `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, `-c hook.<event>.enabled=false` for every hook event, and the other overrides in design.md decision 8, and SHALL run with every inherited `GIT_*` environment variable removed, `GIT_OPTIONAL_LOCKS=0` and an empty `GIT_ALLOW_PROTOCOL` set and standard input closed unless relay passes input. Only one module SHALL start git processes.

#### Scenario: Planted file-system monitor never runs
- **WHEN** the repository's `.git/config` sets `core.fsmonitor` to a script that creates a marker file, the person has accepted that change, and relay runs `relay checkpoint` and `relay rollback --yes`
- **THEN** the marker file does not exist afterwards

#### Scenario: Planted hooks never run
- **WHEN** `.git/hooks/` contains executable `pre-commit`, `post-checkout`, `post-index-change` and `reference-transaction` hooks that create marker files, the person has accepted them, and relay saves a checkpoint and rolls back
- **THEN** no marker file exists afterwards

#### Scenario: Hooks defined in configuration never run
- **WHEN** `.git/config` defines `hook.<name>.command` with `hook.<name>.event` set to `reference-transaction` or `post-index-change`, and relay writes a ref or builds a checkpoint tree
- **THEN** the hook command does not run

#### Scenario: A protocol setting cannot open a transport
- **WHEN** the repository sets `protocol.ext.allow=always` and a remote whose URL uses `ext::`, and a git command relay runs would fetch from it (for example a lazy fetch in a partial clone)
- **THEN** git refuses the transport and the remote's command does not run

#### Scenario: Diff programs never run
- **WHEN** the repository configures an external diff program, a diff driver or a textconv program in `.gitattributes` and `.git/config`, or `log.showSignature=true` or a named format with `%G?` together with a `gpg.program`
- **THEN** relay's `diff`, `diff-tree`, `log` and `show` calls run none of these programs, and a format argument with a `%G` code is refused before git starts

#### Scenario: A split index setting writes nothing into .git
- **WHEN** the repository sets `core.splitIndex=true` and relay runs `git add` on a temporary index
- **THEN** no `sharedindex.*` file appears in the person's `.git` folder

#### Scenario: Inherited git variables ignored
- **WHEN** relay is started with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_EXTERNAL_DIFF` set to other paths
- **THEN** relay works on the repository of its current folder and never uses those values

#### Scenario: One place starts git
- **WHEN** the test suite runs
- **THEN** a test fails if any source file other than the git runner module starts a `git` process

### Requirement: Every git command has a time limit
relay SHALL start each git process in its own process group, SHALL stop the whole group when the process runs longer than 120 seconds, and SHALL stop every group still running before it exits, also when it is interrupted.

#### Scenario: A filter leaves a program in the background
- **WHEN** a filter program that git runs leaves a program running in the background after git finishes
- **THEN** relay stops that program and returns git's result without waiting for the time limit

#### Scenario: relay is interrupted while git runs
- **WHEN** relay receives `SIGINT` while a git process it started is waiting on a filter program
- **THEN** relay stops that git process and the filter program before it exits with code 130

#### Scenario: A git call that does not finish
- **WHEN** a git process relay started runs longer than the time limit
- **THEN** relay kills that process and every program it started, and stops with an error that names the git command

### Requirement: relay never runs commands that change the person's state
The git runner SHALL allow only the git commands and arguments listed in design.md decision 8 and SHALL refuse every other call before starting a process. Commands that write an index SHALL run only on a temporary index.

#### Scenario: Command not allowed
- **WHEN** code calls the git runner with `["stash", "push"]`, `["worktree", "add", "-f", "-B", "feature", "../x"]` or `["config", "user.email", "x@example.com"]`
- **THEN** the runner throws an error naming the command and no process starts

#### Scenario: symbolic-ref only reads HEAD
- **WHEN** code calls the git runner with `symbolic-ref` in any form other than `symbolic-ref [-q] [--short] HEAD`, including shortened or bundled options such as `--del` or `-qd`
- **THEN** the runner throws an error and no process starts

### Requirement: relay writes refs only under refs/relay/
relay SHALL create, move or delete refs only under `refs/relay/`, without reflogs. It SHALL refuse to write a ref when `refs`, `refs/relay`, any folder on the way to the ref, or the ref itself, is a symbolic link, and the same for the ref's path under `logs/`.

#### Scenario: Ref writes limited to relay's namespace
- **WHEN** code asks the runner to update a ref that does not start with `refs/relay/`
- **THEN** the runner throws an error and no process starts

#### Scenario: Symbolic link under refs/relay
- **WHEN** `.git/refs/relay` is a symbolic link to `.git/refs/heads`, and code asks the runner to write `refs/relay/main` or create `refs/relay/newbranch`
- **THEN** the runner throws an error, `main` does not move and no branch is created

#### Scenario: A planted reflog for a relay ref
- **WHEN** a file exists at `.git/logs/refs/relay/main`, for example a hard link to a copy of the index or to a branch's reflog, and code asks the runner to write `refs/relay/main`
- **THEN** the runner throws an error and the linked file is unchanged

#### Scenario: Symbolic link under logs/refs/relay
- **WHEN** `.git/logs/refs/relay` is a symbolic link to `.git/logs/refs/heads`, and code asks the runner to write `refs/relay/main`
- **THEN** the runner throws an error and the reflog of `main` is unchanged

### Requirement: Git configuration and hooks are recorded at job start
`relay init` SHALL record, in `$RELAY_HOME/jobs/<job>/git-trust.json` (folder mode 0700, file mode 0600), SHA-256 hashes of every git configuration file git reads, of `info/attributes`, and of every entry in the hooks folder, as described in design.md decision 11. It SHALL store configuration key names, and for each key its number of occurrences and an HMAC-SHA256 of its values keyed with a random salt kept in the record, but never the values themselves, so that a changed value is detected even when another key is added at the same time.

#### Scenario: Trust record written
- **WHEN** `relay init` succeeds
- **THEN** `git-trust.json` exists with `schema_version` 1, an entry for the repository's `config` file, an entry for `info/attributes` (with `sha256` null when it does not exist) and one entry per file in the hooks folder

#### Scenario: No configuration values stored
- **WHEN** `.git/config` contains `remote.origin.url=https://user:token123@example.com/repo.git`
- **THEN** `git-trust.json` contains the key name `remote.origin.url` and does not contain `token123`

#### Scenario: No credentials from key names stored
- **WHEN** `.git/config` contains a key `url.https://user:token456@example.com/?access_token=token789.insteadOf`
- **THEN** `git-trust.json` contains neither `token456` nor `token789`

### Requirement: relay refuses to run git after configuration or hooks change
Before any other git command in `relay checkpoint`, `relay checkpoints` and `relay rollback`, relay SHALL compare the current hashes with the trust record. On any difference it SHALL stop with exit code 5, append a `checkpoint_refused` event with reason `git_changed` when the command was a checkpoint or rollback, and print what changed.

#### Scenario: core.fsmonitor added after init
- **WHEN** after `relay init` an agent runs `git config core.fsmonitor "touch /tmp/pwned"` and the person runs `relay checkpoint`
- **THEN** relay prints:
  ```
  Stopped: .git/config changed since this job started.
    added  core.fsmonitor (can run commands)
  relay will not run git here until you check this change.
  If you made it yourself, run relay accept-git-changes in your terminal.
  ```
- **AND** exits with code 5, creates no checkpoint ref, and `/tmp/pwned` does not exist

#### Scenario: Hook added after init
- **WHEN** after `relay init` a file `.git/hooks/pre-commit` is created and the person runs `relay checkpoint`
- **THEN** relay prints "Stopped: the git hooks changed since this job started." followed by the line "  added  pre-commit", the same last two lines as above, and exits with code 5

#### Scenario: Value changed
- **WHEN** the value of the existing key `remote.origin.url` changes in `.git/config`, with or without other keys added
- **THEN** relay prints "Stopped: .git/config changed since this job started." and the line "  changed  remote.origin.url", next to any "added" or "removed" lines

#### Scenario: Include order changes which value wins
- **WHEN** `.git/config` includes a file that sets `core.pager`, sets `core.pager` itself after the include, and the include is then moved after its own `core.pager`
- **THEN** relay prints "Stopped: .git/config changed since this job started." with "  changed comments, spacing or the order of settings", then "Stopped: the order in which git reads its settings changed since this job started." and "  changed  core.pager (can run commands)", and exits with code 5

#### Scenario: A file included again without any byte changing
- **WHEN** a file is included both unconditionally and through `includeIf "onbranch:other"`, and the person switches to branch `other`
- **THEN** relay reports that file with "  changed  <key>" for each of its keys and exits with code 5

#### Scenario: A hooks folder linked from the project to outside it
- **WHEN** `core.hooksPath` is `.husky` and `.husky` is a symbolic link to a folder outside the project
- **THEN** the trust record holds that outside folder's hooks, and a changed hook there stops relay

#### Scenario: A pipe in place of a configuration file git reads first
- **WHEN** `~/.gitconfig` is a named pipe
- **THEN** relay stops with "relay will not run git here: <path> is not a regular file" before starting git

#### Scenario: Only comments or spacing changed
- **WHEN** `.git/config` changes but no key was added, removed or changed
- **THEN** relay prints "Stopped: .git/config changed since this job started." and the line "  changed comments, spacing or the order of settings"

#### Scenario: Crafted names cannot forge the report
- **WHEN** an added key is `filter.<ESC>[8m.clean` or an added hook's name contains `ESC[1A`, `ESC[2K` and a carriage return
- **THEN** every control and invisible character in the printed report is shown as `\xNN` or `\u{NNNN}`, including Unicode format characters and line and paragraph separators such as U+061C, U+2028 and U+2029

#### Scenario: A pipe in place of a recorded file
- **WHEN** `.git/info/attributes` is replaced by a named pipe
- **THEN** relay stops with an error that the file is not a regular file, without waiting on the pipe

#### Scenario: info/attributes changed
- **WHEN** `.git/info/attributes` is created after `relay init`
- **THEN** relay prints "Stopped: .git/info/attributes changed since this job started." and exits with code 5

#### Scenario: Change reverted
- **WHEN** the changed file is restored to its recorded content
- **THEN** `relay checkpoint` works again

#### Scenario: Global configuration changed
- **WHEN** `~/.gitconfig` changes after `relay init`
- **THEN** relay stops with exit code 5 and names `~/.gitconfig` in the message

### Requirement: Accepting a git change needs the person at a terminal
`relay accept-git-changes` SHALL print the refusal report without its last two lines and without the leading "Stopped: " (a sentence that then starts with a word starts with a capital letter), ask "Trust these changes? Type yes to continue:", and only on the answer `yes` read the settings and hooks again and, when they equal what the report described, write that state as the trust record and append a `git_changes_accepted` event. It SHALL refuse with exit code 7 when standard input or standard output is not a terminal. A terminal check cannot prove that a person answered: a program running as the person outside a sandbox can open its own pseudo-terminal, which is why agents must be sandboxed so they cannot write `RELAY_HOME`.

#### Scenario: Accepted at a terminal
- **WHEN** the person runs `relay accept-git-changes` in a terminal after a hook was added, and types `yes`
- **THEN** relay prints "Trusted the current git configuration and hooks." and exits with code 0, and the next `relay checkpoint` succeeds

#### Scenario: A change while relay waits for the answer
- **WHEN** the person runs `relay accept-git-changes` in a terminal, and a hook is added or changed after the report is printed and before the person types `yes`
- **THEN** relay prints "The git settings or hooks changed while relay was waiting. Nothing was trusted. Run relay accept-git-changes again.", exits with code 7, and does not change the trust record

#### Scenario: A missing or damaged trust record
- **WHEN** `git-trust.json` is missing, or is not a valid record (for example `{}` or `null`), and the person runs `relay accept-git-changes` in a terminal
- **THEN** relay prints "The git trust record <path> is missing." (or "is damaged."), lists the settings that can run commands and the hooks that exist now, asks "Trust the current git configuration and hooks? Type yes to continue:", and on `yes` writes a new record and appends a `git_changes_accepted` event with `trust_record` set to `missing` or `damaged`

#### Scenario: Run by an agent
- **WHEN** `relay accept-git-changes` runs without a terminal
- **THEN** relay prints "relay accept-git-changes must be run by you in a terminal." and exits with code 7 without changing the trust record

#### Scenario: Nothing changed
- **WHEN** no recorded file changed
- **THEN** relay prints "Nothing changed in the git configuration or hooks." and exits with code 0

### Requirement: relay never pushes
No command in this change SHALL push, fetch or contact a remote. This follows the recommendation pending Josué's decision that checkpoint refs are not pushed.

#### Scenario: Remote configured
- **WHEN** the repository has a remote `origin` and the person runs `relay init`, `relay checkpoint` and `relay rollback --yes`
- **THEN** no git process with `push`, `fetch`, `pull`, `ls-remote` or `remote update` is started, which the test checks through the runner's call log
