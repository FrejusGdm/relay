# The local API

The relay daemon answers HTTP requests with JSON on a private Unix socket, never on a network
port. relay's own commands use it, and the Mac app will. This page lists every endpoint, with a
`curl` example and a sample answer. `docs/daemon.md` explains the socket, the checks on
every connection and how to start the daemon. The design is in
`openspec/changes/add-daemon-api-and-status/design.md`, decisions 13 to 16.

The examples use the macOS socket path `~/.relay/run/relay.sock`. On Linux it is
`$XDG_RUNTIME_DIR/relay/relay.sock` unless `RELAY_HOME` is set; `relay daemon status` prints the
path. The host name in the URLs (`relay`) is ignored; only the path counts.

## Rules for every request

- Methods are `GET` and `POST`. Request heads may have 16 KiB, bodies 64 KiB sent with
  `Content-Length`, and the whole request must arrive within 10 seconds.
- One request per connection; every answer carries `Connection: close`.
- A request with an `Origin` header is refused with `403`, because only web pages send one.
- JSON answers use `Content-Type: application/json; charset=utf-8`.
- Every `GET` answer except the event stream carries the header `Relay-Stream-Seq`: the `id` of
  the newest event-stream event whose change the answer already shows. A client that also reads
  the event stream applies an event only when its `id` is greater than this number.
- Every field is always present. A value relay does not know is `null`, never left out.
- No answer adds numbers across accounts.

## Versioning

The major version is part of the path. Any path that starts with `/v<n>/` for another `n` gets
`404 unsupported_version`. Within `v1`, fields and endpoints may be added but are never removed or
renamed, so clients must ignore fields they do not know. A client checks `capabilities` in
`GET /v1/version`, not the version number, before it uses a group of endpoints:

| Capability | Endpoints |
|---|---|
| `accounts` | `GET /v1/providers`, `GET /v1/accounts`, `GET /v1/accounts/{target}` |
| `jobs` | `GET /v1/jobs`, `GET /v1/jobs/{job}`, `.../workers`, `.../checkpoints` |
| `events.sse` | `GET /v1/events` |
| `jobs.checkpoint` | `POST /v1/jobs/{job}/checkpoint` |
| `jobs.switch` | `POST /v1/jobs/{job}/switch` |
| `hooks` | `POST /v1/hooks/{provider}/{event}` |

## Endpoints

### GET /v1/version

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/version
{"api":"v1","daemon_version":"0.1.0","pid":4121,"started_at":"2026-10-08T12:02:11.402Z","schema_version":1,"stream_epoch":"9c41d0e2a7b35f18","capabilities":["accounts","jobs","events.sse","jobs.checkpoint","jobs.switch","hooks"],"agents_running":[]}
```

`agents_running` lists the agents that the daemon itself started through `POST
/v1/jobs/{job}/switch` and that still run, each as `{"worker": "…", "target": "codex:personal",
"job": "3f9a2c1d"}`. `relay daemon stop` reads it. An agent that runs under `relay run` in a
terminal is not listed, because it belongs to that command.

`stream_epoch` changes whenever the daemon rebuilds its index. A rebuilt index numbers its events
from the time it was built, in microseconds since 1970, so its numbers are above every number the
old index used, and an event `id` saved before the rebuild gets a `reset` (see the event stream
below). A client that saved an event `id` can also compare `stream_epoch` to see that the index
was rebuilt.

### GET /v1/providers

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/providers
{"providers":[{"id":"claude","name":"Claude Code","accounts":[Account, ...]},{"id":"codex","name":"Codex","accounts":[]}]}
```

### GET /v1/accounts and GET /v1/accounts/{target}

An account is an execution target, written `provider:account`, for example `claude:work`.
Accounts are sorted by `target`.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/accounts
{"accounts":[Account, ...]}
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/accounts/claude:work
{"account":{"target":"claude:work","provider":"claude","provider_name":"Claude Code","account":"work","configured":true,"availability":{"status":"rate_limited","reason":"Claude Code reported a rate limit","retry_at":null,"measured_at":"2026-10-07T14:02:11.402Z","source":"hook"},"usage":[]}}
```

`configured` is `false` for an account that events name but `config.toml` no longer lists.
`availability.status` is `available`, `rate_limited`, `quota_exhausted`, `unavailable` or
`unknown`. An account never measured has `"status":"unknown"` and every other field `null`. A
limit whose `retry_at` has passed is shown as `unknown` with the reason "The reset time has
passed; relay has not checked since.", because relay has not seen proof that the limit is over.
Each `usage` item is one limit window, narrowest first:
`{"window":"five_hour","window_minutes":300,"used_percent":9,"resets_at":"…","measured_at":"…"}`.

### GET /v1/jobs and GET /v1/jobs/{job}

Jobs are sorted by `updated_at`, newest first. A job ID is 8 lowercase hexadecimal characters.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/jobs
{"jobs":[Job, ...]}
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/jobs/3f9a2c1d
{"job":{"id":"3f9a2c1d","title":"Build authentication","state":"active","project_root":"/Users/you/projects/app","project_missing":false,"current_worker":null,"last_checkpoint":{"number":1,"commit":"912ec1…","ref":"refs/relay/jobs/3f9a2c1d/checkpoints/1","kind":"baseline","created_at":"2026-10-08T12:00:03.000Z","message":null},"updated_at":"2026-10-08T12:00:03.120Z"}}
```

