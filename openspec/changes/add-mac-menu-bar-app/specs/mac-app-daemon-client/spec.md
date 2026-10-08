# Spec Delta

## Purpose

The Mac app reads relay's live state from the local daemon. This capability defines how it finds
and checks the private Unix socket, the small part of HTTP it speaks, the endpoints it calls, and
how it follows and resumes the live event stream.

## ADDED Requirements

### Requirement: Socket location
The app SHALL connect only to the Unix socket `<RELAY_HOME>/run/relay.sock`, where `RELAY_HOME` is the absolute path in the app's own environment variable `RELAY_HOME` when set, and `~/.relay` otherwise. The app SHALL NOT open any TCP or UDP connection.

#### Scenario: Default location
- **WHEN** the app starts without a `RELAY_HOME` variable
- **THEN** it connects to `~/.relay/run/relay.sock`

#### Scenario: No network connection
- **WHEN** the app has run for one minute against a fake daemon
- **THEN** `lsof -a -p <app pid> -i` lists no TCP or UDP sockets

#### Scenario: Path too long
- **WHEN** the socket path is longer than 103 bytes
- **THEN** the app does not connect and shows "The socket path <path> is too long. Set RELAY_HOME to a shorter path."

### Requirement: Folder and socket checks before connecting
Before every connection the app SHALL check, without following symbolic links, that `<RELAY_HOME>/run` is a folder owned by the current user with no permission bits for the group or others, and that `relay.sock` is a socket. It SHALL NOT connect when a check fails.

#### Scenario: Folder open to others
- **WHEN** `<RELAY_HOME>/run` has mode `0755`
- **THEN** the app does not connect and shows "<dir> must be private (mode 0700, owned by you). Fix it with: chmod 700 <dir>"

#### Scenario: Folder is a symbolic link
- **WHEN** `<RELAY_HOME>/run` is a symbolic link
- **THEN** the app does not connect and shows "<dir> is a symbolic link. relay only uses a real folder."

#### Scenario: Daemon not running
- **WHEN** the folder or the socket does not exist, or connecting fails with `ECONNREFUSED`
- **THEN** the app shows the state "relay is not running" with the command `relay daemon start`

### Requirement: The daemon runs as the same user
After connecting and before writing any byte, the app SHALL read the peer's user ID with `getpeereid` and SHALL close the connection when the call fails or the user ID differs from the app's own.

#### Scenario: Peer is another user
- **WHEN** the expected user ID differs from the peer's user ID
- **THEN** the fake daemon receives no request bytes and the app shows "The relay socket belongs to another user."

### Requirement: HTTP subset
The app SHALL send HTTP/1.1 `GET` and `POST` requests with `Host: relay`, SHALL NOT send `Origin`, `Cookie`, `Authorization` or `Transfer-Encoding` headers, and SHALL send `POST` bodies as JSON with `Content-Length`. It SHALL accept a response only when its head ends within 16 KiB, its status line starts with `HTTP/1.1`, it has no `Transfer-Encoding` header, and, for every endpoint except `/v1/events`, its body is at most 4 MiB, read by `Content-Length` or until the connection closes. The `/v1/events` body SHALL be read as a stream: each event SHALL reach the app's state as soon as its blank line arrives, the stream SHALL have no length limit and no overall time limit, one event being read SHALL be at most 1 MiB, and 45 seconds without bytes SHALL end it.

#### Scenario: No Origin header
- **WHEN** the app sends any request to the fake daemon
- **THEN** the recorded request head contains no `Origin`, `Cookie` or `Authorization` header

#### Scenario: Response split into pieces
- **WHEN** the fake daemon sends a valid response split at any byte position
- **THEN** the app decodes the same result as when the response arrives in one piece

#### Scenario: Long-lived stream
- **WHEN** the fake daemon keeps the event stream open for 10 minutes (injected clock), sends `: ping` every 15 seconds and 5 MiB of events in total
- **THEN** every event is applied as it arrives, and the stream is not closed by the 2-second request limit or the 4 MiB body limit

