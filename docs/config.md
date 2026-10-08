# relay settings

This page describes where relay keeps its own files and the settings file `config.toml`: what
each setting means, how relay checks the file, and the messages it prints when something is
wrong. The code is in `src/core/paths.ts`, `src/core/relay-home.ts` and `src/core/config/`.
`docs/config.example.toml` is a complete example that the tests load.

## The relay folder

relay keeps its files in one folder, the relay folder. It is `~/.relay` unless the environment
variable `RELAY_HOME` names another folder. An empty `RELAY_HOME` counts as unset.

- `RELAY_HOME` must be an absolute path or start with `~/`. Any other value stops relay with
  exit code 78: `relay: RELAY_HOME must be an absolute path, not "relay-home".`
- `RELAY_HOME` cannot be your home folder itself (`~`, `~/` or the same path written out), because
  relay changes the mode of its folder and keeps private files there:
  `relay: RELAY_HOME cannot be your home folder itself ("~"). Use a folder of its own, such as ~/.relay.`
- relay finds the home folder through the `HOME` variable. It asks the operating system only when
  `HOME` is unset, empty or not an absolute path.
- When a command runs, relay creates the relay folder with mode 0700 if it is missing. Help,
  `--version` and a wrong command line never create it.
- An existing relay folder must be a folder that you own, that you can read, write and open, and
  that neither your group nor other users can write. When the path is a symbolic link, you must
  also own the link. Otherwise relay stops with exit code 78 before it reads or writes anything in
  it, for example: `relay: other users can change /Users/josue/.relay. Run "chmod 700 /Users/josue/.relay" and try again.`
  A folder that belongs to another user gives `relay: <folder> belongs to another user. relay only
  uses a folder you own.` A folder you cannot fully use, for example one with mode 0600, gives
  `relay: you cannot read, write and open <folder>. Run "chmod 700 <folder>" and try again.` A path
  that is not a folder gives `relay: <folder> is not a folder.`

In this version the folder holds `config.toml`, your settings, `logs/`, relay's log files (see
`docs/cli.md`), `profiles/` (the default profile folder of each account) and `accounts/` (relay's
records about each account; see `docs/accounts.md`). Later changes add `jobs/`, `locks/`, `tmp/`, `spool/`, `run/`,
`projects.list` and `relay.db`, and describe them in their own documents.

The settings live in your relay folder and never inside a project, so a repository cannot add
itself to an allow list.

## How relay reads the settings

```mermaid
flowchart TD
  start["a command runs (not help, --version or a usage error)"] --> home["resolveRelayHome:<br/>RELAY_HOME, or HOME/.relay"]
  home -->|"relative path"| e78["message on standard error, exit 78<br/>(relay hook: nothing, exit 0)"]
  home --> folder["ensureRelayHome:<br/>create with mode 0700 if missing"]
  folder -->|"not a folder, another owner,<br/>others can write, or you cannot open it"| e78
  folder --> exists{"config.toml exists?"}
  exists -->|"no"| empty["empty settings;<br/>no file is created"]
  exists -->|"yes"| file["readPrivateFile: open once, following links;<br/>a regular file you own,<br/>not writable by others, at most 1 MB"]
  file -->|"fails"| e78
  file --> parse["parseToml (TOML 1.1)"]
  parse -->|"syntax error"| e78
  parse --> validate["validateConfig:<br/>known keys, accounts, paths,<br/>allow lists, no credentials"]
  validate -->|"problems"| report["every problem at once, exit 78"]
  validate --> level["resolveLogLevel:<br/>--log-level, RELAY_LOG_LEVEL,<br/>log.level, info"]
  empty --> level
  level -->|"RELAY_LOG_LEVEL not a level"| e78
  level --> handler["the command's handler"]
```

The diagram shows the checks relay makes, in order, before a command does its work. relay first
works out the relay folder and makes sure it is private. A missing `config.toml` is not an error;
relay continues with no accounts, no projects and default values, and does not create the file.
An existing file is opened once, and must pass the file checks on that opened file before relay
reads a single byte of it. relay then
parses it and checks every setting, and reports all problems together so that you can fix them in
one pass. Every failure on the way ends with exit code 78. `relay hook` is the exception: agents
call it, so it prints nothing and exits with code 0.

## The settings file

`config.toml` is a TOML 1.1 file. relay accepts only the settings on this page. A misspelt key is
a problem, not something relay quietly skips, because a typo in an allow list would otherwise go
unnoticed.

```toml
version = 1

[defaults]
account = "claude:personal"

[log]
level = "info"

[accounts."claude:personal"]
profile_dir = "~/.claude"
kind = "personal"

[[projects]]
path = "~/projects/relay"
allow = ["claude:personal"]
```

