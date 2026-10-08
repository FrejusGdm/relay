# Spec Delta

## Purpose

The relay daemon is the background process that keeps a job's live state, serves the local API and
receives provider hooks. This capability covers how it starts, how only one runs per user, how it
stops cleanly and where it writes its logs.

## ADDED Requirements

### Requirement: One daemon per user
The system SHALL run at most one daemon per user and `RELAY_HOME`. The daemon SHALL hold an exclusive operating-system lock on `daemon.lock` in the runtime directory for its whole life and SHALL write `daemon.pid` (JSON with `pid`, `started_at`, `version` and `socket`) only after it holds the lock.

#### Scenario: A second daemon finds the lock taken
- **WHEN** a daemon is running and a second `relay daemon run` starts with the same `RELAY_HOME`
- **THEN** the second process exits with code 0 without touching the socket, and writes "relay daemon is already running (pid <pid>)" to standard error

#### Scenario: A crashed daemon leaves stale files
- **WHEN** the previous daemon was killed with `SIGKILL`, leaving `relay.sock` and `daemon.pid` behind
- **THEN** the next daemon acquires the lock, removes the stale socket and pid file, and starts normally

### Requirement: Starting on demand
The commands that start agents (`relay run` and `relay switch`) SHALL start the daemon when it is not running, as a detached process with standard input set to `/dev/null`, and SHALL wait up to 3 seconds for `GET /v1/version` to answer before continuing.

#### Scenario: relay switch starts the daemon
- **WHEN** no daemon is running and the person runs `relay switch codex:personal`
- **THEN** a daemon process is running afterwards, it is not a child that dies with the terminal, and `relay daemon status` reports it as running

#### Scenario: The daemon cannot start
- **WHEN** the daemon fails to answer within 3 seconds
- **THEN** the command prints "relay could not start its background service. Details are in <log path>." to standard error and continues the work it can do without the daemon

### Requirement: Explicit daemon commands
The system SHALL provide `relay daemon start`, `relay daemon stop`, `relay daemon restart`, `relay daemon status` and `relay daemon run` (foreground). `relay daemon status` SHALL exit 0 when the daemon is running and 10 when it is not.

#### Scenario: Starting when already running
- **WHEN** the daemon is running and the person runs `relay daemon start`
- **THEN** the command prints "relay daemon is already running (pid <pid>)" and exits 0

#### Scenario: Status of a stopped daemon
- **WHEN** no daemon is running and the person runs `relay daemon status`
- **THEN** the command prints "relay daemon is not running" and exits 10

### Requirement: Stopping only the daemon relay owns
`relay daemon stop` SHALL send `SIGTERM` only to a process whose ID matches both `daemon.pid` and the `pid` field returned by `GET /v1/version`. When the daemon holds the lock but does not answer, the command SHALL not send any signal and SHALL tell the person how to stop it.

#### Scenario: Normal stop
- **WHEN** the daemon is running and answering and the person runs `relay daemon stop`
- **THEN** the daemon exits within 10 seconds, the socket and pid file are removed, and the command prints "relay daemon stopped" and exits 0

#### Scenario: The daemon does not answer
- **WHEN** the lock is held but `GET /v1/version` does not answer within 1 second
- **THEN** no signal is sent, the command prints "relay daemon (pid <pid>) is not responding. Stop it with: kill <pid>" and exits 1

#### Scenario: The pid file names another process
- **WHEN** `daemon.pid` names a process ID that differs from the `pid` reported by the API
- **THEN** no signal is sent to the process named in the file and the command exits 1 with "relay found a pid file that does not match the running daemon. Run relay daemon status."

### Requirement: Agents started by the daemon
When agents started by the daemon itself (headless workers from `POST /v1/jobs/{job}/switch`) are running, `relay daemon stop` SHALL refuse without `--force`, naming them. On shutdown the daemon SHALL stop them through their adapter's `stop` operation, wait up to 30 seconds, and record each with a `worker_ended` event whose `end_reason` is `relay_stopped`.

#### Scenario: Stop with a running agent
- **WHEN** the daemon started a Codex worker for job `3f9a2c1d` that is still running and the person runs `relay daemon stop`
- **THEN** nothing is stopped, the command prints "relay daemon is running 1 agent (codex:personal on job 3f9a2c1d). Stopping the daemon stops it too. Run relay daemon stop --force to continue." and exits 1

#### Scenario: Forced stop
- **WHEN** the same situation occurs and the person runs `relay daemon stop --force`
- **THEN** the worker is stopped, a `worker_ended` event with `end_reason` `relay_stopped` is appended to the job's event log, and the daemon exits

### Requirement: Clean shutdown
On `SIGTERM` or `SIGINT` the daemon SHALL stop accepting connections, send a `shutdown` event to every event-stream client, let running checkpoint and switch operations finish for up to 30 seconds, checkpoint the SQLite write-ahead log, remove the socket and pid file, and exit 0.

#### Scenario: Shutdown during a checkpoint
- **WHEN** a `POST /v1/jobs/{job}/checkpoint` request is running and the daemon receives `SIGTERM`
- **THEN** the checkpoint completes and its response is sent before the daemon exits, and a new connection attempt during shutdown is refused

#### Scenario: Event-stream clients are told
- **WHEN** a client is connected to `GET /v1/events` and the daemon receives `SIGTERM`
- **THEN** the client receives an event of type `shutdown` before the connection closes

### Requirement: Daemon logs
The daemon SHALL write JSON lines (`ts`, `level`, `msg` and named fields) to `logs/daemon.log` under `RELAY_HOME`, rotate the file at 10 MB keeping 5 older files, create log files with mode `0600`, and never write environment variables, credentials or hook fields outside the hook allow list.

#### Scenario: Rotation
- **WHEN** `daemon.log` would grow past 10 MB
- **THEN** it is renamed to `daemon.log.1`, older files shift up to `daemon.log.5`, the oldest is deleted, and a new `daemon.log` is started

#### Scenario: Nothing secret is logged
- **WHEN** the daemon starts with `ANTHROPIC_API_KEY=sk-test-123` in its environment and handles a hook whose payload contains `tool_input`
- **THEN** neither `sk-test-123` nor the `tool_input` content appears in any file under `logs/`
