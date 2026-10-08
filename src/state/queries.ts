// Reading the index in the shapes of the local API (design.md decision 14). Every field is always
// present; unknown values are null. A worker's state is computed when it is read.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { reportedAvailability, type Availability, type AvailabilityStatus } from "./availability";

export const PROVIDER_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export interface UsageItem {
  window: string;
  window_minutes: number | null;
  used_percent: number | null;
  resets_at: string | null;
  measured_at: string | null;
}

export interface AccountView {
  target: string;
  provider: string;
  provider_name: string;
  account: string;
  configured: boolean;
  availability: Availability;
  usage: UsageItem[];
}

export type WorkerState = "starting" | "running" | "stopped" | "ended";

export interface WorkerView {
  id: string;
  job_id: string;
  target: string;
  mode: string;
  state: WorkerState;
  pid: number | null;
  provider_session_id: string | null;
  from_handoff: boolean;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  end_reason: string | null;
}

export interface CheckpointView {
  number: number;
  commit: string;
  ref: string;
  kind: string;
  created_at: string;
  message: string | null;
}

export interface JobView {
  id: string;
  title: string;
  state: string;
  project_root: string;
  project_missing: boolean;
  current_worker: WorkerView | null;
  last_checkpoint: CheckpointView | null;
  updated_at: string;
}

interface AccountRow {
  id: string;
  provider: string;
  account: string;
  configured: number;
  status: AvailabilityStatus | null;
  reason: string | null;
  retry_at: string | null;
  measured_at: string | null;
  source: string | null;
  usage_json: string | null;
}

interface WorkerRow {
  id: string;
  job_id: string;
  target_id: string;
  mode: string;
  pid: number | null;
  provider_session_id: string | null;
  from_handoff: number;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  end_reason: string | null;
  found_gone_at: string | null;
}

interface JobRow {
  id: string;
  project_root: string;
  missing: number;
  title: string;
  state: string;
  current_worker_id: string | null;
  last_checkpoint_number: number | null;
  last_checkpoint_commit: string | null;
  last_checkpoint_at: string | null;
  last_checkpoint_kind: string | null;
  last_checkpoint_message: string | null;
  updated_at: string;
}

const ACCOUNT_SELECT = `SELECT t.id, t.provider, t.account, t.configured, a.status, a.reason, a.retry_at, a.measured_at,
  a.source, a.usage_json FROM targets t LEFT JOIN availability a ON a.target_id = t.id`;
const JOB_SELECT = `SELECT j.*, p.missing FROM jobs j JOIN projects p ON p.root_path = j.project_root`;

// The newest stream_events seq given out (in a new database, the number the stream starts after),
// so an answer can say which point of the event stream it shows (the Relay-Stream-Seq header).
export function streamSeq(db: Database): number {
  return db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'stream_events'").get()?.seq ?? 0;
}

export function listAccounts(db: Database, now = new Date()): AccountView[] {
  return db.query<AccountRow, []>(`${ACCOUNT_SELECT} ORDER BY t.id`).all().map((row) => accountView(row, now));
}

export function getAccount(db: Database, target: string, now = new Date()): AccountView | null {
  const row = db.query<AccountRow, [string]>(`${ACCOUNT_SELECT} WHERE t.id = ?`).get(target);
  return row === null ? null : accountView(row, now);
}

export function listJobs(db: Database): JobView[] {
  return db.query<JobRow, []>(`${JOB_SELECT} ORDER BY j.updated_at DESC, j.id`).all().map((row) => jobView(db, row));
}

export function getJob(db: Database, id: string): JobView | null {
  const row = db.query<JobRow, [string]>(`${JOB_SELECT} WHERE j.id = ?`).get(id);
  return row === null ? null : jobView(db, row);
}

export function listWorkers(db: Database, jobId: string): WorkerView[] {
  return db
    .query<WorkerRow, [string]>("SELECT * FROM workers WHERE job_id = ? ORDER BY started_at DESC, id DESC")
    .all(jobId)
    .map(workerView);
}

export function getWorker(db: Database, id: string): WorkerView | null {
  const row = db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id);
  return row === null ? null : workerView(row);
}

function accountView(row: AccountRow, now: Date): AccountView {
  const stored: Availability = {
    status: row.status ?? "unknown",
    reason: row.reason,
    retry_at: row.retry_at,
    measured_at: row.measured_at,
    source: row.source,
  };
  return {
    target: row.id,
    provider: row.provider,
    provider_name: PROVIDER_NAMES[row.provider] ?? row.provider,
    account: row.account,
    configured: row.configured === 1,
    availability: reportedAvailability(stored, now),
    usage: parseUsage(row.usage_json),
  };
}

function parseUsage(text: string | null): UsageItem[] {
  if (text === null) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? (value as UsageItem[]) : [];
  } catch {
    return [];
  }
}

function jobView(db: Database, row: JobRow): JobView {
  const current = row.current_worker_id === null ? null : getWorker(db, row.current_worker_id);
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    project_root: row.project_root,
    project_missing: row.missing === 1,
    current_worker: current,
    last_checkpoint:
      row.last_checkpoint_number === null || row.last_checkpoint_commit === null
        ? null
        : {
            number: row.last_checkpoint_number,
            commit: row.last_checkpoint_commit,
            ref: `refs/relay/jobs/${row.id}/checkpoints/${row.last_checkpoint_number}`,
            kind: row.last_checkpoint_kind ?? "manual",
            created_at: row.last_checkpoint_at ?? row.updated_at,
            message: row.last_checkpoint_message,
          },
    updated_at: row.updated_at,
  };
}

// ended when an end was recorded; otherwise running while the process exists, stopped when it is
// gone, and starting before relay knows its process ID.
function workerView(row: WorkerRow): WorkerView {
  let state: WorkerState;
  if (row.ended_at !== null) state = "ended";
  else if (row.pid === null) state = "starting";
  else state = row.found_gone_at === null && processExists(row.pid) ? "running" : "stopped";
  return {
    id: row.id,
    job_id: row.job_id,
    target: row.target_id,
    mode: row.mode,
    state,
    pid: row.pid,
    provider_session_id: row.provider_session_id,
    from_handoff: row.from_handoff === 1,
    started_at: row.started_at,
    ended_at: row.ended_at,
    exit_code: row.exit_code,
    end_reason: row.end_reason,
  };
}

// Whether the process still runs. A process that has exited but that its parent has not reaped yet
// (a zombie) still answers process.kill(pid, 0); on Linux /proc says so, and it counts as gone.
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
  return !isZombie(pid);
}

function isZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    // The state follows the command name, which is in parentheses and may itself hold ") ".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return false;
  }
}
