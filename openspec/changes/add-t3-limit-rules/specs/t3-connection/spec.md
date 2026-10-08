# Spec Delta: t3-connection

## Purpose

relay acts on T3 Code threads only through T3's MCP server, the documented door for outside programs. This capability signs relay in to that server once, keeps the token T3 issues safe, warns before it expires, and shows the connection's state.

## ADDED Requirements

### Requirement: T3 settings
`config.toml` SHALL accept a `[t3]` table with `url` (the MCP address, default `http://127.0.0.1:3773/mcp`) and `projects` (a list of folder paths, default empty), and `[t3.instances.<id>]` tables, where `<id>` is a T3 provider instance ID, with `account` (an account defined under `accounts`) and optional `model` (a model ID). The host of `url` SHALL be `127.0.0.1` or `localhost`, the scheme `http`, and the path `/mcp`. Any other value SHALL be a settings problem with exit code 78.

#### Scenario: Network address refused
- **WHEN** `[t3]` sets `url = "http://192.168.1.20:3773/mcp"`
- **THEN** the problem list contains `t3.url: relay only connects to T3 Code on this computer (127.0.0.1 or localhost).` and relay exits with code 78

#### Scenario: Unknown account in an instance
- **WHEN** `[t3.instances.codex]` sets `account = "codex:work"` and no account `codex:work` exists
- **THEN** the problem list contains `t3.instances.codex.account: "codex:work" is not one of your accounts.`

### Requirement: Connecting
`relay t3 connect` SHALL require a terminal, reach the MCP server at `t3.url` (or `--url`), check that it offers the tools `t3_project_list`, `t3_thread_list`, `t3_thread_read`, `t3_thread_configure`, `t3_thread_send`, `t3_thread_interrupt` and `orchestrator_capabilities`, and then run T3's OAuth sign-in with PKCE, opening T3's approval page in the browser. Before opening it, relay SHALL print: `T3 Code will ask for a pairing code and an access level. Choose "full-access": T3 only lets relay act on threads whose permission mode is not broader than relay's, and new T3 threads use full access. relay never changes a thread's permission mode.`

#### Scenario: Successful connection
- **WHEN** the server offers every listed tool and the person approves relay on T3's page
- **THEN** relay stores the token, records the expiry time 30 days ahead, writes `url` to `[t3]` if it was given with `--url`, and prints `Connected to T3 Code <serverVersion>. The connection expires on <date>.`

#### Scenario: T3 not running
- **WHEN** nothing answers at `t3.url`
- **THEN** standard error shows `relay: T3 Code is not answering at <url>. Open T3 Code, then copy the address from Settings → Connections → Copy MCP URL.` and relay exits with code 40

#### Scenario: Stable or older T3 build
- **WHEN** the server answers but does not offer `t3_thread_configure`
- **THEN** standard error shows `relay: this T3 Code build cannot be driven by other programs. Install a nightly build from v0.0.46-nightly.20261006.2752 or later.` and relay exits with code 41

#### Scenario: No terminal
- **WHEN** `relay t3 connect` runs without a terminal on standard input
- **THEN** standard error shows `relay: connecting to T3 Code needs you at the keyboard. Run relay t3 connect in a terminal.` and relay exits with code 7

### Requirement: Mapping T3 providers to relay accounts
After signing in, `relay t3 connect` SHALL call `orchestrator_capabilities` and, for each provider instance whose driver is Claude or Codex and which has no `[t3.instances.<id>]` table, ask which relay account it uses, offering the only account of that provider as the default. It SHALL write each answer to `config.toml` and keep every other line as it was.

#### Scenario: One Claude and one Codex account
- **WHEN** T3 reports instances `claude` and `codex`, and relay has exactly `claude:personal` and `codex:personal`
- **THEN** relay asks `T3's provider "claude" uses which relay account? [claude:personal]` and the same for `codex`, and pressing Enter twice writes both tables

#### Scenario: Instance of another driver
- **WHEN** T3 also reports an instance whose driver is Cursor
- **THEN** relay prints `relay does not manage T3's provider "<id>" (Cursor).` and asks nothing about it

### Requirement: The token stays in the credential store
relay SHALL keep the T3 token only in the operating system's credential store (Keychain on macOS, Secret Service on Linux) under the service name `relay-t3` and the account name equal to `t3.url`. The token SHALL NOT appear in `config.toml`, any file under `RELAY_HOME`, any log, any event, any process argument or any error message. relay SHALL send it only in the `Authorization` header to `t3.url`.

#### Scenario: Nothing on disk
- **WHEN** a test connects to a fake T3 server that issues the token `t3tok_test_9f8e7d`
- **THEN** no file under `RELAY_HOME` and no log line contains `t3tok_test_9f8e7d`

#### Scenario: No credential store
- **WHEN** Linux has no Secret Service available
- **THEN** standard error shows `relay: there is no credential store to keep the T3 Code token in. Install and unlock a Secret Service provider (for example GNOME Keyring), then run relay t3 connect again.` and nothing is stored

### Requirement: Expiry
relay SHALL treat the connection as expired 30 days after it was made or as soon as T3 answers `401`. From 3 days before expiry, `relay status` and `relay t3 status` SHALL show `The T3 Code connection expires on <date>. Run relay t3 connect to renew it.` When it has expired, relay SHALL stop all T3 actions and show `The T3 Code connection has expired. Run relay t3 connect. No T3 thread is being watched.`

#### Scenario: Token rejected
- **WHEN** T3 answers `401` to a tool call
- **THEN** relay stops its T3 watcher, appends a `t3_disconnected` event with reason `token_rejected`, and `relay t3 status` shows the expired message

### Requirement: Disconnecting
`relay t3 disconnect` SHALL delete the token from the credential store, stop T3 actions, keep the `[t3]` settings, and print `relay forgot its T3 Code token. To revoke it in T3 as well, open Settings → Connections and remove "relay".`

#### Scenario: Disconnect
- **WHEN** the person runs `relay t3 disconnect` while connected
- **THEN** the credential store has no `relay-t3` entry for `t3.url`, and the daemon makes no further request to T3

### Requirement: Connection status
`relay t3 status` SHALL show the T3 address, T3's server version, the connection's expiry date, each enabled project, each instance mapping, each limit rule with its latest reading, and the last 10 actions relay took on T3 threads. `--json` SHALL print the same as JSON. It SHALL exit 0 when connected and 42 when not connected or expired.

#### Scenario: Not connected
- **WHEN** no token is stored
- **THEN** relay prints `relay is not connected to T3 Code. Run relay t3 connect.` and exits with code 42

### Requirement: Network use stays on this computer
Only `src/t3/client.ts` and `src/t3/oauth.ts` SHALL open network connections for T3: the client to the address in `t3.url`, which settings limit to `127.0.0.1` or `localhost`, and the sign-in to that address and to its own listener on `127.0.0.1`. The source check of `build-and-ci` SHALL allow `fetch` in those two files and `Bun.serve` in `src/t3/oauth.ts`, and nothing else under `src/t3/`.

#### Scenario: Another file reaches the network
- **WHEN** a file `src/t3/other.ts` calls `fetch`
- **THEN** `test/build/no-network.test.ts` fails and names `src/t3/other.ts:1: fetch`
