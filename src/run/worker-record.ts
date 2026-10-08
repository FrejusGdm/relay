// Worker records, RELAY_HOME/jobs/<job>/workers/<worker>.json (the agent-runs spec, "Worker
// records"): one file per run, mode 0600, replaced through a temporary file and a rename as facts
// become known.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../accounts/files";
import type { FailureReason, Mode, PermissionLevel, ProviderId, Transport } from "../adapters/types";
import { isJobId } from "../job/id";

// add-relay-switch adds stopped_by_switch and start_failed to phase 3's reasons.
export type EndReason = "exited" | "interrupted" | "relay_stopped" | "stopped_by_switch" | "start_failed";

export interface WorkerRecord {
  worker_id: string;
  job_id: string;
  account: string;
  provider: ProviderId;
  mode: Mode;
  transport: Transport;
  provider_version: string | null;
  provider_session_id: string | null;
  pid: number | null;
  cwd: string;
  permission: PermissionLevel | null;
  argv: string[];
  resumed_from: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  end_reason: EndReason | null;
  log_path: string | null;
  // Added by add-relay-switch. The reason of the worker's last failed turn, as the adapter reported
  // it to relay; the handoff number that started the worker; the checkpoint that was latest when
  // it started. Older records lack them.
  last_failure?: FailureReason | null;
  from_handoff?: number | null;
  start_checkpoint?: number | null;
}

// Worker IDs have the format of job IDs: 8 random lowercase hexadecimal characters.
export function newWorkerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workersFolder(relayHome: string, jobId: string): string {
  if (!isJobId(jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(jobId)} in a path.`);
  return join(relayHome, "jobs", jobId, "workers");
}

export function workerRecordPath(relayHome: string, jobId: string, workerId: string): string {
  if (!isJobId(workerId)) throw new Error(`relay refused to use the worker ID ${JSON.stringify(workerId)} in a path.`);
  return join(workersFolder(relayHome, jobId), `${workerId}.json`);
}

export function writeWorkerRecord(relayHome: string, record: WorkerRecord): void {
  writeJsonFile(workerRecordPath(relayHome, record.job_id, record.worker_id), record);
}

// The worker records of every job under RELAY_HOME/jobs/.
export function readAllWorkerRecords(relayHome: string): WorkerRecord[] {
  let jobs: string[];
  try {
    jobs = readdirSync(join(relayHome, "jobs"));
  } catch {
    return [];
  }
  return jobs.filter(isJobId).flatMap((jobId) => readWorkerRecords(relayHome, jobId));
}

// The job's worker records, newest first. Files that are not records relay wrote are skipped.
export function readWorkerRecords(relayHome: string, jobId: string): WorkerRecord[] {
  let names: string[];
  try {
    names = readdirSync(workersFolder(relayHome, jobId));
  } catch {
    return [];
  }
  const records: WorkerRecord[] = [];
  for (const name of names) {
    const match = /^([0-9a-f]{8})\.json$/.exec(name);
    if (match === null) continue;
    const value = readJsonFile(workerRecordPath(relayHome, jobId, match[1]!)) as Partial<WorkerRecord> | null;
    if (value === null || typeof value !== "object" || value.worker_id !== match[1] || typeof value.account !== "string"
      || typeof value.started_at !== "string" || Number.isNaN(Date.parse(value.started_at))) continue;
    records.push(value as WorkerRecord);
  }
  return records.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}