#### Scenario: One event too large
- **WHEN** one event's `data:` lines pass 1 MiB before its blank line
- **THEN** the app closes the stream and reconnects

#### Scenario: Chunked response refused
- **WHEN** a response carries `Transfer-Encoding: chunked`
- **THEN** the request fails as a malformed response and no data from it reaches the card

#### Scenario: Error body
- **WHEN** the daemon answers `404` with `{"error":{"code":"job_not_found","message":"No job with id ffffffff."}}`
- **THEN** the client returns an error with status 404, code `job_not_found` and that message

### Requirement: Version and capabilities
On every connection cycle the app SHALL first call `GET /v1/version` and SHALL use the other endpoints only when `api` is `v1` and `capabilities` contains `accounts`, `jobs` and `events.sse`. The switch action SHALL be offered only when `capabilities` contains `jobs.switch`.

#### Scenario: Old daemon
- **WHEN** `GET /v1/version` returns capabilities without `events.sse`
- **THEN** the app shows "This relay is too old for this app" with the command `relay daemon restart` and calls no other endpoint

#### Scenario: No switch capability
- **WHEN** `capabilities` lacks `jobs.switch`
- **THEN** the expanded card shows no "Switch worker…" button

### Requirement: Endpoints the app calls
The app SHALL read state only with `GET /v1/version`, `GET /v1/accounts`, `GET /v1/jobs`, `GET /v1/jobs/{job}`, `GET /v1/jobs/{job}/workers` and `GET /v1/events`, and SHALL send only `POST /v1/jobs/{job}/switch`. Job IDs SHALL match `^[0-9a-f]{8}$` and targets `^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$` before a request is built. Unknown JSON fields SHALL be ignored, and unknown values of status, state, mode, end reason and kind SHALL be shown as "Unknown".

#### Scenario: Only known paths
- **WHEN** the app runs through its whole test suite against the fake daemon
- **THEN** every recorded request path is one of the paths above

#### Scenario: New field added by the daemon
- **WHEN** a `Job` in a response has an extra field `"priority": 3`
- **THEN** the job decodes and the card shows it as before

#### Scenario: New availability status
- **WHEN** an account's `availability.status` is `"paused"`
- **THEN** the account decodes and its words are "Unknown"

### Requirement: Following the event stream
The app SHALL follow `GET /v1/events` and apply `job`, `worker`, `checkpoint` and `availability` events to its state. It SHALL apply an event to an object only when the event's `id` is greater than the sequence number of the data the app holds for that object, where `GET` data carries the number in the `Relay-Stream-Seq` response header. When that header is absent, it SHALL change a job only for a strictly newer `updated_at`, an availability only for a strictly newer `measured_at`, and a checkpoint only for a higher `number`. In every case a worker's state SHALL only move forward (`starting`, `running`, `stopped`, `ended`) and a worker with `ended_at` SHALL keep it. The app SHALL reload all state with the `GET` endpoints on a `reset` event and after every reconnection, and SHALL treat a `shutdown` event as "relay is not running".

#### Scenario: Availability changes live
- **WHEN** the fake daemon sends an `availability` event marking `claude:work` as `rate_limited`
- **THEN** the card's worker row for `claude:work` shows "Limit reached" without any other request

#### Scenario: Older event after a newer GET
- **WHEN** a `job` event with an older `updated_at` arrives after `GET /v1/jobs` returned a newer copy of that job
- **THEN** the store keeps the newer copy

#### Scenario: Replayed running worker after a stopped snapshot
- **WHEN** `GET /v1/jobs/{job}/workers` returns worker `5d2e8f01` as `stopped` with `ended_at` `null`, and a replayed `worker` event then reports `5d2e8f01` as `running`, with and without a `Relay-Stream-Seq` header greater than the event's `id`
- **THEN** the store keeps `5d2e8f01` as `stopped` and the card shows "Codex stopped · relay did not record why"

