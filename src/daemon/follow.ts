// Following the job files (design.md decision 12). For each indexed job the daemon watches
// events.jsonl and also checks it every 2 seconds, because watching alone misses changes on some
// file systems. New complete lines are applied from the saved byte cursor; a file that shrank or
// was replaced makes the daemon rebuild that job, and a file that is gone marks the project
// missing. The same check picks up new roots in projects.list and finds workers whose process is
// gone without a recorded end.
import type { Database } from "bun:sqlite";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { EventStream } from "../api/sse";
import type { Logger } from "../core/log";
import { readState } from "../job/state";
import { applyEvent, type StreamChange } from "../state/apply-event";
import { indexProject, newestCheckpoint, readEventsFrom, setCheckpoint } from "../state/index-builder";
import { readProjects } from "../state/projects-list";
import { getJob, getWorker, processExists } from "../state/queries";

interface Cursor {
  job_id: string;
  path: string;
  device: number;
  inode: number;
  offset: number;
  project_root: string;
}

interface FollowOptions {
  db: Database;
  relayHome: string;
  stream: EventStream;
  log: Logger;
  intervalMs?: number;
}

export class Follower {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly opts: FollowOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 2000);
    void this.check();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.running;
  }

  // Runs one check; a check asked for while one runs is run once more afterwards.
  check(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.checkOnce();
        } catch (error) {
          this.opts.log.error("follow_failed", { error_name: error instanceof Error ? error.name : typeof error });
        }
      } while (this.again && this.timer !== null);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async checkOnce(): Promise<void> {
    const { db, relayHome } = this.opts;
    // A root marked missing is read again once its state.json exists, so a job set up there later,
    // or a project folder put back, is found. Until then the job keeps its rows, shown as missing.
    const known = new Map(
      db
        .query<{ root_path: string; missing: number }, []>("SELECT root_path, missing FROM projects")
        .all()
        .map((row) => [row.root_path, row.missing === 1]),
    );
    for (const root of readProjects(relayHome)) {
      const missing = known.get(root);
      if (missing === false || (missing === true && !existsSync(join(root, ".relay", "state.json")))) continue;
      await this.reindex(root, "project_indexed");
    }

    const cursors = db
      .query<Cursor, []>("SELECT c.*, j.project_root FROM event_cursors c JOIN jobs j ON j.id = c.job_id")
      .all();
    for (const cursor of cursors) {
      this.watchFile(cursor.path);
      let stats;
      try {
        stats = statSync(cursor.path);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") this.markMissing(cursor);
        continue;
      }
      if (stats.ino !== cursor.inode || stats.dev !== cursor.device || stats.size < cursor.offset) {
        await this.reindex(cursor.project_root, "job_rebuilt");
      } else if (stats.size > cursor.offset) {
        await this.readNew(cursor);
      }
    }
    this.findGoneWorkers();
  }

  private async readNew(cursor: Cursor): Promise<void> {
    const { db, stream, log } = this.opts;
    const read = readEventsFrom(cursor.path, cursor.offset);
    for (const position of read.invalid) log.warn("invalid_event_line", { job: cursor.job_id, position });
    if (read.offset === cursor.offset) return;
    let reload = false;
    db.transaction(() => {
      for (const event of read.events) {
        const applied = applyEvent(db, cursor.job_id, event);
        reload ||= applied.reloadCheckpoint;
        for (const change of applied.changes) stream.record(change);
      }
      refreshFromState(db, cursor.job_id, cursor.project_root, stream);
      db.prepare("UPDATE event_cursors SET offset = ?, last_event_id = MAX(last_event_id, ?) WHERE job_id = ?").run(
        read.offset,
        read.events.at(-1)?.id ?? 0,
        cursor.job_id,
      );
    })();
    stream.publish();
    if (reload) {
      const checkpoint = await newestCheckpoint(cursor.project_root, cursor.job_id);
      db.transaction(() => {
        setCheckpoint(db, cursor.job_id, checkpoint);
        stream.record({ jobId: cursor.job_id, type: "job", data: getJob(db, cursor.job_id) });
      })();
      stream.publish();
    }
  }

  // The project folder or its events file is gone: the job stays in the index, shown with
  // project_missing true, until the files are back.
  private markMissing(cursor: Cursor): void {
    const { db, stream, log } = this.opts;
    let marked = false;
    db.transaction(() => {
      marked = db.prepare("UPDATE projects SET missing = 1 WHERE root_path = ? AND missing = 0").run(cursor.project_root).changes > 0;
      if (marked) stream.record({ jobId: cursor.job_id, type: "job", data: getJob(db, cursor.job_id) });
    })();
    if (!marked) return;
    log.warn("project_missing", { root: cursor.project_root });
    stream.publish();
  }

  // Rebuilds one project's rows from its files and tells clients about the job and its current
  // worker.
  private async reindex(root: string, message: string): Promise<void> {
    const { db, relayHome, stream, log } = this.opts;
    if (!(await indexProject(db, relayHome, root))) return;
    log.info(message, { root });
    const job = db.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE project_root = ?").get(root);
    if (job === null) return;
    db.transaction(() => stream.record({ jobId: job.id, type: "job", data: getJob(db, job.id) }))();
    stream.publish();
  }

  // A worker whose process is gone and whose end was never recorded is reported once, as a worker
  // event with state stopped (the Mac app proposal, design decision 17, requirement D).
  private findGoneWorkers(): void {
    const { db, stream } = this.opts;
    const open = db
      .query<{ id: string; job_id: string; pid: number }, []>(
        "SELECT id, job_id, pid FROM workers WHERE ended_at IS NULL AND found_gone_at IS NULL AND pid IS NOT NULL",
      )
      .all();
    const gone = open.filter((worker) => !processExists(worker.pid));
    if (gone.length === 0) return;
    db.transaction(() => {
      for (const worker of gone) {
        db.prepare("UPDATE workers SET found_gone_at = ? WHERE id = ?").run(new Date().toISOString(), worker.id);
        stream.record({ jobId: worker.job_id, type: "worker", data: getWorker(db, worker.id) });
      }
    })();
    stream.publish();
  }

  private watchFile(path: string): void {
    if (this.watchers.has(path)) return;
    try {
      const watcher = watch(path, () => void this.check());
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(path);
      });
      this.watchers.set(path, watcher);
    } catch {
      // The 2-second check still covers this file.
    }
  }
}

// state.json may change with the events (a rollback rewrites it): the job's title and state are
// read again, and a change is sent as a job event.
function refreshFromState(db: Database, jobId: string, root: string, stream: EventStream): void {
  let state;
  try {
    state = readState(join(root, ".relay"));
  } catch {
    return;
  }
  if (state.job_id !== jobId) return;
  const result = db
    .prepare("UPDATE jobs SET title = ?, state = ? WHERE id = ? AND (title <> ? OR state <> ?)")
    .run(state.title, state.status, jobId, state.title, state.status);
  if (result.changes > 0) stream.record({ jobId, type: "job", data: getJob(db, jobId) } satisfies StreamChange);
}