`docs/config.example.toml` has a longer example with comments.

### Top level

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `version` | integer | `1` | The version of the file format. It must be `1`. A larger number means the file was written for a newer relay. The TOML parser reads `1.0` as `1`, so `version = 1.0` is also accepted. |
| `defaults` | table | empty | Default choices, below. |
| `log` | table | empty | Log settings, below. |
| `checkpoint` | table | empty | Checkpoint settings, below. |
| `accounts` | table of tables | no accounts | Your accounts, below. |
| `projects` | list of `[[projects]]` tables | no projects | The accounts each project may use, below. |
| `t3` | table | default local address, no projects or instances | The T3 Code connection and account mappings, below. |
| `limits` | table of account and window tables | default rules | The usage thresholds and actions for each account, below. |

### `[defaults]`

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `account` | account name | none | The account `relay run` uses when you do not name one. It must be one of your accounts. Example: `account = "claude:personal"`. |

### `[log]`

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `level` | `"debug"`, `"info"`, `"warn"` or `"error"` | `"info"` | How much relay writes to its log files. |

The log level comes from the `--log-level` option first, then the `RELAY_LOG_LEVEL` environment
variable, then `log.level`, then `info`. A `RELAY_LOG_LEVEL` that is not one of the four levels
stops relay with exit code 78, also when `--log-level` is given:
`relay: RELAY_LOG_LEVEL must be debug, info, warn or error, not "loud".`

### `[checkpoint]`

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `max_file_size_mb` | whole number from 1 to 1024 | `20` | A file larger than this many megabytes is left out of a checkpoint and listed in its output instead. `docs/checkpoints.md` explains what happens to such a file. |

### `[accounts."<provider>:<name>"]`

An account is a provider and a name you choose, written `provider:name`, for example
`claude:personal` or `codex:work`. The provider is `claude` or `codex`. The name uses lowercase
letters, digits and `-`, starts with a letter or digit, and has at most 32 characters. Each
account is a place where relay can run an agent, and has its own profile folder, where the
provider's own program keeps its sign-in.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `profile_dir` | path | `<relay folder>/profiles/<provider>-<name>` | The account's profile folder. Example: `profile_dir = "~/.codex"`. Two accounts cannot share a folder. |
| `credential_env` | list of variable names | `[]` | The names of credential variables this account may receive from your shell, for example `["ANTHROPIC_API_KEY"]`. Names use capital letters, digits and `_`. A Claude Code account may name only `ANTHROPIC_` variables and `CLAUDE_CODE_OAUTH_TOKEN`, and a Codex account only `OPENAI_` and `CODEX_` variables (not `CODEX_HOME`, `CODEX_THREAD_ID` or the `CODEX_SANDBOX` ones), so one provider's key never reaches another provider. relay removes every other credential variable when it starts an agent. |
| `kind` | `"personal"` or `"work"` | none | Whether this is a personal or a work account. |

An account with no settings, `[accounts."claude:personal"]` alone, is valid.

`relay account add` appends an account's table to this file and `relay account remove` removes it,
keeping every other line and comment as it was (`docs/accounts.md`). They are the only commands
that write `config.toml`, through `src/core/config/edit.ts`, and they never write a credential.

### `[[projects]]`

Each `[[projects]]` table lists the accounts allowed to work on one project. Handing work to an
account sends the project's code to that account's company, so relay only uses the accounts
listed here.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `path` | path | required | The project folder. Two entries cannot name the same folder. |
| `allow` | list of account names | required | The accounts this project may use, each once. Each must be one of your accounts. `allow = []` allows none. |

### `[t3]`

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | `"http://127.0.0.1:3773/mcp"` | The T3 Code MCP address. Its host must be `127.0.0.1` or `localhost`, its scheme must be `http`, and its path must be `/mcp`. |
| `projects` | list of paths | `[]` | The project folders whose T3 threads relay may manage. Two entries cannot name the same folder. |
| `instances` | table of tables | no instances | The T3 provider instances mapped to your accounts, below. |

The defaults also apply when `[t3]` is absent. The T3 token is never stored in this file.
relay keeps the token T3 issues to it only in the operating system's credential store.

### `[t3.instances.<id>]`

Each table maps a T3 provider instance ID to a relay account. IDs use letters, digits, `_` and
`-`, start with a letter or digit, and have at most 64 characters. Two instances cannot name
the same account. The account's profile folder must be the one T3 uses for that provider.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `account` | account name | required | The relay account this T3 instance uses. It must be one of your accounts. |
| `model` | non-empty string | none | The model ID relay uses when switching to this instance. When absent, relay uses the first model T3 lists for it. |

