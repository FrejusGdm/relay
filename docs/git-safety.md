# How relay runs git

Last updated 2026-10-08, after task groups 1 and 2 of `add-checkpoint-engine` and the fixes
from their reviews.

relay runs git outside any sandbox, in repositories where agents have been working. An agent can
plant a program in the repository's git settings or hooks, and git would run that program the
next time relay calls it. This happened to other agent tools (see `docs/research/security.md`,
section 4, "Run git defensively"). This page explains how relay prevents it. The rules come from
design decisions 8 and 11 of `openspec/changes/add-checkpoint-engine/design.md`.

## One door for every git call

Every git process relay starts goes through the function `git()` in `src/git/run.ts`. Two checks
make sure of it. `test/git/only-runner.test.ts` reads every file under `src/` and fails if another
file names git next to a way of starting a process. And while tests run, the first `git` on `PATH`
is a guard program, `test/fixtures/fake-provider/guard-bin/git`, which stops with exit code 97
unless `RELAY_GIT_RUNNER=1` is set. The runner sets that variable for the git process it starts;
the test helpers that build scratch repositories set it in plain view. The test preload removes
the variable from the test process, and `only-runner.test.ts` fails if any file other than the
runner, the preload and the test helpers names it.

```mermaid
flowchart LR
  callers["relay code<br/>src/git/repo.ts, src/git/trust.ts,<br/>and later checkpoints and rollback"]
  subgraph runner["git() in src/git/run.ts"]
    check["1. Check the arguments<br/>only allowed commands, each with<br/>rules for its options"]
    links["2. For update-ref only<br/>refuse symbolic links on the way<br/>to the ref under refs/relay/"]
    env["3. Build the environment<br/>remove every GIT_ variable of the parent,<br/>add GIT_OPTIONAL_LOCKS=0, GIT_ALLOW_PROTOCOL=(empty),<br/>GIT_TERMINAL_PROMPT=0, GIT_PAGER=cat, PAGER=cat,<br/>LC_ALL=C, RELAY_GIT_RUNNER=1"]
    args["4. Build the command line<br/>git + the -c overrides + the arguments;<br/>diff, diff-tree, log and show also get<br/>--no-ext-diff --no-textconv;<br/>update-ref also gets --no-deref"]
    start["5. Start git in the worktree root,<br/>standard input closed,<br/>stopped after 120 seconds"]
  end
  gitproc["git process"]
  refused["Error: relay refused to run git ...<br/>(git does not run)"]

  callers --> check
  check -- "allowed" --> links --> env --> args --> start --> gitproc
  check -- "not allowed" --> refused
  links -- "symbolic link found" --> refused
```

The diagram follows one call. relay code passes the arguments it wants, such as
`["status", "--porcelain"]`. The runner first checks them against its allow list. If they break a
rule, it throws an error that names the command, and git never starts. For `update-ref`, it then
asks git where the common git folder is and checks the folders on the way to the ref. Otherwise it
builds a clean environment and a command line that starts with relay's settings, starts git in the
worktree root, and stops it if it runs longer than 120 seconds.

## What the runner adds

These settings come first on every command line. Settings given with `-c` take precedence over
every configuration file git reads, including one an agent edited.

