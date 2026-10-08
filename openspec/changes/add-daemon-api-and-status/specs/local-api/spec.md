# Spec Delta

## Purpose

The local API lets the relay command, provider hooks and later the Mac app read a job's live state
and ask for a checkpoint or a switch. It is HTTP with JSON, served only on a private Unix domain
socket, so web pages and other users on the machine cannot reach it.

## ADDED Requirements

### Requirement: Unix socket only
The daemon SHALL listen only on a Unix domain socket named `relay.sock` in the runtime directory: `$RELAY_HOME/run/` on macOS or when `RELAY_HOME` is set, and `$XDG_RUNTIME_DIR/relay/` on Linux otherwise. It SHALL NOT open any TCP or UDP port. The socket file SHALL have mode `0600`.

#### Scenario: No network port
- **WHEN** the daemon is running
- **THEN** `lsof -a -p <pid> -i` lists no TCP or UDP sockets for the daemon process

#### Scenario: Socket path too long
- **WHEN** the socket path is longer than 103 bytes on macOS or 107 bytes on Linux
- **THEN** the daemon does not start and logs "relay cannot start: the socket path <path> is too long. Set RELAY_HOME to a shorter path."

### Requirement: Private runtime directory
Before creating the socket, the daemon SHALL create the runtime directory with mode `0700` if it is missing, and SHALL refuse to start if the directory is a symbolic link, is not owned by the current user, or grants any permission to group or others.

#### Scenario: Directory readable by others
- **WHEN** the runtime directory exists with mode `0755`
- **THEN** the daemon does not start and logs "relay cannot start: <dir> must be private (mode 0700, owned by you). Fix it with: chmod 700 <dir>"

#### Scenario: Directory is a symbolic link
- **WHEN** the runtime directory is a symbolic link
- **THEN** the daemon does not start and logs "relay cannot start: <dir> is a symbolic link."

### Requirement: Peer user check
For every accepted connection the daemon SHALL ask the kernel for the connecting process's user ID and SHALL close the connection without reading or answering when that ID differs from the daemon's own user ID or cannot be determined.

#### Scenario: Same user
- **WHEN** a process running as the same user connects and sends `GET /v1/version`
- **THEN** it receives a `200` response

#### Scenario: Different user
- **WHEN** the connecting user ID differs from the daemon's user ID
- **THEN** the connection is closed with no response bytes and the daemon logs a `warn` entry with the peer user ID

### Requirement: HTTP and JSON under /v1
The API SHALL accept HTTP/1.1 requests with methods `GET` and `POST`, bodies up to 64 KiB declared by `Content-Length`, and headers up to 16 KiB. Every response SHALL carry `Connection: close`. JSON bodies SHALL use UTF-8. Requests with an `Origin` header SHALL be refused with `403`.

#### Scenario: Body too large
- **WHEN** a client sends a `POST` body of 70,000 bytes
- **THEN** the response is `413` with error code `payload_too_large`

#### Scenario: Request from a browser context
- **WHEN** a request carries `Origin: https://example.com`
- **THEN** the response is `403` with error code `origin_not_allowed`

### Requirement: Error format
Every error response SHALL have a JSON body `{"error": {"code": <string>, "message": <plain English sentence>}}` and one of these status codes: 400, 403, 404, 405, 409, 411, 413, 422, 431, 500, 503.

#### Scenario: Unknown job
- **WHEN** a client requests `GET /v1/jobs/ffffffff` and no job ffffffff is indexed
- **THEN** the response is `404` with body `{"error":{"code":"job_not_found","message":"No job with id ffffffff."}}`

#### Scenario: Wrong method
- **WHEN** a client sends `DELETE /v1/jobs/3f9a2c1d`
- **THEN** the response is `405` with error code `method_not_allowed` and an `Allow` header

### Requirement: Versioning
`GET /v1/version` SHALL return `api`, `daemon_version`, `pid`, `started_at`, `schema_version`, a `stream_epoch` that changes whenever the index is rebuilt (the Mac app needs it to tell a rebuilt event stream from a restart), and a `capabilities` array. A request for any other major version path SHALL return `404` with code `unsupported_version` and `supported: ["v1"]`. Within `/v1`, fields SHALL only be added, never removed or renamed.

#### Scenario: Capabilities
- **WHEN** a client calls `GET /v1/version`
- **THEN** `capabilities` contains `accounts`, `jobs`, `events.sse`, `jobs.checkpoint`, `jobs.switch` and `hooks`

#### Scenario: Future version
- **WHEN** a client calls `GET /v2/jobs`
- **THEN** the response is `404` with code `unsupported_version`

### Requirement: Providers and accounts with availability
`GET /v1/providers` SHALL return each provider with its accounts, and `GET /v1/accounts` and `GET /v1/accounts/{target}` SHALL return accounts (execution targets such as `claude:personal`) with an `availability` object whose unmeasured fields are `null`, never omitted. No response SHALL contain a total across accounts.