### `[limits."<provider>:<name>".<window>]`

The account must be defined under `accounts`. The window is `five_hour` for the 5-hour limit
or `seven_day` for the weekly limit. relay resolves both windows for each account named by a T3
instance or a limits table, including a window whose table is absent.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `threshold` | whole number from 1 to 100 | `100` for `five_hour`; `90` for `seven_day` | The percentage of usage at which the rule is crossed. |
| `action` | `"wait"`, `"switch"` or `"notify"` | `"wait"` for `five_hour`; `"switch"` for `seven_day` with `switch_to`, otherwise `"notify"` | `wait` lets the limit reset. `switch` moves work to the target account. `notify` tells you without moving work. |
| `switch_to` | account name | none | The account to switch to. It must be defined, use another provider, and be mapped to a T3 instance. It is required when `action` is `"switch"`. |

Explicit settings replace these defaults. With `wait` or `notify`, `switch_to` is ignored and
the rule description says `(switch_to is ignored)`. The target still has to pass the account,
provider and T3 mapping checks. relay refuses automatic switches between two Claude accounts
or between two Codex accounts, following each provider's terms.

### `[handoff]`

These settings control `relay switch`, the handoff to another agent or account. `docs/handoff.md`
describes the handoff step by step.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `ask_for_summary` | `true` or `false` | `true` | Whether relay asks the outgoing agent to write handoff notes. With `false`, relay always builds the notes itself from the event log and the repository. Asking costs a little usage on the outgoing account. |
| `summary_timeout_seconds` | whole number from 10 to 900 | `120` | How long relay waits for the outgoing agent's notes before it stops that agent and builds the notes itself. |
| `stop_timeout_seconds` | whole number from 5 to 300 | `30` | How long relay waits for the outgoing agent to stop before it kills it. |
| `check_timeout_seconds` | whole number from 10 to 7200 | `600` | How long each of the job's checks may run before relay stops it. |
| `start_check_seconds` | whole number from 1 to 60 | `5` | How long the next agent must keep running before relay counts its start as successful. |

The defaults also apply when `[handoff]` is absent.

### Paths

`profile_dir`, a project's `path` and each `t3.projects` entry accept an absolute path, `~`, or
a path starting with `~/`.
relay replaces `~` with your home folder, removes a trailing `/`, and resolves `.` and `..`, so
`"~/.codex/"` becomes `/Users/josue/.codex`. relay does not check that the folder exists; the
command that uses it does.

## Credentials are refused

`config.toml` must not hold passwords, tokens, API keys or cookies. The token T3 issues to relay
is kept only in the operating system's credential store.
You sign in to each account with the provider's own login command, and the provider keeps the
sign-in in the account's profile folder. An account can only name the credential variables it may
receive, with `credential_env`; the values stay in your shell.

A key whose name contains `token`, `apikey`, `api_key`, `password`, `secret`, `cookie` or
`credential` (in any letter case, in any table) is refused with this problem:

```
accounts."claude:personal".api_key: relay never stores credentials. Remove this key and sign in with the provider's own login command.
```

relay never prints the value of such a key, and never writes it to a log. More generally, a
problem names the key and not its value. The one exception is an account reference, which relay
repeats only when it has the `provider:name` form.

## The file itself

relay opens `config.toml` once, following a symbolic link (so a link to a file in a dotfiles folder
works), and reads it only when the opened file passes these checks. Because the checks and the
read use the same opened file, the file cannot be swapped between them.

- It is a regular file, not a folder, a named pipe or a device: `relay: <file> is not a regular file.`
- You own it. Otherwise: `relay: <file> belongs to another user. relay only uses a file you own.`
- Neither your group nor other users can write it. Otherwise:
  `relay: other users can change <file>. Run "chmod 600 <file>" and try again.`
- It is at most 1 MB. Otherwise: `relay: <file> is larger than 1 MB, the most relay reads.`

A file that is not valid TOML gives `relay: cannot read <file>: <message from the TOML parser>`.
The parser repeats part of the file in some messages, and that part could be a credential. relay
replaces every quoted piece longer than three characters with `"..."`, so `api_key = sk-ant-...`
without quotes gives `Strings must be quoted: "..."`. Short pieces such as `'='` stay, so the
message still says what is wrong.

