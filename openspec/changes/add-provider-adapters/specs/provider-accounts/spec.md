# Spec Delta

## Purpose

A person may hold several accounts of the same provider. This capability lets relay run each account in its own profile folder, signed in through the provider's own login, while relay itself never touches a credential and always starts an agent with the right account.

## ADDED Requirements

### Requirement: Adding an account
`relay account add <provider> <name> [--profile-dir <path>] [--api-key-env <VAR>]... [--kind personal|work] [--no-login] [--yes]` SHALL check the provider is installed, show the provider's policy and ask "Add <provider>:<name>? [y/N]", then create the profile folder, append the account to `config.toml`, and run the provider's login. It SHALL exit with code 0 when the account is added.

#### Scenario: New Claude account
- **WHEN** the person runs `relay account add claude work` and answers `y`
- **THEN** the folder `~/.relay/profiles/claude-work` exists with mode 0700, `config.toml` gains the table `[accounts."claude:work"]`, and `claude auth login` runs in the person's terminal with `CLAUDE_CONFIG_DIR` set to that folder

#### Scenario: Summary after adding
- **WHEN** the login finishes and `claude auth status --json` exits with code 0
- **THEN** relay prints "Added claude:work.", then "  Profile    ~/.relay/profiles/claude-work" and "  Signed in  yes (claude.ai)"

#### Scenario: Account added again under an old name
- **WHEN** `claude:work` was removed and the person adds `claude:work` again
- **THEN** relay writes a new `account.json` for it and deletes the old `availability.json`, so nothing recorded for the earlier account carries over

#### Scenario: The person says no
- **WHEN** the person answers anything other than `y` or `yes`
- **THEN** relay prints "Nothing changed." and exits with code 7, and no folder or setting is created

### Requirement: Adding refuses unsafe or invalid input
`relay account add` SHALL refuse, without changing anything, when the provider is not `claude` or `codex`, the name does not match `^[a-z0-9][a-z0-9-]{0,31}$`, the account already exists, another account uses the same profile folder, the provider program is missing, or no terminal is attached and `--yes` is absent.

#### Scenario: Account exists
- **WHEN** `claude:work` is already in `config.toml`
- **THEN** relay prints "claude:work already exists. See relay account list." and exits with code 2

#### Scenario: Provider not installed
- **WHEN** no `codex` program is found and the person runs `relay account add codex personal`
- **THEN** relay prints "Codex is not installed. Install it, then run relay account add again." and exits with code 20

#### Scenario: No terminal
- **WHEN** standard input is not a terminal and `--yes` is absent
- **THEN** relay prints "relay needs your answer. Run again in a terminal, or add --yes." and exits with code 7

### Requirement: Profile folders
A profile folder relay creates SHALL have mode 0700, inside a parent `profiles/` folder with mode 0700. relay SHALL refuse to use a profile folder that another user owns or that the group or others can write. relay SHALL NOT change the mode of a folder it did not create.

#### Scenario: Profile folder made writable by others
- **WHEN** `~/.relay/profiles/claude-work` has mode 0777 and the person runs `relay run claude:work`
- **THEN** relay prints "Other users can change ~/.relay/profiles/claude-work. Run chmod 700 on it, then try again." and exits with code 78

### Requirement: The provider's default folder
When an account's profile folder is the provider's default folder (`~/.claude` for Claude Code, `~/.codex` for Codex), relay SHALL start the provider without setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so the provider finds the login it already has.

#### Scenario: Existing Claude login
- **WHEN** the person runs `relay account add claude personal --profile-dir ~/.claude` and Claude Code is already signed in there
- **THEN** no login runs, relay prints "  Signed in  yes (claude.ai)", and a later worker on `claude:personal` starts with `CLAUDE_CONFIG_DIR` not set

### Requirement: Sign-in only through the provider's own login
relay SHALL sign in only by running `claude auth login` or `codex login` attached to the person's terminal with the account's environment, without capturing that terminal. It SHALL check the result with `claude auth status --json` or `codex login status` and keep only whether the account is signed in and the method reported, never an email, token or account ID.

#### Scenario: Login fails
- **WHEN** `codex login` exits with code 1
- **THEN** relay prints "Codex sign-in did not finish. The account is added; sign in later with relay account login codex:<name>." and exits with code 22

#### Scenario: Nothing personal is stored
- **WHEN** `claude auth status --json` prints JSON that includes an email address
- **THEN** that email address appears in no file under `RELAY_HOME`

### Requirement: Accounts that use an API key
With `--api-key-env <VAR>`, relay SHALL record only the variable's name in the account's `credential_env`, skip the login, and pass that variable from relay's own environment to this account's agents. relay SHALL never store, print or log the variable's value.

#### Scenario: Claude account on an API key
- **WHEN** the person runs `relay account add claude api --api-key-env ANTHROPIC_API_KEY --yes`
- **THEN** `config.toml` holds `credential_env = ["ANTHROPIC_API_KEY"]` for `claude:api`, and relay prints "claude:api uses the key in $ANTHROPIC_API_KEY. relay passes that variable to Claude Code and never stores its value."

### Requirement: Credential variables removed at launch
Every agent and provider command relay starts SHALL receive relay's environment minus every variable starting with `ANTHROPIC_` or `OPENAI_` and minus `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CURSOR_API_KEY`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, plus only the account's profile variable and its `credential_env` variables.

