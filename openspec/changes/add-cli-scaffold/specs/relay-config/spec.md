# Spec Delta

## Purpose

Defines where relay keeps its own files (the relay folder, `RELAY_HOME`) and how it reads and checks the person's settings in `config.toml`: accounts, the providers each project may use, and defaults.

## ADDED Requirements

### Requirement: Relay folder location
relay SHALL use the folder named by the `RELAY_HOME` environment variable when it is set and not empty, and `$HOME/.relay` otherwise. The home folder SHALL come from `HOME` when it is an absolute path, and from the operating system otherwise. A leading `~/` in `RELAY_HOME` SHALL be expanded to the home folder. Any other relative path, and any value that resolves to the home folder itself, SHALL be a settings error with exit code 78.

#### Scenario: Default folder
- **WHEN** `RELAY_HOME` is not set and `HOME` is `/Users/josue`
- **THEN** relay uses `/Users/josue/.relay`

#### Scenario: Override
- **WHEN** `RELAY_HOME` is `/tmp/relay-test-1`
- **THEN** relay reads `/tmp/relay-test-1/config.toml` and writes logs under `/tmp/relay-test-1/logs`

#### Scenario: Relative path
- **WHEN** `RELAY_HOME` is `relay-home`
- **THEN** standard error shows `relay: RELAY_HOME must be an absolute path, not "relay-home".` and relay exits with code 78

#### Scenario: Home folder itself
- **WHEN** `RELAY_HOME` is `~/`
- **THEN** standard error shows `relay: RELAY_HOME cannot be your home folder itself ("~/"). Use a folder of its own, such as ~/.relay.` and relay exits with code 78

### Requirement: Relay folder safety
When a command other than help or version runs, relay SHALL create the relay folder with mode 0700 if it does not exist. If it exists, it SHALL be a folder owned by the current user that the owner can read, write and open, and that neither the group nor others can write. A symbolic link at its path SHALL also be owned by the current user. Otherwise relay SHALL stop with exit code 78 before reading or writing anything in it. A failing file-system call SHALL be reported as `relay: cannot use <path>: <reason>.`, where the reason is a plain sentence and not the system's own message.

#### Scenario: First run
- **WHEN** the relay folder does not exist and the person runs `relay status`
- **THEN** the folder exists afterwards with mode 0700

#### Scenario: Folder others can change
- **WHEN** the relay folder has mode 0777
- **THEN** standard error shows `relay: other users can change <folder>. Run "chmod 700 <folder>" and try again.` and relay exits with code 78

#### Scenario: Folder owned by someone else
- **WHEN** the relay folder belongs to another user
- **THEN** standard error shows `relay: <folder> belongs to another user. relay only uses a folder you own.` and relay exits with code 78

#### Scenario: Folder the owner cannot open
- **WHEN** the relay folder has mode 0600
- **THEN** standard error shows `relay: you cannot read, write and open <folder>. Run "chmod 700 <folder>" and try again.` and relay exits with code 78

### Requirement: Settings file is optional
The settings file SHALL be `config.toml` in the relay folder. A missing file SHALL mean no accounts, no projects and default values, and SHALL NOT be an error. Reading the settings SHALL NOT create or change `config.toml`. relay MAY write `config.toml` only to add or remove its own settings (accounts and project allow lists, through the writer of later changes), and SHALL never write a provider credential to it.

#### Scenario: No settings file
- **WHEN** `config.toml` does not exist and the person runs `relay status`
- **THEN** relay continues with empty settings and no `config.toml` is created

### Requirement: Settings file safety
An existing `config.toml`, after following symbolic links, SHALL be a regular file owned by the current user that neither the group nor others can write, and no larger than 1 MB. relay SHALL check and read the same opened file. Otherwise relay SHALL stop with exit code 78 without reading the content.

#### Scenario: File others can change
- **WHEN** `config.toml` has mode 0666
- **THEN** standard error shows `relay: other users can change <file>. Run "chmod 600 <file>" and try again.` and relay exits with code 78

#### Scenario: Named pipe
- **WHEN** `config.toml` is a named pipe
- **THEN** standard error shows `relay: <file> is not a regular file.` at once and relay exits with code 78

#### Scenario: File too large
- **WHEN** `config.toml` is larger than 1 MB
- **THEN** standard error shows `relay: <file> is larger than 1 MB, the most relay reads.` and relay exits with code 78

#### Scenario: Symbolic link from a dotfiles folder
- **WHEN** `config.toml` is a symbolic link to a file the person owns with mode 0644
- **THEN** relay reads the file it points to

### Requirement: TOML syntax errors
A `config.toml` that is not valid TOML 1.1 SHALL stop relay with exit code 78 and the message `relay: cannot read <file>: <parser message>`. In the parser message, every quoted piece longer than three characters SHALL be replaced by `"..."`, because the parser may repeat text from the file there.

#### Scenario: Invalid TOML
- **WHEN** `config.toml` contains `version = = 1`
- **THEN** standard error starts with `relay: cannot read ` followed by the file path, and relay exits with code 78

#### Scenario: Unquoted credential
- **WHEN** `config.toml` contains `api_key = sk-ant-test-123` without quotes
- **THEN** standard error shows `relay: cannot read <file>: TOML Parse error: Strings must be quoted: "..."` and does not contain `sk-ant-test-123`

### Requirement: Known settings only
The top level of `config.toml` SHALL accept only `version`, `defaults`, `log`, `accounts` and `projects`, and each table SHALL accept only its documented keys. `version` SHALL be optional and, when present, SHALL be the integer 1. Any other key SHALL be a problem named by its full path, without showing its value.