When the system refuses to open or read a path, relay says why in plain words instead of
repeating the system's message, for example
`relay: cannot use /Users/josue/.relay/config.toml: you do not have permission.` The reasons are
`it, or the file it links to, does not exist`, `you do not have permission`,
`part of the path is not a folder`, `it leads through too many symbolic links`, and
`the system reported <code>` for any other error code. A symbolic link named `config.toml` that
leads nowhere is such an error, not a missing file.

relay changes `config.toml` only to add or remove accounts (and, in a later version, allow-list
entries), through one module, `src/core/config/edit.ts`, and never writes a credential to it. It
keeps every other byte, checks the result like any loaded file, and writes it to a temporary file
with mode 0600 that it renames over the old one, so a failed change leaves the file as it was. It
holds the lock `locks/config.lock` while it reads, changes and writes the file, so two relay
commands never change it at once, and it refuses to change a `config.toml` that is a symbolic
link, because the rename would replace the link. `docs/accounts.md`, "How relay changes
config.toml", shows the steps.

## Problem messages

When the file has problems, relay lists all of them, in the order of the keys in the file, and
exits with code 78. (One exception comes from the TOML parser relay uses: keys that look like
whole numbers, such as `"1"`, are listed before the other keys of their table.)
Switch-target checks run after the whole file is read, in rule order, so a target can be
mapped to T3 later in the file.

```
relay: /Users/josue/.relay/config.toml has 2 problems:
  colour: unknown setting.
  log.level: must be debug, info, warn or error.
The settings are described in docs/config.md.
```

A key that contains characters other than letters, digits, `_` and `-` is shown in quotes, as in
`accounts."claude:personal"`. Control characters and other characters that do not print are
written as `\u` escapes in every key, value and path relay repeats, so the file cannot change
what your terminal shows. `[[projects]]` entries are counted from 1, as in `projects[1].path`.

| Problem | Message |
|---|---|
| A key relay does not know | `unknown setting.` |
| A key named like a credential | `relay never stores credentials. Remove this key and sign in with the provider's own login command.` |
| `version` is larger than 1 | `this file is for a newer relay (version 2). Update relay.` |
| `version` is anything else | `must be 1.` |
| An account name not in `provider:name` form | `account names look like provider:name in lowercase, for example "claude:personal".` |
| An account for another provider | `relay does not support "cursor" yet. Supported providers: claude, codex.` |
| A path that is relative | `must be an absolute path or start with ~/.` |
| Two accounts with one profile folder | `the same folder as accounts."claude:personal". Each account needs its own profile folder.` |
| An account name that is not defined | `"codex:work" is not one of your accounts.` |
| A name listed twice in `allow` | `"codex:personal" is listed twice.` |
| Two projects with one path | `the same path as projects[1].` |
| A required setting is missing | `is required.` |
| `checkpoint.max_file_size_mb` is not a whole number from 1 to 1024 | `must be a whole number from 1 to 1024.` |
| `t3.url` does not parse, uses another scheme or has another path | `must look like http://127.0.0.1:3773/mcp.` |
| `t3.url` names another host | `relay only connects to T3 Code on this computer (127.0.0.1 or localhost).` |
| `t3.projects` is not a list | `must be a list of folders.` |
| Two T3 projects with one path | `the same path as t3.projects[1].` |
| A T3 instance ID has the wrong form | `T3 provider instance IDs use letters, digits, "_" and "-".` |
| Two T3 instances with one account | `the same account as t3.instances.claude.` |
| A limit window is unknown | `unknown window. Use five_hour or seven_day.` |
| A threshold is not a whole number from 1 to 100 | `must be a whole number from 1 to 100.` |
| A `[handoff]` time is outside its range | `must be a whole number from 10 to 900.` (with the range of that setting) |
| A limit action is unknown | `must be "wait", "switch" or "notify".` |
| `action = "switch"` has no `switch_to` | `is required when action is "switch".` |
| A switch target uses the same Claude provider | `relay does not move work between two Claude accounts on its own. Anthropic's terms say plan limits assume ordinary, individual use.` |
| A switch target uses the same Codex provider | `relay does not move work between two Codex accounts on its own. OpenAI's terms forbid getting around rate limits.` |
| A switch target has no T3 mapping | `T3 Code has no provider mapped to codex:personal. Run relay t3 connect to map it.` |
| A wrong type | `must be a string.`, `must be a table.`, `must be a list of [[projects]] tables.`, `must be a list of account names.`, `must be a list of variable names in capitals, for example "ANTHROPIC_API_KEY".`, `must be "personal" or "work".`, `must be debug, info, warn or error.` |

## Adding a setting

A change that adds a setting updates, in the same pull request, `src/core/config/validate.ts`,
`src/core/config/types.ts`, this page and `docs/config.example.toml`.
