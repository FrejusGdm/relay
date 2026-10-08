# Spec Delta

## Purpose

Hooks are commands that Claude Code and Codex run themselves when a session starts, a turn stops or a limit is hit, including in sessions relay did not start. This capability installs relay's hooks and optional status line into an account's profile with the person's consent, and records what they report.

## ADDED Requirements

### Requirement: Installing relay's hooks
`relay hooks install <account> [--status-line] [--yes]` SHALL add one command hook per event to the account's settings file: for Claude Code `<profile>/settings.json` with SessionStart, Stop, StopFailure, Notification, SessionEnd and PreCompact; for Codex `<profile>/hooks.json` with SessionStart, Stop, SessionEnd, Interrupt and PreCompact. Each command SHALL be `'<relay path>' hook <provider> <Event>` with the timeout of the requirement "Hook timeouts".

#### Scenario: Claude hooks
- **WHEN** the person runs `relay hooks install claude:work` and confirms
- **THEN** `~/.relay/profiles/claude-work/settings.json` has, under `hooks.StopFailure`, an entry `{"hooks":[{"type":"command","command":"'/usr/local/bin/relay' hook claude StopFailure","timeout":5}]}`, and likewise for the other five events

### Requirement: Hook timeouts
Each hook entry relay writes SHALL have a 5-second timeout, except Codex's `SessionEnd` and `Interrupt` entries, which SHALL have 3 seconds, the most Codex allows for those events.

#### Scenario: Codex SessionEnd
- **WHEN** relay installs its hooks for `codex:personal`
- **THEN** the `SessionEnd` and `Interrupt` entries have `"timeout":3` and the other entries have `"timeout":5`

### Requirement: Showing the change and asking first
Before writing, relay SHALL print the file path and each entry it will add, ask "Install these hooks? [y/N]" unless `--yes` is given, copy the original file to `accounts/<provider>-<name>/backups/<file>.<UTC time>` under `RELAY_HOME` with mode 0600, and write the new file through a temporary file and a rename that keeps the original file mode.

#### Scenario: Backup kept
- **WHEN** relay installs hooks into a `settings.json` that already existed
- **THEN** a backup with the original bytes exists under `~/.relay/accounts/claude-work/backups/`, and relay prints "Saved a copy of the old file in <backup path>."

### Requirement: Only relay's own entries are touched
Installing SHALL keep every hook, setting and key that is not relay's and SHALL NOT add an entry that already exists. relay's entries SHALL be recognised by a command that runs relay with the arguments `hook <provider> <Event>`. relay SHALL never change Codex's `notify` setting or `config.toml` in the profile.

#### Scenario: Person's own SessionStart hook
- **WHEN** `~/.codex/hooks.json` already has a SessionStart hook that runs another tool
- **THEN** after installation that hook is still the first SessionStart entry and relay's entry follows it

#### Scenario: Installing twice
- **WHEN** the person runs `relay hooks install claude:work --yes` twice
- **THEN** each event has exactly one relay entry and the second run prints "relay's hooks are already installed for claude:work."

### Requirement: Damaged settings files are not overwritten
When the settings file is not valid JSON, or its `hooks` value is not an object, relay SHALL change nothing and exit with code 1.

#### Scenario: Invalid JSON
- **WHEN** `settings.json` contains `{"hooks": ` and nothing more
- **THEN** relay prints "~/.relay/profiles/claude-work/settings.json is not valid JSON, so relay changed nothing. Fix the file, then try again." and exits with code 1

### Requirement: Default folders need an explicit command
`relay account add` SHALL offer to install hooks only for a profile folder relay created. For the provider's default folder, or any folder given with `--profile-dir`, hooks SHALL be installed only by `relay hooks install`.

#### Scenario: Existing ~/.claude
- **WHEN** the person adds `claude:personal --profile-dir ~/.claude`
- **THEN** relay does not offer hooks and prints "To let relay see sessions you start yourself, run relay hooks install claude:personal."

