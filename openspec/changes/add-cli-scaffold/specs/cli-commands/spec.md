# Spec Delta

## Purpose

Defines the `relay` command line: which commands exist, how arguments are checked, what help and version print, where output goes, and which exit code each outcome returns. Later changes give the commands their real behaviour.

## ADDED Requirements

### Requirement: Command set
The `relay` program SHALL recognize exactly these commands as its first argument: `init`, `run`, `checkpoint`, `checkpoints`, `rollback`, `accept-git-changes`, `switch`, `status`, `account`, `providers`, `policy`, `hooks`, `hook`, `statusline`, `daemon`, `doctor` and `help`. Any other first argument that does not start with `-` SHALL be a usage error.

#### Scenario: Known command
- **WHEN** the person runs `relay status`
- **THEN** relay handles it as the `status` command

#### Scenario: Unknown command
- **WHEN** the person runs `relay sw1tch codex:personal`
- **THEN** standard error shows `relay: "sw1tch" is not a relay command.` and `Run "relay --help" to see the commands.`
- **AND** relay exits with code 2

### Requirement: Top-level help
`relay`, `relay --help`, `relay -h` and `relay help` SHALL print the top-level help to standard output and exit with code 0. The help SHALL list the sixteen commands with a one-line summary each, the options `-h, --help`, `--version` and `--log-level <level>`, and the location of the settings file.

#### Scenario: No arguments
- **WHEN** the person runs `relay` with no arguments
- **THEN** standard output starts with `relay keeps your coding work moving between agents and accounts.`
- **AND** it contains the line `  switch              Hand the job to another agent or account`
- **AND** relay exits with code 0

#### Scenario: Help as a command
- **WHEN** the person runs `relay help`
- **THEN** the output is identical to the output of `relay --help`

### Requirement: Command help
`relay <command> --help`, `relay <command> -h` and `relay help <command>` SHALL print that command's help to standard output and exit with code 0, even when other arguments are wrong. Command help SHALL show the usage line, the summary, any details, examples, the options, and, while the command is not built, the line `Not built yet. This version only reads your settings.`

#### Scenario: Help for switch
- **WHEN** the person runs `relay switch --help`
- **THEN** standard output contains `  relay switch <provider[:account]>` and `  relay switch codex:personal`
- **AND** relay exits with code 0

#### Scenario: Help wins over a bad option
- **WHEN** the person runs `relay checkpoint --fast --help`
- **THEN** relay prints the help for `checkpoint` and exits with code 0

#### Scenario: Help for an unknown command
- **WHEN** the person runs `relay help nope`
- **THEN** standard error shows `relay: "nope" is not a relay command.` and relay exits with code 2

### Requirement: Version
`relay --version` SHALL print `relay <version>` to standard output, where `<version>` is the `version` field of `package.json` at build time, and exit with code 0.

#### Scenario: Version output
- **WHEN** the person runs `relay --version` on a build of version 0.1.0
- **THEN** standard output is exactly `relay 0.1.0` followed by a newline
- **AND** relay exits with code 0

### Requirement: Option checking
Options SHALL come after the command name. Each command SHALL accept `-h`, `--help`, `--log-level <level>` and only its own declared options. An unknown option, an option without its value, or a `--log-level` value other than `debug`, `info`, `warn` or `error` SHALL be a usage error with exit code 2.

#### Scenario: Unknown option
- **WHEN** the person runs `relay switch codex:personal --fast`
- **THEN** standard error shows `relay: unknown option "--fast" for switch.` and `Run "relay switch --help" to see its options.`
- **AND** relay exits with code 2

#### Scenario: Missing option value
- **WHEN** the person runs `relay checkpoint --message`
- **THEN** standard error shows `relay: option "--message" needs a value.` and relay exits with code 2

#### Scenario: Bad log level
- **WHEN** the person runs `relay status --log-level loud`
- **THEN** standard error shows `relay: --log-level must be debug, info, warn or error, not "loud".` and relay exits with code 2

#### Scenario: Option before the command
- **WHEN** the person runs `relay --log-level debug status`
- **THEN** standard error shows `relay: unknown option "--log-level".` and `Run "relay --help" to see the commands.`
- **AND** relay exits with code 2