#### Scenario: Event newer than the snapshot
- **WHEN** a `GET` answer carries `Relay-Stream-Seq: 4180` and a `worker` event with `id` 4181 reports the same worker as `ended`
- **THEN** the store shows the worker as `ended`

#### Scenario: Reset
- **WHEN** the fake daemon sends an event of type `reset`
- **THEN** the app calls `GET /v1/accounts` and `GET /v1/jobs` again

#### Scenario: Shutdown
- **WHEN** the fake daemon sends `shutdown` and closes the stream
- **THEN** the app shows "relay is not running"

### Requirement: Liveness refresh
While the event stream is connected, the app SHALL repeat `GET /v1/accounts`, `GET /v1/jobs` and `GET /v1/jobs/{job}/workers` for the shown job every 30 seconds while a window of the app is open, every 5 minutes while none is open, and once when a window opens, and SHALL apply the answers by the same ordering rules as other snapshots.

#### Scenario: Worker disappears after the first snapshot
- **WHEN** the first snapshot shows worker `5d2e8f01` as `running`, the stream stays healthy with only `: ping` lines, and 30 seconds later (injected clock, window open) `GET /v1/jobs/{job}/workers` returns it as `stopped` with the job's `updated_at` unchanged
- **THEN** the card shows "Codex stopped · relay did not record why"

#### Scenario: Window closed
- **WHEN** no window is open for 10 minutes (injected clock) with a healthy stream
- **THEN** the fake daemon records at most 2 refreshes of `GET /v1/jobs`

### Requirement: Event cursor belongs to one daemon instance
The app SHALL keep its last event ID together with the daemon instance it came from, the `pid` and `started_at` of `GET /v1/version`. When `GET /v1/version` reports another instance, or the stream sends `reset`, the app SHALL forget the last event ID and every stored sequence number before it opens the stream again, and SHALL open it without `Last-Event-ID`.

#### Scenario: Reconnecting after a rebuilt database
- **WHEN** the app applied events up to `id` 4180, the fake daemon restarts with a new `pid` and `started_at` (as after `relay doctor --reindex`) and numbers its events again from 1, and then sends a `worker` event with `id` 3
- **THEN** the new stream request carries no `Last-Event-ID`, and the store applies the event with `id` 3

#### Scenario: Same instance
- **WHEN** the stream drops and `GET /v1/version` reports the same `pid` and `started_at`
- **THEN** the new stream request carries the last event ID

### Requirement: Reconnecting
When the event stream ends, fails, or delivers no byte for 45 seconds, the app SHALL reconnect after the stream's `retry` delay, then after 2, 4, 8, 16 and at most 30 seconds, SHALL reset this count only after a healthy cycle (version, every snapshot `GET`, and a `200` event stream that delivered at least one byte after its head), SHALL send `Last-Event-ID` with the last event ID it applied, and SHALL try at once when the person opens the menu-bar window. The app SHALL never repeat a `POST` by itself.

#### Scenario: Resume after a disconnect
- **WHEN** the stream closes after the event with ID 4180 and the fake daemon is reachable again
- **THEN** the next stream request carries `Last-Event-ID: 4180` (the daemon instance is unchanged) and the app reloads state with the `GET` endpoints

#### Scenario: Silent stream
- **WHEN** no byte arrives on the stream for 45 seconds (with the injected clock)
- **THEN** the app closes the stream and opens a new one

#### Scenario: Version answers but the stream is refused
- **WHEN** `GET /v1/version` and the snapshot `GET`s succeed but `GET /v1/events` answers `503` every time for one minute (injected clock)
- **THEN** the app requests `/v1/events` at most 7 times in that minute

#### Scenario: Back-off while the daemon is down
- **WHEN** the socket is missing for one minute
- **THEN** the app tries to connect at most 7 times in that minute