### Requirement: Removing relay's hooks
`relay hooks remove <account> [--yes]` SHALL remove only relay's entries, drop an event key or matcher group that becomes empty only if relay's entry was its last entry, restore the original status line if relay's wrapper was installed, and keep a backup as when installing.

#### Scenario: Clean removal
- **WHEN** relay's hooks are the only hooks in `settings.json` and the person removes them
- **THEN** `settings.json` no longer has a `hooks` key, and every other key is unchanged

### Requirement: Hook status
`relay hooks status <account>` SHALL report, for each of relay's events, whether its entry is present, and for Codex the `trustStatus` from the app server's `hooks/list`. It SHALL also report whether relay's status line is installed.

#### Scenario: Codex hooks waiting for trust
- **WHEN** relay's Codex entries are present and `hooks/list` reports them as `untrusted`
- **THEN** relay prints "Hooks: installed, waiting for you to trust them in Codex (/hooks)."

### Requirement: The Claude status-line wrapper
With `--status-line`, relay SHALL set the profile's `statusLine` to `{"type":"command","command":"'<relay path>' statusline claude"}`, saving any previous `statusLine` value in `accounts/<provider>-<name>/statusline-original.json` under `RELAY_HOME`. Without `--status-line`, relay SHALL NOT change `statusLine`.

#### Scenario: Person already has a status line
- **WHEN** `settings.json` has `"statusLine":{"type":"command","command":"~/bin/my-status"}` and the person installs with `--status-line`
- **THEN** the original value is saved, and relay prints "Your status line still shows; relay runs it after recording the usage numbers."

### Requirement: relay statusline claude
`relay statusline claude` SHALL read the status-line JSON from standard input, keep only `session_id` and the `rate_limits` windows' `used_percentage` and `resets_at`, record them for the account, then run the saved original command with the same input and pass its output and exit code through. It SHALL print nothing of its own and add no more than 50 ms before the original runs.

#### Scenario: No original status line
- **WHEN** no original status line was saved
- **THEN** the command records the reading, prints nothing, and exits with code 0

#### Scenario: Account found from the profile
- **WHEN** the status line runs in a session with `CLAUDE_CONFIG_DIR=~/.relay/profiles/claude-work` and no `RELAY_TARGET`
- **THEN** the reading is recorded for `claude:work`

### Requirement: relay hook records to the spool
In this version `relay hook <provider> <event>` SHALL follow the hook command contract of the `provider-hooks` capability (exit 0, no output, 500 ms limit) and append each event to `spool/hooks.jsonl` under `RELAY_HOME`, keeping only the fields named in the requirement "Spool line contents".

#### Scenario: Error details dropped
- **WHEN** a hook's input holds `error_details`
- **THEN** the spool line does not contain it

### Requirement: Spool line contents
Each spool line SHALL keep only the input fields `session_id`, `cwd`, `hook_event_name`, `error`, `notification_type`, `reason`, `source`, `model` and `turn_id`, and SHALL record `relay_job`, `relay_target` and `relay_worker` from `RELAY_JOB`, `RELAY_TARGET` and `RELAY_WORKER` (or null), and `profile`: the value of `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, or `default`.

#### Scenario: StopFailure recorded
- **WHEN** Claude Code runs `relay hook claude StopFailure` with `{"session_id":"7c1e…","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429 Too Many Requests","last_assistant_message":"…"}` and `RELAY_TARGET=claude:work`
- **THEN** `spool/hooks.jsonl` gains one line with `provider` `claude`, `event` `StopFailure`, `relay_target` `claude:work`, and fields `session_id` and `error`, and without `error_details` or `last_assistant_message`

#### Scenario: Session relay did not start
- **WHEN** the person starts `claude` themselves in the default profile and a turn stops
- **THEN** the spool line has `relay_job` and `relay_target` null and `profile` `default`, and relay attributes it to the account whose profile folder is `~/.claude`