#### Scenario: Unmeasured account
- **WHEN** `codex:personal` has never reported availability
- **THEN** its `availability` is `{"status":"unknown","reason":null,"retry_at":null,"measured_at":null,"source":null}` and its `usage` is `[]`

#### Scenario: Rate-limited account
- **WHEN** a Claude Code `StopFailure` hook with `error` `rate_limit` arrived for `claude:work`
- **THEN** `GET /v1/accounts/claude:work` returns `availability.status` `rate_limited` with `measured_at` set to when the hook arrived

### Requirement: Jobs, workers and checkpoints
`GET /v1/jobs` and `GET /v1/jobs/{job}` SHALL return jobs from the index. `GET /v1/jobs/{job}/workers` SHALL return the job's workers newest first. `GET /v1/jobs/{job}/checkpoints` SHALL return the job's checkpoints read from the git refs, newest first.

#### Scenario: Job detail
- **WHEN** a client calls `GET /v1/jobs/3f9a2c1d` for an indexed job
- **THEN** the response contains `id`, `title`, `state`, `project_root`, `current_worker` (or `null`) and `last_checkpoint` (or `null`)

#### Scenario: Checkpoints come from git
- **WHEN** a checkpoint ref was created by `relay checkpoint` while the daemon was running
- **THEN** `GET /v1/jobs/3f9a2c1d/checkpoints` lists it first with its full commit hash and ref name

### Requirement: Live events stream
`GET /v1/events` SHALL respond with `Content-Type: text/event-stream`, send each new event with an increasing `id`, accept `?job=<id>` to filter and `Last-Event-ID` or `?since=<id>` to resume, send a comment line every 15 seconds, and send a `reset` event, whose data holds the `stream_epoch`, when the requested position is no longer retained or is ahead of the newest event (the Mac app needs the second case to notice a cursor from a rebuilt database). The data of an `availability` event SHALL be the whole account object that `GET /v1/accounts/{target}` returns, so clients decode one shape. When the daemon finds that a worker's process is gone and no end was recorded, it SHALL send one `worker` event with state `stopped` (the Mac app needs it to show the change without polling).

#### Scenario: Resume after a disconnect
- **WHEN** a client reconnects with `Last-Event-ID: 4180` and events 4181 and 4182 exist
- **THEN** the stream first sends events 4181 and 4182 in order, then new events as they happen

#### Scenario: Position too old
- **WHEN** a client asks for `since=10` and the oldest retained event is 5000
- **THEN** the stream first sends an event of type `reset` so the client reloads its data

#### Scenario: Position ahead of the history
- **WHEN** a client asks for `since=4180` and the newest event is 12, because the index was rebuilt
- **THEN** the stream first sends an event of type `reset` with the new `stream_epoch`

#### Scenario: A worker disappears
- **WHEN** a worker's process ends without a `worker_ended` event
- **THEN** within 2 seconds the stream sends one `worker` event for it with `state` `stopped`

### Requirement: Snapshot position on GET answers
Every `GET` answer except `GET /v1/events` SHALL carry the header `Relay-Stream-Seq` with the highest event stream `id` whose change the answer already shows, read together with the answer's data. The Mac app needs it to order an answer against the events it receives.

#### Scenario: An answer and the stream agree
- **WHEN** the newest event on the stream has `id` 4182 and a client calls `GET /v1/jobs/3f9a2c1d`
- **THEN** the answer carries `Relay-Stream-Seq: 4182` and shows every change up to that event

### Requirement: Checkpoint and switch actions
`POST /v1/jobs/{job}/checkpoint` and `POST /v1/jobs/{job}/switch` SHALL perform the operation by calling the checkpoint engine and the switch engine, SHALL allow one operation per job at a time, and SHALL accept no shell command and no path to execute.

#### Scenario: Checkpoint
- **WHEN** a client sends `POST /v1/jobs/3f9a2c1d/checkpoint` with `{"message":"before refactor"}`
- **THEN** the response is `201` with the new checkpoint, and an event of type `checkpoint` appears on the event stream

#### Scenario: Concurrent operation
- **WHEN** a checkpoint of job 3f9a2c1d is running and a second checkpoint or switch request for job 3f9a2c1d arrives
- **THEN** the second response is `409` with code `operation_in_progress`

#### Scenario: Switch needs a terminal
- **WHEN** a client asks to switch job 3f9a2c1d to a target whose start requires the person's terminal
- **THEN** the response is `409` with code `interactive_start_required` and the message "This switch needs a terminal. Run relay switch <target> in the project."

#### Scenario: First handoff to a new provider
- **WHEN** the switch engine requires confirmation because the target's provider is not yet on the project's allow list and the body lacks `"confirm_new_provider": true`
- **THEN** the response is `409` with code `confirmation_required` and nothing is stopped or started