### Requirement: Argument count checking
Each command SHALL declare how many arguments it takes: `init`, `checkpoint`, `checkpoints`, `accept-git-changes`, `status`, `providers` and `doctor` none; `run` and `rollback` zero or one; `switch`, `statusline` and `daemon` exactly one; `policy`, `hooks` and `hook` exactly two; `account` one to three. Too few or too many arguments SHALL be a usage error with exit code 2.

#### Scenario: Missing argument
- **WHEN** the person runs `relay switch`
- **THEN** standard error shows `relay: switch needs <provider[:account]>.` and `Run "relay switch --help" for an example.`
- **AND** relay exits with code 2

#### Scenario: Three arguments for account
- **WHEN** the person runs `relay account add codex work`
- **THEN** relay accepts the argument count and goes on to load the settings

#### Scenario: Too many arguments
- **WHEN** the person runs `relay status extra`
- **THEN** standard error shows `relay: too many arguments for status: "extra".` and relay exits with code 2

### Requirement: Commands that are not built yet
When a command other than `hook` is run with valid arguments, relay SHALL load the settings first. If they load, relay SHALL print `relay: <command> is not built yet. This version only reads your settings and shows help.` to standard error and exit with code 69. If they do not load, the settings error and exit code 78 SHALL win.

#### Scenario: Valid settings
- **WHEN** the person runs `relay switch codex:personal` with valid settings
- **THEN** standard error shows `relay: switch is not built yet. This version only reads your settings and shows help.`
- **AND** standard output is empty
- **AND** relay exits with code 69

#### Scenario: Broken settings
- **WHEN** the person runs `relay status` and `config.toml` is not valid TOML
- **THEN** relay prints the settings error and exits with code 78

### Requirement: The hook command is silent
`relay hook` without `--help` SHALL write nothing to standard output or standard error and SHALL exit with code 0 in every case, including usage errors and settings errors, except when it is stopped by a signal (130 for SIGINT, 143 for SIGTERM). When standard input is not a terminal, it SHALL read standard input to the end and discard it without parsing or logging it. It SHALL record what happened in `RELAY_HOME/logs/hook.log` when that folder can be used.

#### Scenario: Called by an agent
- **WHEN** Claude Code runs `relay hook claude Stop` with a JSON document on standard input
- **THEN** relay prints nothing and exits with code 0
- **AND** `logs/hook.log` gains one line with `"msg":"hook ignored: not built yet"`

#### Scenario: Wrong arguments from a hook
- **WHEN** an agent runs `relay hook claude`
- **THEN** relay prints nothing and exits with code 0

### Requirement: Help, version and usage errors touch nothing
Printing help or the version, and rejecting a command line for any command other than `relay hook`, SHALL NOT read the settings, create `RELAY_HOME`, or write any file.

#### Scenario: Help with no relay folder
- **WHEN** `RELAY_HOME` points to a folder that does not exist and the person runs `relay --help`
- **THEN** the folder still does not exist afterwards

#### Scenario: Help with broken settings
- **WHEN** `config.toml` is not valid TOML and the person runs `relay run --help`
- **THEN** relay prints the help for `run` and exits with code 0

### Requirement: Output streams
Results and help SHALL go to standard output. Errors and the "not built yet" message SHALL go to standard error, and every line relay writes there SHALL start with `relay: ` except the hint lines that start with `Run "relay`. relay SHALL NOT print color codes in this version.

#### Scenario: Error stream only
- **WHEN** a command fails with a usage error
- **THEN** standard output is empty and the message is on standard error

### Requirement: Exit codes
relay SHALL exit with 0 on success, 1 when a command ran and failed, 2 for a usage error, 69 when the command is not available in this version, 70 for an unexpected internal error, 78 for a settings error, 130 when interrupted by SIGINT and 143 when stopped by SIGTERM. Codes 3 to 63 SHALL be reserved for later changes, which add them to the same table without reusing a number another change has taken (3 to 8, 10, 20 to 25 and 31 to 33 are taken by the later first-version changes).

#### Scenario: Unexpected error
- **WHEN** a bug inside relay throws an error that no command handles
- **THEN** standard error shows `relay: unexpected error: <message>` and `Details are in <path of cli.log>.`
- **AND** the log has a line at level `error` with the error name and the stack frames, without the message
- **AND** relay exits with code 70

#### Scenario: Interrupted
- **WHEN** the person presses Control-C while a relay command runs
- **THEN** relay exits with code 130