| Setting | Why |
|---|---|
| `core.fsmonitor=false` | A file-system monitor named in the settings is a program git runs on `git status`. |
| `core.hooksPath=/dev/null` | Hooks in the hooks folder are programs git runs on many commands. With this setting git finds none. |
| `hook.<event>.enabled=false`, once for each of the 28 events in githooks(5) | Since git 2.54, hooks can also be defined in configuration (`hook.<name>.command`), and `core.hooksPath` does not stop those. This setting turns off every hook for that event. Older git versions ignore it. |
| `core.pager=cat` | A pager is a program. |
| `core.quotePath=false` | Paths come back as they are, not escaped. |
| `diff.external=` | An external diff program is a program. The runner also adds `--no-ext-diff --no-textconv` to `diff`, `diff-tree`, `log` and `show`, so neither an external diff program, nor a diff driver or textconv program named in `.gitattributes`, runs. |
| `gc.auto=0`, `maintenance.auto=false` | git does not start cleanup work in the background. |
| `commit.gpgSign=false` | Checkpoints are never signed. git 2.34 to 2.39 sign `commit-tree` commits when this setting is true, which would start `gpg` and possibly a password prompt. |
| `log.showSignature=false` | With `log.showSignature=true`, `git log` and `git show` start the signing program to check signatures. |
| `gpg.program=false`, `gpg.ssh.program=false`, `gpg.x509.program=false` | Any other signature check, for example a format named in the settings that uses `%G?`, runs `false`, a program that does nothing. The runner also refuses `%G` format codes in relay's own arguments. |
| `core.logAllRefUpdates=false` | relay's refs get no reflog, so a linked `logs/refs/relay` folder cannot make git append to a branch's reflog. |
| `core.splitIndex=false` | With a split index, `git add` on a temporary index writes a `sharedindex.*` file into the person's `.git` folder. |
| `credential.helper=` | No credential program runs. |
| `protocol.allow=never` | git may not use a transport to reach a remote. |
| `color.ui=false` | Output has no color codes. |

`protocol.allow=never` alone is not enough, because a setting such as `protocol.ext.allow=always`
in the repository allows one transport again. The `ext::` transport runs any command. So the
runner also sets `GIT_ALLOW_PROTOCOL` to an empty value, which allows no transport at all, whatever
the settings say. This also stops a partial clone from fetching a missing object from its remote.

