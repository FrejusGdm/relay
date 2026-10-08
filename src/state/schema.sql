-- The live-state index (add-daemon-api-and-status, design decision 10). It is a cache: every row
-- can be rebuilt from config.toml, projects.list, the .relay/ files and git.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- built_at, daemon_version, stream_epoch
CREATE TABLE projects (
  root_path    TEXT PRIMARY KEY,                -- absolute worktree root
  missing      INTEGER NOT NULL DEFAULT 0,      -- 1 when the folder was not found at the last rebuild
  last_seen_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id                     TEXT PRIMARY KEY CHECK (id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  project_root           TEXT NOT NULL REFERENCES projects(root_path) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  state                  TEXT NOT NULL,          -- copied from state.json, not interpreted
  current_worker_id      TEXT,
  last_checkpoint_number INTEGER,
  last_checkpoint_commit TEXT,
  last_checkpoint_at     TEXT,
  last_checkpoint_kind   TEXT,
  last_checkpoint_message TEXT,
  updated_at             TEXT NOT NULL
);
CREATE TABLE targets (
  id          TEXT PRIMARY KEY,                 -- 'claude:work'
  provider    TEXT NOT NULL,                    -- 'claude'
  account     TEXT NOT NULL,                    -- 'work'
  profile_dir TEXT,
  configured  INTEGER NOT NULL                  -- 1 when present in config.toml
);
CREATE TABLE availability (
  target_id   TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('available','rate_limited','quota_exhausted','unavailable','unknown')),
  reason      TEXT,
  retry_at    TEXT,
  measured_at TEXT,
  source      TEXT,
  usage_json  TEXT NOT NULL DEFAULT '[]'        -- [{window, window_minutes, used_percent, resets_at, measured_at}]
);
CREATE TABLE workers (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_id           TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('headless','interactive','external')),
  pid                 INTEGER,
  provider_session_id TEXT,
  from_handoff        INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  exit_code           INTEGER,
  end_reason          TEXT,
  found_gone_at       TEXT                      -- when the daemon found the process gone without an end
);
CREATE INDEX workers_by_job ON workers(job_id, started_at DESC);
CREATE TABLE event_cursors (
  job_id        TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                  -- <root>/.relay/events.jsonl
  device        INTEGER NOT NULL,
  inode         INTEGER NOT NULL,
  offset        INTEGER NOT NULL,               -- bytes read so far (always at a line end)
  last_event_id INTEGER NOT NULL
);
CREATE TABLE stream_events (                    -- replay buffer for GET /v1/events
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT,
  type    TEXT NOT NULL,
  data    TEXT NOT NULL,
  ts      TEXT NOT NULL
);
PRAGMA user_version = 1;
