// Turns one event from a job's events.jsonl into index rows (design.md decision 9, the table of
// event types). This is the only place that knows the fields of the earlier phases' events. The
// returned changes are what the event stream sends; the rebuild ignores them.
import type { Database } from "bun:sqlite";
import type { RelayEvent } from "../job/events";
import { isAvailabilityStatus } from "./availability";
import { getAccount, getJob, getWorker, type CheckpointView } from "./queries";

export interface StreamChange {
  jobId: string | null;
  type: string;
  data: unknown;
}

export interface Applied {
  changes: StreamChange[];
  // A rollback happened: the caller reads the newest checkpoint from git again.
  reloadCheckpoint: boolean;
}

const WORKER_MODES = new Set(["headless", "interactive", "external"]);
const TARGET = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9_-]*)$/;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const integer = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);

export function applyEvent(db: Database, jobId: string, event: RelayEvent): Applied {
  const data = event.data ?? {};
  const changes: StreamChange[] = [];
  const touchJob = () => {
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND updated_at < ?").run(event.ts, jobId, event.ts);
    changes.push({ jobId, type: "job", data: getJob(db, jobId) });
  };
  const touchWorker = (id: string) => changes.push({ jobId, type: "worker", data: getWorker(db, id) });

  switch (event.type) {
    case "job_started": {
      const title = text(data.title);
      if (title !== null) db.prepare("UPDATE jobs SET title = ? WHERE id = ?").run(title, jobId);
      touchJob();
      break;
    }
    case "checkpoint_saved": {
      const number = integer(data.number);
      const commit = text(data.commit);
      if (number === null || commit === null) break;
      db.prepare(
        `UPDATE jobs SET last_checkpoint_number = ?, last_checkpoint_commit = ?, last_checkpoint_at = ?,
           last_checkpoint_kind = ?, last_checkpoint_message = ?
         WHERE id = ? AND (last_checkpoint_number IS NULL OR last_checkpoint_number <= ?)`,
      ).run(number, commit, event.ts, text(data.kind) ?? "manual", text(data.message), jobId, number);
      const checkpoint: CheckpointView = {
        number,
        commit,
        ref: `refs/relay/jobs/${jobId}/checkpoints/${number}`,
        kind: text(data.kind) ?? "manual",
        created_at: event.ts,
        message: text(data.message),
      };
      changes.push({ jobId, type: "checkpoint", data: { job_id: jobId, checkpoint } });
      touchJob();
      break;
    }
    case "rollback":
      touchJob();
      return { changes, reloadCheckpoint: true };
    case "worker_started": {
      const id = text(data.worker_id);
      const target = text(data.target);
      if (id === null || target === null) break;
      const mode = text(data.mode);
      db.prepare(
        `INSERT OR REPLACE INTO workers (id, job_id, target_id, mode, pid, provider_session_id, from_handoff, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        jobId,
        target,
        mode !== null && WORKER_MODES.has(mode) ? mode : "external",
        integer(data.pid),
        text(data.provider_session_id),
        data.from_handoff === null || data.from_handoff === undefined || data.from_handoff === false ? 0 : 1,
        event.ts,
      );
      db.prepare("UPDATE jobs SET current_worker_id = ? WHERE id = ?").run(id, jobId);
      touchWorker(id);
      touchJob();
      break;
    }
    case "worker_session_identified": {
      const id = text(data.worker_id);
      const session = text(data.provider_session_id);
      if (id === null || session === null) break;
      if (db.prepare("UPDATE workers SET provider_session_id = ? WHERE id = ?").run(session, id).changes > 0) touchWorker(id);
      break;
    }
    case "worker_ended": {
      const id = text(data.worker_id);
      if (id === null) break;
      const updated = db
        .prepare("UPDATE workers SET ended_at = ?, exit_code = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
        .run(event.ts, integer(data.exit_code), text(data.end_reason), id);
      if (updated.changes === 0) break;
      db.prepare("UPDATE jobs SET current_worker_id = NULL WHERE id = ? AND current_worker_id = ?").run(jobId, id);
      touchWorker(id);
      touchJob();
      break;
    }
    case "availability": {
      const target = text(data.target);
      if (target === null || !applyAvailability(db, target, data)) break;
      changes.push({ jobId: null, type: "availability", data: getAccount(db, target) });
      break;
    }
    case "hook":
      changes.push({ jobId, type: "hook", data: { job_id: jobId, provider: text(data.provider), event: text(data.event) } });
      break;
    default:
      // Unknown types are passed to the stream as they are and otherwise ignored.
      changes.push({ jobId, type: event.type, data });
  }
  return { changes, reloadCheckpoint: false };
}

// Records an availability reading when it is at least as new as the stored one (a missing time is
// the oldest). Returns false when the reading was older or not valid.
export function applyAvailability(db: Database, target: string, data: Record<string, unknown>): boolean {
  const match = TARGET.exec(target);
  const status = data.status;
  if (match === null || !isAvailabilityStatus(status)) return false;
  db.prepare("INSERT OR IGNORE INTO targets (id, provider, account, profile_dir, configured) VALUES (?, ?, ?, NULL, 0)").run(
    target,
    match[1]!,
    match[2]!,
  );
  const measuredAt = text(data.measured_at);
  const stored = db.query<{ measured_at: string | null }, [string]>("SELECT measured_at FROM availability WHERE target_id = ?").get(target);
  if (stored !== null && stored.measured_at !== null && (measuredAt === null || measuredAt < stored.measured_at)) return false;
  const windows = Array.isArray(data.windows) ? (data.windows as Record<string, unknown>[]) : [];
  const usage = windows
    .filter((window) => typeof window === "object" && window !== null && typeof window.name === "string")
    .map((window) => ({
      window: window.name as string,
      window_minutes: typeof window.window_minutes === "number" ? window.window_minutes : null,
      used_percent: typeof window.used_percent === "number" ? window.used_percent : null,
      resets_at: text(window.resets_at),
      measured_at: measuredAt,
    }))
    .sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity));
  db.prepare(
    `INSERT OR REPLACE INTO availability (target_id, status, reason, retry_at, measured_at, source, usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(target, status, text(data.reason), text(data.retry_at), measuredAt, text(data.source), JSON.stringify(usage));
  return true;
}