#### Scenario: Typo in a key
- **WHEN** an account sets `profil_dir = "~/x"`
- **THEN** the problem list contains `accounts."claude:personal".profil_dir: unknown setting.`
- **AND** the text `~/x` does not appear in the output

#### Scenario: Newer file
- **WHEN** `config.toml` sets `version = 2`
- **THEN** the problem list contains `version: this file is for a newer relay (version 2). Update relay.`

### Requirement: Accounts
Each table under `accounts` SHALL be named `<provider>:<name>`, where provider is `claude` or `codex` and name matches `^[a-z0-9][a-z0-9-]{0,31}$`. An account MAY set `profile_dir` (a path), `credential_env` (a list of environment variable names matching `^[A-Z_][A-Z0-9_]*$`) and `kind` (`"personal"` or `"work"`). Without `profile_dir`, the profile folder SHALL be `<relay folder>/profiles/<provider>-<name>`.

#### Scenario: Minimal account
- **WHEN** `config.toml` contains only `[accounts."claude:personal"]`
- **THEN** relay knows the account `claude:personal` with provider `claude`, name `personal`, profile folder `<relay folder>/profiles/claude-personal`, no credential variables and no kind

#### Scenario: Badly formed name
- **WHEN** `config.toml` contains `[accounts."Claude:Personal"]`
- **THEN** the problem list contains `accounts."Claude:Personal": account names look like provider:name in lowercase, for example "claude:personal".`

#### Scenario: Provider not supported yet
- **WHEN** `config.toml` contains `[accounts."cursor:work"]`
- **THEN** the problem list contains `accounts."cursor:work": relay does not support "cursor" yet. Supported providers: claude, codex.`

### Requirement: Paths in settings
Path settings (`profile_dir` and a project's `path`) SHALL accept an absolute path, `~` or a path starting with `~/`. relay SHALL expand `~`, remove a trailing slash and resolve `.` and `..`. Any other form SHALL be a problem. relay SHALL NOT check that the path exists.

#### Scenario: Home-relative path
- **WHEN** `HOME` is `/Users/josue` and an account sets `profile_dir = "~/.codex/"`
- **THEN** the account's profile folder is `/Users/josue/.codex`

#### Scenario: Relative path
- **WHEN** an account sets `profile_dir = "profiles/claude"`
- **THEN** the problem list contains `accounts."claude:personal".profile_dir: must be an absolute path or start with ~/.`

### Requirement: One profile folder per account
No two accounts SHALL resolve to the same profile folder, so that each account keeps its own sign-in.

#### Scenario: Shared folder
- **WHEN** `claude:personal` and `claude:work` both set `profile_dir = "~/.claude"`
- **THEN** the problem list contains `accounts."claude:work".profile_dir: the same folder as accounts."claude:personal". Each account needs its own profile folder.`

### Requirement: Credentials are refused
An unknown key whose name contains `token`, `apikey`, `api_key`, `password`, `secret`, `cookie` or `credential`, in any table, SHALL be reported as a problem that says relay never stores credentials. The value SHALL never appear in any output or log.

#### Scenario: API key in settings
- **WHEN** an account sets `api_key = "sk-ant-test-123"`
- **THEN** the problem list contains `accounts."claude:personal".api_key: relay never stores credentials. Remove this key and sign in with the provider's own login command.`
- **AND** `sk-ant-test-123` appears neither on standard error nor in any file under `logs/`

### Requirement: Project allow lists
Each `[[projects]]` entry SHALL have `path` (a path) and `allow` (a list of account names). Every name in `allow` SHALL be an account defined under `accounts` and SHALL appear once. Two entries SHALL NOT resolve to the same path. Entries are counted from 1 in messages.

#### Scenario: Unknown account in an allow list
- **WHEN** the first `[[projects]]` entry has `allow = ["codex:work"]` and no account `codex:work` exists
- **THEN** the problem list contains `projects[1].allow: "codex:work" is not one of your accounts.`

#### Scenario: Missing path
- **WHEN** a `[[projects]]` entry has no `path`
- **THEN** the problem list contains `projects[1].path: is required.`

#### Scenario: Empty allow list
- **WHEN** a project has `allow = []`
- **THEN** the settings load and that project allows no account

### Requirement: Defaults and log level
`defaults.account`, when set, SHALL name an account defined under `accounts`. `log.level`, when set, SHALL be `debug`, `info`, `warn` or `error`. The log level SHALL come from `--log-level` first, then the `RELAY_LOG_LEVEL` environment variable, then `log.level`, then `info`. An invalid `RELAY_LOG_LEVEL` SHALL be a settings error with exit code 78, also when `--log-level` is given.

#### Scenario: Default account not defined
- **WHEN** `defaults.account = "claude:personal"` and that account is not defined
- **THEN** the problem list contains `defaults.account: "claude:personal" is not one of your accounts.`

#### Scenario: Flag beats settings
- **WHEN** `log.level = "warn"` and the person runs `relay status --log-level debug`
- **THEN** relay logs at level `debug`

### Requirement: Problem report
When the settings have problems, relay SHALL report all of them at once on standard error under the line `relay: <file> has <n> problems:` (`has 1 problem:` when there is one), one problem per line indented by two spaces, in the order the keys appear in the file, followed by `The settings are described in docs/config.md.`, and SHALL exit with code 78.

#### Scenario: Two problems
- **WHEN** `config.toml` has an unknown top-level key `colour` and `log.level = "loud"`
- **THEN** standard error shows `relay: <file> has 2 problems:`, then `  colour: unknown setting.`, then `  log.level: must be debug, info, warn or error.`
- **AND** relay exits with code 78