#### Scenario: Shell exports an API key
- **WHEN** the person's shell exports `ANTHROPIC_API_KEY` and runs `relay run claude:work`, an account without `credential_env`
- **THEN** Claude Code starts without `ANTHROPIC_API_KEY` and uses the subscription login in the `claude:work` profile

#### Scenario: One provider's key never reaches another
- **WHEN** `claude:api` lists `ANTHROPIC_API_KEY` and relay starts a worker on `codex:personal`
- **THEN** the Codex process receives no `ANTHROPIC_API_KEY`

### Requirement: Job variables at launch
Every agent relay starts SHALL also receive `RELAY_JOB` (the job ID), `RELAY_TARGET` (the account, for example `claude:work`), `RELAY_WORKER` (the worker ID) and `RELAY_HOME`, so hooks running inside the agent know their job, account and worker.

#### Scenario: Hook knows its account
- **WHEN** an agent started by `relay run claude:work` in job `3f9a2c1d` runs a hook
- **THEN** the hook's environment has `RELAY_JOB=3f9a2c1d`, `RELAY_TARGET=claude:work` and `RELAY_WORKER` set to the worker's 8-character ID

### Requirement: Listing accounts
`relay account list [--json]` SHALL show each account in `config.toml` with its profile folder, whether the program is installed, and the last recorded sign-in state, without running any provider command.

#### Scenario: Two accounts
- **WHEN** `claude:work` and `codex:personal` are configured
- **THEN** standard output has one line per account, such as `claude:work      ~/.relay/profiles/claude-work   signed in (claude.ai)`, and relay exits with code 0

### Requirement: Account status
`relay account status <account> [--json]` SHALL run the provider's status command, read the account's availability (live from the Codex app server; from recorded readings for Claude Code), and report sign-in, profile folder, availability with its source and age, hooks and status line.

#### Scenario: Claude account at its limit
- **WHEN** `claude:work` has a recorded `quota_exhausted` reading from its status line 12 minutes ago with reset 14:00
- **THEN** the output includes "  Availability  limit, resets 14:00 (status line, 12 min ago)"

#### Scenario: Unknown account
- **WHEN** the person runs `relay account status claude:nope`
- **THEN** relay prints "claude:nope is not one of your accounts. See relay account list." and exits with code 21

### Requirement: Signing in again
`relay account login <account>` SHALL run the provider's login for that account exactly as `relay account add` does, and SHALL exit with code 0 when the status command then reports the account as signed in, and 22 otherwise.

#### Scenario: Expired login
- **WHEN** `codex:personal` is signed out and the person runs `relay account login codex:personal` and completes the login
- **THEN** relay prints "codex:personal is signed in." and exits with code 0

### Requirement: Removing an account
`relay account remove <account> [--yes]` SHALL remove the account's table from `config.toml` after confirmation, and SHALL refuse while a project allow list names it or while `[defaults]`, `[t3]` or `[limits]` names it. It SHALL NOT delete or change the profile folder or anything inside it.

#### Scenario: Profile folder is kept
- **WHEN** the person removes `claude:work` and confirms
- **THEN** relay prints "Removed claude:work. Its profile folder is still at ~/.relay/profiles/claude-work. To sign out, run CLAUDE_CONFIG_DIR=~/.relay/profiles/claude-work claude auth logout, then delete the folder yourself."

#### Scenario: Still allowed on a project
- **WHEN** a `[[projects]]` entry allows `claude:work`
- **THEN** relay prints "claude:work is allowed on /Users/josue/app. Remove it from that project's allow list in config.toml first." and exits with code 2

#### Scenario: Still named in other settings
- **WHEN** `[defaults]` sets `account = "claude:work"`, or a `[t3]` or `[limits]` entry names `claude:work`
- **THEN** relay prints "claude:work is named in [defaults], [t3] or [limits] in config.toml. Remove it there first." and exits with code 2

### Requirement: Writing config.toml safely
relay SHALL change `config.toml` only by appending whole tables or removing one whole `[accounts."<id>"]` table, keeping every other byte, creating the file with mode 0600 when missing, writing a temporary file and renaming it, and restoring the previous content if the result does not pass validation. A removed table SHALL end at its last setting, so comments and blank lines before the next table stay. relay SHALL hold the lock `RELAY_HOME/locks/config.lock` from reading the file to renaming the new one, and SHALL refuse to change a `config.toml` that is a symbolic link.

#### Scenario: Comments survive
- **WHEN** `config.toml` holds the person's comments and `relay account add codex personal` succeeds
- **THEN** every line that was in the file before is still there, in the same order, followed by the new account table

#### Scenario: A comment above the next table
- **WHEN** `config.toml` holds `[accounts."claude:work"]`, then a blank line, the comment `# limits: keep me` and `[defaults]`, and the person removes `claude:work`
- **THEN** the comment and `[defaults]` are still there

#### Scenario: Two changes at once
- **WHEN** two `relay account add` commands for different accounts change `config.toml` at the same moment
- **THEN** the second waits for the first, and `config.toml` holds both accounts; a command that cannot take the lock within 2 seconds prints "Another relay command is changing config.toml. Try again when it finishes." and exits with code 6

#### Scenario: Linked config.toml
- **WHEN** `config.toml` is a symbolic link to a file in a dotfiles folder and the person adds an account
- **THEN** relay prints "relay: <path> is a symbolic link, and relay does not change config.toml through a link. Make the change in the file it leads to yourself, or replace the link with that file and try again.", exits with code 78, and leaves the link and the file unchanged