`current_worker` is a Worker or `null`; `last_checkpoint` is a Checkpoint or `null`.

### GET /v1/jobs/{job}/workers

The job's workers, newest first.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/jobs/3f9a2c1d/workers
{"workers":[{"id":"w2","job_id":"3f9a2c1d","target":"codex:personal","mode":"interactive","state":"running","pid":5120,"provider_session_id":null,"from_handoff":true,"started_at":"…","ended_at":null,"exit_code":null,"end_reason":null}]}
```

`mode` is `headless`, `interactive` or `external`. `state` is computed when relay answers:
`ended` when an end was recorded, `running` while the process exists, `stopped` when the process
is gone without a recorded end, and `starting` before relay knows the process ID.

### GET /v1/jobs/{job}/checkpoints

The job's checkpoints, newest first, read from the git refs `refs/relay/jobs/<job>/checkpoints/<n>`.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/jobs/3f9a2c1d/checkpoints
{"checkpoints":[{"number":1,"commit":"912ec1…","ref":"refs/relay/jobs/3f9a2c1d/checkpoints/1","kind":"baseline","created_at":"2026-10-08T12:00:03.000Z","message":null,"head":"4b0c…","left_out":[]}]}
```

`kind` is `baseline`, `manual`, `pre_rollback`, `handoff` or `auto`. `head` is the commit the
person's `HEAD` pointed to, and `left_out` lists the files the checkpoint left out.

### GET /v1/events

The live event stream, in the server-sent events format. `?job=<id>` keeps only that job's events
and the account events; `?since=<id>` or the `Last-Event-ID` header resumes after an event (the
query parameter wins when both are given).

```
$ curl -s -N --unix-socket ~/.relay/run/relay.sock http://relay/v1/events
retry: 1000

id: 4181
event: availability
data: {"target":"claude:work","provider":"claude","provider_name":"Claude Code","account":"work","configured":true,"availability":{…},"usage":[]}

id: 4182
event: checkpoint
data: {"job_id":"3f9a2c1d","checkpoint":{…}}

: ping
```

| Event | Data |
|---|---|
| `job` | the Job, when a job is added or its fields change |
| `worker` | the Worker, when it starts, ends, gets its session ID, or its process is found gone |
| `checkpoint` | `{"job_id": …, "checkpoint": Checkpoint}` |
| `availability` | the whole Account, as `GET /v1/accounts/{target}` returns it |
| `hook` | `{"job_id": …, "provider": …, "event": …}` |
| `reset` | `{"stream_epoch": …}`: the requested position is older than the events the daemon keeps, or ahead of its newest event, or from before a rebuild of the index. Reload with the `GET` endpoints; the stream then sends only the events that come after the reset. |
| `shutdown` | `{}`: the daemon is stopping; the stream ends next |

The daemon keeps the newest 10,000 events for resuming. It reads the events for a stream only when
the client has read what it was sent, so a client that stops reading slows only its own stream. A comment line `: ping` arrives every
15 seconds. At most 32 streams can be open at once; the next one gets `503 too_many_streams`.

### POST /v1/jobs/{job}/checkpoint

Saves a checkpoint of the job's project, as `relay checkpoint` does, with the kind `manual`. The
body is empty or `{"message": "…"}`, with a message of at most 500 characters. No other field is
accepted, so a request cannot name a folder, a file or a command: the daemon takes the project
folder from its index and checks that it still holds the job.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock -X POST http://relay/v1/jobs/3f9a2c1d/checkpoint \
    -d '{"message":"before refactor"}'
{"checkpoint":{"number":8,"commit":"5be1c0e2…","ref":"refs/relay/jobs/3f9a2c1d/checkpoints/8","kind":"manual","created_at":"2026-10-08T14:05:00.000Z","message":"before refactor"}}
```

The answer is `201` with the new checkpoint. When nothing changed since the latest checkpoint, the
answer is `200` with that checkpoint. The checkpoint also reaches the event stream as a
`checkpoint` event. The checkpoint engine's refusals become `422 secret_found` (a possible secret
in a file), `422 untracked_secret_file` (an untracked file whose name looks like it holds secrets),
`409 git_changes_not_accepted` (the git settings or hooks changed since the job started) and `409
operation_in_progress`, each with the engine's own message.

### POST /v1/jobs/{job}/switch

Hands the job to another account, as `relay switch` does without a terminal. The body is
`{"target": "codex:personal", "confirm_new_provider": false}`; `confirm_new_provider` may be left
out and then counts as `false`. No other field is accepted.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock -X POST http://relay/v1/jobs/3f9a2c1d/switch \
    -d '{"target":"codex:personal","confirm_new_provider":false}'
{"error":{"code":"confirmation_required","message":"This sends the repository and the job notes to OpenAI through the account codex:personal. Continue?"}}
$ curl -s --unix-socket ~/.relay/run/relay.sock -X POST http://relay/v1/jobs/3f9a2c1d/switch \
    -d '{"target":"codex:personal","confirm_new_provider":true}'
{"handoff":{"handoff_id":2,"checkpoint_sha":"5be1c0e2…","prompt_path":"…/handoffs/2/prompt.md","to_worker_id":"9b2f71c4","outcome":"started","notes_source":"agent","mismatches":0},"worker":{"id":"9b2f71c4","job_id":"3f9a2c1d","target":"codex:personal","mode":"headless","state":"running","pid":5120,"provider_session_id":"019a…","from_handoff":true,"started_at":"…","ended_at":null,"exit_code":null,"end_reason":null}}
```