The environment is the parent's environment without any variable whose name starts with `GIT_`.
Those variables could point git at another repository (`GIT_DIR`, `GIT_WORK_TREE`), another index
(`GIT_INDEX_FILE`), a program (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`) or extra settings
(`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`). The runner then adds `GIT_OPTIONAL_LOCKS=0`, which
stops read commands such as `git status` from rewriting the person's index, the empty
`GIT_ALLOW_PROTOCOL`, and `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `LC_ALL=C` and
`RELAY_GIT_RUNNER=1`. Only two things a caller asks for are added back: `GIT_INDEX_FILE` for a
temporary index, and the author and committer name and email for `commit-tree`.

Standard input is closed unless the caller passes input, so git can never wait for an answer. Git
starts in its own process group. If it runs longer than 120 seconds, the runner kills the whole
group, so a filter program git started stops too, and relay stops with the error "git <command>
did not finish within 120 seconds, so relay stopped it." A git process stopped while it writes refs
can leave a lock file, such as `.git/packed-refs.lock`. The next git command that needs it then
fails with git's own message, "Unable to create '...lock': File exists.", which relay prints with
exit code 1. The person removes the lock file after checking that no git command is running.
After git exits, the runner ends whatever is left in its process group, so a program that a filter
left in the background cannot keep running or keep git's output open. It then waits at most 200
milliseconds for the output pipes to close. Because git has its own process group, Control-C in
the terminal reaches relay and not git. So the runner keeps track of each git process group until
it is empty, and `stopGitProcesses()` stops them:
it asks each process group to end, waits up to half a second, then kills what is left. relay's
entry point, `src/cli/main.ts`, calls it when it receives `SIGINT` or `SIGTERM` and before every
normal exit.

## What the runner allows

The runner allows only the git commands that relay uses in phases 2 to 4, each with rules for its
arguments. Every other call is refused before git starts. Design decision 8 has the full table;
in short:

- Commands that only read: `version`, `rev-parse`, `status`, `ls-files`, `for-each-ref`,
  `cat-file`, `rev-list`, `diff`, `diff-tree`, `log`, `show`, and `config` in its reading forms
  (`--get`, `--get-all`, `--list`). Options that start a program or write a file, such as
  `--textconv`, `--ext-diff`, `--show-signature` or a format with a `%G` code, are refused.
  `--output` is refused for every command, because with it `diff`, `log` and `rev-list` write to
  any file, even the person's index.
- `symbolic-ref` only as `symbolic-ref [-q] [--short] HEAD`, which reads the current branch.
- Commands that write an index (`add`, `read-tree`, `write-tree`, `checkout-index`,
  `update-index`) only with a temporary index file, and only with the options relay uses.
- `hash-object` and `commit-tree`, which add objects to the repository but change nothing the
  person sees.
- `update-ref` only for refs under `refs/relay/`, and never with `--create-reflog`. With `--stdin`,
  every line is checked; lines with quoted refs, the `-z` form and the `symref-` and `option`
  commands are refused.

git accepts any unambiguous beginning of a long option, so `--textc` means `--textconv`. The
runner therefore refuses a shortened option too, except an option whose full name is also the
beginning of a refused one: `--text` is its own option, because git takes an exact name first. Everything else is refused, for example
`worktree`, `config user.email ...`, `archive --remote=...`, `maintenance`, `sparse-checkout`,
`fast-import`, and any name git would look up as an alias.

Two more checks protect branches from `update-ref`. The runner adds `--no-deref`, so a ref under
`refs/relay/` that an agent turned into a symbolic ref pointing at `refs/heads/main` is replaced
instead of moving `main`. And before every `update-ref`, it checks that `refs`, `refs/relay` and
every folder on the way to the ref, and the ref file itself, are not symbolic links, and checks the
ref's reflog path under `logs/` the same way. No file on those paths may have a second hard link.
And no reflog may exist for the ref at all: relay never creates reflogs, but git appends to one
that exists, so a planted `logs/refs/relay/main` that is a hard link to the person's index or to a
branch's reflog would be written. Without this check, a link from `.git/refs/relay` to
`.git/refs/heads` would let `update-ref refs/relay/main` move the person's `main` branch, and a
link from `.git/logs/refs/relay` would let git write into the branch's reflog.

## Finding the repository

`openRepository(cwd)` in `src/git/repo.ts` first checks that git is 2.34 or newer, then asks git
for the worktree root, the git folder, the common git folder (shared by all worktrees), the index
path, the branch and the `HEAD` commit. It works from a subfolder, in a linked worktree, with a
detached `HEAD` and in a repository with no commits. It refuses, for exit code 3, a bare
repository, a folder outside any repository and the inside of a `.git` folder.

## How the tests prove it

`test/git/run.test.ts` tries to break each rule. It plants a file-system monitor, hooks in
`.git/hooks`, in a configured hooks folder and in configuration, an external diff program, a diff
driver and a textconv program, a signing program, a transport allowed by `protocol.ext.allow`, an
alias, symbolic links under `refs/relay`, and `GIT_` variables that point elsewhere. It checks
that none of the planted programs runs, that no branch moves, and that git works on the right
repository. Where possible it first runs plain git, without the runner, to show that the planted
program does run there. It also checks that each refused call starts no git process, and that a
git process that runs too long is stopped.

`test/helpers/invariants.ts` provides `captureState()`, which records the person's `HEAD`, refs
(with the target of symbolic refs), stash, reflogs, index files, `.git/config`, `config.worktree`,
`info/attributes`, the hooks folder, working-tree files (ignored files included) and `git status`.
It stops if any git command it runs fails. Tests take a capture before and after relay works and
compare the two.

## The trust record

The runner's settings stop hooks and the file-system monitor, but git settings can name other
programs too. For example, `git add` runs the "clean" program of a filter named in the settings.
So relay also notices when the git settings or hooks change during a job. `recordTrust()` in
`src/git/trust.ts` writes a record when a job starts, and `compareTrust()` checks it later. The
record is the file `$RELAY_HOME/jobs/<job>/git-trust.json`. It lives outside the project, so an
agent that is sandboxed to the project cannot rewrite it. Its folder has mode 0700 and the file
has mode 0600.

The record holds a SHA-256 hash of each of these:

- Every configuration file git reads, as `git config --list --show-origin` reports them: the
  system file, the global files (`~/.gitconfig` and `~/.config/git/config`), the repository's
  `config`, `config.worktree`, and every file they include. The repository's `config` is always
  recorded, and so is `config.worktree` when the repository turns on worktree settings
  (`extensions.worktreeConfig`), even when the file is empty or missing. A missing file is
  recorded with `"sha256": null`. relay lists the files and their keys with one call,
  `git config --list --show-origin --show-scope -z`.
- `info/attributes` in the common git folder, which can turn on filters for any file.
- Every entry of the `hooks` folder in the common git folder, with its name, its file type and
  permission bits (such as `100755`) and the hash of its content. For a symbolic link, relay
  hashes the path the link points to.
- The same for the folder named by `core.hooksPath`, when it is set and lies outside the
  project's files. It is stored as `hooks_path`. A hooks folder inside the project, such as
  `.husky`, is part of the project's files, so checkpoints save it instead.

relay reads only regular files. If a recorded path is a named pipe or a device, or a file larger
than 10 MB, relay stops with an error instead of reading it, because reading a pipe can wait
forever. git itself would wait on a pipe too, so before its first `git config` call relay checks
that `~/.gitconfig`, `~/.config/git/config`, the system file (`/etc/gitconfig` or the one next to
the installed git) and the repository's `config` and `config.worktree` are regular files or
absent. A pipe in an included file is stopped by the runner's time limit instead.

For `core.hooksPath`, relay expands `~/` and `~user/` as git does and resolves symbolic links
before it decides whether the folder is part of the project. A project link such as `.husky` that
points outside the project is therefore recorded.

For each configuration file, the record also stores the names of its keys, such as
`remote.origin.url`, but never their values, because values can hold secrets such as a token in a
remote URL. To notice a changed value anyway, it stores for each key the number of times the key
occurs and an HMAC-SHA256 of its values. An HMAC is a hash computed with a secret key; here the
key is a random 32-byte salt, kept in the record as `values_salt`. The hash shows whether a value
changed without containing the value. Someone who can read the record could still test guesses
of a short value against it, which is one more reason the file is readable only by the person.

The record keeps these counts and hashes twice: once for each file, and once for each key across
all files, over every value in the order git reads them. relay compares both every time, even
when no file's bytes changed. The second list catches changes in which value wins: moving an
`include` line past a key it overrides, or an `includeIf "onbranch:..."` that reads a file a
second time after the person switches branches. Such keys are listed under "Stopped: the order in
which git reads its settings changed since this job started."

A key name can hold a URL too, as in `url.https://user:token@example.com/?access_token=x.insteadof`.
relay stores such a name with the user name and password replaced by `***`, and with the query
string and fragment replaced by `?***` and `#***`.

A record that is missing, or in which any field has the wrong type, makes `compareTrust()` throw
a `TrustRecordError` that says "The git trust record <path> is missing." or "... is damaged.".
relay writes the record to a temporary file, flushes it to disk and then renames it, so a crash
never leaves half a record. It first removes any old temporary file, and creates the new one only
if nothing has that name, without following links, so a link planted there cannot make relay
write to another file.

```mermaid
flowchart TD
  init["relay init"] --> record["recordTrust()<br/>hash the config files, info/attributes<br/>and hooks; keep key names, counts<br/>and keyed hashes of values"]
  record --> file[("$RELAY_HOME/jobs/&lt;job&gt;/git-trust.json<br/>folder 0700, file 0600")]
  later["relay checkpoint, relay checkpoints,<br/>relay rollback"] --> compare["compareTrust()<br/>read the same things again<br/>with git config and git rev-parse only"]
  file --> compare
  compare -- "nothing changed" --> work["run the other git commands"]
  compare -- "something changed" --> stop["print what changed<br/>and exit with code 5"]
  stop -. "the person checks the change" .-> accept["relay accept-git-changes<br/>in a terminal"]
  accept --> record
```

The diagram shows the life of the record. `relay init` writes it. Before `relay checkpoint`,
`relay checkpoints` or `relay rollback` runs any other git command, relay reads the same files
again and compares them with the record. To find the files, it runs only `git config` and
`git rev-parse`, which start no hooks and no file-system monitor. If nothing changed, the command
goes on. If something changed, relay prints what changed and stops with exit code 5. The person
can then look at the change and, if they made it themselves, run `relay accept-git-changes` in a
terminal, which writes a new record. (The commands and `relay accept-git-changes` come in later
task groups of the same change; task group 2 adds the record, the comparison and the text.)

A comparison finds a file that git now reads but did not read before, such as a new
`~/.gitconfig`, a file that git no longer reads, and a file whose bytes changed. Restoring a file
to its recorded bytes makes the comparison equal again. When relay stops, it prints one block for
each changed file and then two closing lines. For example, after an agent runs
`git config core.fsmonitor "touch /tmp/pwned"`:

```
Stopped: .git/config changed since this job started.
  added  core.fsmonitor (can run commands)
relay will not run git here until you check this change.
If you made it yourself, run relay accept-git-changes in your terminal.
```

Each block names the file. Files in the project are shown relative to it, such as `.git/config`,
and files in the home folder start with `~/`, such as `~/.gitconfig`. Under a configuration file,
relay lists the keys that were added, removed or changed, as `added  <key>`, `removed  <key>` and
`changed  <key>`. A key is changed when its number of occurrences or its values changed. Keys that
can make git start a program, such as `core.fsmonitor`, `filter.*.clean`, `pager.*` or `alias.*`,
are marked "(can run commands)"; design decision 11 has the full list. `core.worktree` is marked
"(changes where git writes files)". When the file changed but no key did, the line is "changed
comments, spacing or the order of settings". Changed hooks are listed under "Stopped: the git hooks changed since this job started."
with `added`, `removed` or `changed` before each name. `test/git/trust-report.test.ts` compares
this text with the `git-safety` spec byte for byte.

The person is asked to approve this report, so it must show exactly what changed. A key name or a
hook name can contain any character, including terminal control sequences that move the cursor,
erase a line or hide text. Before printing, relay shows control characters (C0, DEL and C1) as
`\xNN`, and the invisible characters of design decision 4 and every other Unicode format
character and line or paragraph separator (such as U+061C, U+2028 and U+2029) as `\u{NNNN}`. For example, a filter
section named with the escape sequence `ESC[8m` prints as `filter.\x1B[8m.clean`.

### What the trust record does not cover

- `.gitattributes` files in the project and the global attributes file (`core.attributesFile`,
  by default `~/.config/git/attributes`). They can apply a filter or a diff program to more
  files, but only one that is already named in the recorded settings. Checkpoints save the
  project's `.gitattributes` files.
- The content of the file a hook link points to. relay records where the link points, not what
  the file there contains. relay never runs hooks itself, because of `core.hooksPath=/dev/null`.
- The settings and hooks of submodules, in `.git/modules/`. relay does not look inside
  submodules.
- Settings that live outside configuration files, such as the `git` program found on `PATH`, or
  environment variables other than the `GIT_` ones the runner removes.
- A change made after the comparison, while the command runs. The runner's settings still stop
  hooks and the file-system monitor in that case.
- A change that the person's own git commands make on purpose, such as a different file included
  with `includeIf "onbranch:..."` after switching branches, also stops relay until the person
  accepts it.

## What this does not cover

- Filter programs. `git add` and `git status` run the `clean` program of a filter named in
  `.gitattributes` (`filter.<name>.clean`, `smudge` and `process`). git has no setting that turns
  off every filter at once, so the runner cannot stop them. They come from configuration that the
  trust record covers: a filter an agent adds stops relay before it runs git.
  Filters the person set up themselves, such as Git LFS, run as they would for the person.
- A program running as the same user without a sandbox can change anything relay can, including
  `git-trust.json` itself and the folders under `refs/relay/` between the runner's check and
  git's write.
