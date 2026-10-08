# Spec Delta

## Purpose

relay keeps a job's content in `.relay/` files and git, and keeps only fast-changing, machine-local
state in a SQLite database. This capability defines what that database holds, how event log writes
stay ordered, and how the database is rebuilt from the files whenever it is lost.

## ADDED Requirements

### Requirement: SQLite holds live state only
The database `relay.db` under `RELAY_HOME` SHALL hold only the projects list, the jobs index, workers, execution targets, account availability, one event-log cursor per job and a bounded replay buffer for the event stream. It SHALL NOT be the only copy of any task, plan, decision, checkpoint or event.

#### Scenario: Deleting the database loses nothing about the job
- **WHEN** the daemon is stopped, `relay.db` is deleted and the daemon is started again
- **THEN** `GET /v1/jobs/3f9a2c1d`, its workers and its checkpoints return the same data as before the deletion

### Requirement: Rebuild from files
The daemon SHALL rebuild the database from `config.toml`, `projects.list`, each project's `.relay/state.json` and `.relay/events.jsonl`, and the git checkpoint refs, when the database file is missing, fails `PRAGMA integrity_check`, or has a `user_version` different from the schema version the daemon expects.

#### Scenario: Damaged database
- **WHEN** `relay.db` contains random bytes and the daemon starts
- **THEN** the damaged file is renamed to `relay.db.broken-<timestamp>`, a new database is built from the files, and the daemon logs "Rebuilt the index from <n> projects."

#### Scenario: Older schema
- **WHEN** `relay.db` has `user_version` 0 and the daemon expects 1
- **THEN** the daemon deletes it and rebuilds it from the files

### Requirement: Forced rebuild
`relay doctor --reindex` SHALL stop the daemon if it is running, delete `relay.db` and its write-ahead log files, start the daemon so it rebuilds, and print "Rebuilt the index from .relay/ files in <n> projects."

#### Scenario: Reindex while running
- **WHEN** the daemon is running and the person runs `relay doctor --reindex`
- **THEN** the command prints the rebuilt message, exits 0, and a daemon with a new process ID is running

### Requirement: Locked event log writes
Every relay process that appends to `.relay/events.jsonl` SHALL do so through phase 2's `appendEvent`, which SHALL hold an exclusive `flock` lock on `locks/<job>.events.lock` under `RELAY_HOME` while it reads the last event `id`, assigns the next integer, and appends one complete line ending in a newline. A process that dies while holding the lock SHALL NOT leave it held.

#### Scenario: Two writers at once
- **WHEN** two processes each append 500 events to the same job concurrently
- **THEN** the file gains 1000 complete lines whose `id` values continue, one by one and in file order, from the last `id` before the test

### Requirement: Following the event log
The daemon SHALL read each known job's `events.jsonl` from its saved byte cursor when the file changes and at least every 2 seconds, SHALL leave an incomplete last line for the next read, SHALL skip and log lines that are not valid JSON, and SHALL rebuild that job's index when the file shrinks or is replaced.

#### Scenario: An event written by the command-line tool
- **WHEN** `relay checkpoint` runs without going through the API and appends a `checkpoint_saved` event
- **THEN** within 2 seconds the daemon updates the job's last checkpoint and sends a `checkpoint` event on the event stream

#### Scenario: The file is replaced
- **WHEN** `events.jsonl` is replaced by an older, shorter copy (relay's own rollback never does this; a person or a program can)
- **THEN** the daemon rebuilds that job's workers and last checkpoint from the replaced file

### Requirement: Known projects list
The system SHALL keep known project roots in `projects.list` under `RELAY_HOME`, one absolute path per line, appended with a single write and deduplicated when read. `relay init` and every command that resolves a job SHALL append the project root if it is not already listed.

#### Scenario: A moved project
- **WHEN** a listed project root no longer exists at rebuild time
- **THEN** its jobs are left out of the index, the project is marked missing, and the rebuild continues with the other projects