The answer is `200` once the next agent has started: `handoff` is the result that `relay switch
--json` prints, and `worker` the new worker. A switch can take minutes, because relay may ask the
outgoing agent for notes and runs the job's checks, so clients wait for the answer.

These answers refuse the switch before anything is stopped:

- `409 confirmation_required`: the account is not on the project's allow list yet, so the switch
  would send the code to a company it has not gone to before. The message is the question
  `relay switch` asks in a terminal. Send the request again with `"confirm_new_provider": true` to
  answer yes; relay records the answer with `"how": "api"`.
- `409 interactive_start_required`, with the message `This switch needs a terminal. Run relay
  switch codex:personal in the project.`: the job's agents run in the person's terminal, or the
  switch asks a question the API cannot answer, such as moving work from a work account to a
  personal one, or files that tell agents what to do that changed.
- `409 operation_in_progress`: a checkpoint or another switch of the job is running.
- `404 target_not_found`, `400 invalid_target` and `400 bad_request` for the account name.

When `relay run` in a terminal holds the job's agent, the daemon hands the switch to it, as `relay
switch` does, and the next agent runs under that `relay run`. Otherwise the daemon runs the
switch itself, and the next agent runs as a child of the daemon, with its output in
`logs/workers/<job>-<worker>.log`, and appears in `agents_running`. Any other refusal of the
switch engine is `500 engine_failed` with the engine's message, which says where the work is
saved.

### POST /v1/hooks/{provider}/{event}

`relay hook` sends each hook event here (`docs/hooks.md`). The body is the event as one line of
the hook spool. The daemon checks the line again, keeps only the allowed fields, puts it on its
hook queue and answers at once, before it records anything.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock -X POST http://relay/v1/hooks/claude/StopFailure \
    -d '{"v":1,"received_at":"2026-10-08T12:02:11.120Z","provider":"claude","event":"StopFailure","relay_job":null,"relay_target":"claude:work","relay_worker":null,"profile":"default","fields":{"error":"rate_limit"}}'
{"accepted":true}
```

The answer is `202`. The provider must be `claude` or `codex`, and the event a name of letters,
digits and underscores that matches the body; otherwise the answer is `400 bad_request`. When
1,000 events are already waiting, the answer is `503 hook_queue_full`, and `relay hook` writes the
event to the spool instead.

## Errors

Every error answer has the body `{"error": {"code": "...", "message": "..."}}`, with a plain
sentence as the message. `unsupported_version` adds `"supported": ["v1"]` inside `error`, and
`method_not_allowed` comes with an `Allow` header.

```
$ curl -s --unix-socket ~/.relay/run/relay.sock http://relay/v1/jobs/ffffffff
{"error":{"code":"job_not_found","message":"No job with id ffffffff."}}
```

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | The request or a parameter is not valid. |
| 400 | `invalid_target` | An account name is not `provider:account`. |
| 403 | `origin_not_allowed` | The request came from a web page. |
| 404 | `not_found` | No endpoint has this path. |
| 404 | `unsupported_version` | The path asks for an API version other than v1. |
| 404 | `job_not_found` | No indexed job has this ID. |
| 404 | `target_not_found` | No account has this name. |
| 405 | `method_not_allowed` | The path does not accept this method. |
| 409 | `operation_in_progress` | A checkpoint or switch of the job is already running, here or in a relay command. |
| 409 | `interactive_start_required` | The switch needs the person at a terminal. |
| 409 | `confirmation_required` | The switch sends the code to a new account; the message is the question. |
| 409 | `git_changes_not_accepted` | The git settings or hooks changed since the job started. |
| 409 | `project_missing` | The job's project folder is not where relay last saw it. |
| 411 | `length_required` | A body was sent without `Content-Length`. |
| 413 | `payload_too_large` | The body is larger than 64 KiB. |
| 422 | `secret_found` | The checkpoint found a possible secret; the message names the file and line. |
| 422 | `untracked_secret_file` | An untracked file's name looks like it holds secrets. |
| 431 | `headers_too_large` | The request head is larger than 16 KiB. |
| 500 | `engine_failed` | The checkpoint or switch engine stopped; the message is its own. |
| 500 | `internal_error` | A bug in relay; details are in the daemon log. |
| 503 | `shutting_down` | The daemon is stopping. |
| 503 | `too_many_streams` | 32 event streams are already open. |
| 503 | `hook_queue_full` | 1,000 hook events are already waiting. |

