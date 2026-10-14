// RELAY_HOME/jobs/<job>/resume-at-reset.json, a job's wait for its usage limit to reset
// (add-resume-at-reset, design decision 1). relay run arms it, the daemon resumes from it and
// relay resume-at-reset off cancels it; each change is a read, a change and a write while the
// process holds locks/<job>.resume.lock, so a cancel and a resume cannot both win. The file is
// deleted when the wait ends; the job's event log keeps the history.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FailureReason, PermissionLevel, ReadingSource } from "../adapters/types";
import { readPrivateFile } from "../core/relay-home";
import { jobFolder, makePrivateFolder, writePrivateFile } from "../handoff/files";
import { appendEvent, type JobRef } from "../job/events";
import { isJobId } from "../job/id";
import { lock } from "../platform/file-lock";
import { now } from "../platform/clock";

export type WaitState = "watching" | "waiting" | "resuming";

export interface WaitStop {
  worker_id: string;
  at: string;
  reason: FailureReason;
  reset_at: string | null;
  source: ReadingSource | null;
}

export interface WaitRecord {
  schema_version: 1;
  job_id: string;
  root: string;
  account: string;
  provider: "claude" | "codex";
  session_id: string | null;
  permission: PermissionLevel;
  model: string | null;
  max_resumes: number;
  state: WaitState;
  stop: WaitStop | null;
  next_check_at: string | null;
  resumes: number;
  resumes_in_a_row: number;
  // Whether the running resume was made after a known reset time, so a new stop counts.
  counted: boolean;
  waiting_since: string | null;
  // The worker the daemon resumed, while it runs.
  worker_id: string | null;
  // The relay run that holds the job while its first agent runs (state watching).
  owner_pid: number | null;
  updated_at: string;
}

export type WaitOutcome = "finished" | "gave_up" | "stopped" | "cancelled";

const MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 10_000;

export function waitPath(relayHome: string, jobId: string): string {
  return join(jobFolder(relayHome, jobId), "resume-at-reset.json");
}

// The job's wait, or null when there is none or the file cannot be read as one. A damaged file
// counts as no wait: relay never resumes from data it cannot trust.
export function readWait(relayHome: string, jobId: string): WaitRecord | null {
  let text: string | null;
  try {
    text = readPrivateFile(waitPath(relayHome, jobId), process.getuid!(), MAX_BYTES);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isWait(value, jobId) ? value : null;
  } catch {
    return null;
  }
}

export function writeWait(relayHome: string, wait: WaitRecord): void {
  writePrivateFile(waitPath(relayHome, wait.job_id), `${JSON.stringify({ ...wait, updated_at: now().toISOString() }, null, 2)}\n`);
}

export function removeWait(relayHome: string, jobId: string): void {
  rmSync(waitPath(relayHome, jobId), { force: true });
}

// Runs `action` while this process holds the job's resume lock.
export async function withWaitLock<T>(relayHome: string, jobId: string, action: () => Promise<T> | T): Promise<T> {
  if (!isJobId(jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(jobId)} in a path.`);
  const folder = join(relayHome, "locks");
  makePrivateFolder(folder);
  const handle = await lock(join(folder, `${jobId}.resume.lock`), LOCK_WAIT_MS);
  try {
    return await action();
  } finally {
    handle.release();
  }
}

// Every job's wait, for the daemon and relay status.
export function listWaits(relayHome: string): WaitRecord[] {
  let names: string[];
  try {
    names = readdirSync(join(relayHome, "jobs"));
  } catch {
    return [];
  }
  return names.filter(isJobId).flatMap((id) => {
    const wait = readWait(relayHome, id);
    return wait === null ? [] : [wait];
  });
}

export function jobRefOf(relayHome: string, wait: WaitRecord): JobRef {
  return { id: wait.job_id, worktreeRoot: wait.root, relayHome };
}

// Ends a wait: the resume_at_reset_ended event first, then the file, so a relay run that follows
// the job sees why it ended before it sees the file go. A job folder that is gone has no event log;
// the wait ends anyway.
export async function endWait(
  relayHome: string, wait: WaitRecord, outcome: WaitOutcome, reason: string, exitCode: number,
): Promise<void> {
  try {
    await appendEvent(jobRefOf(relayHome, wait), "resume_at_reset_ended", {
      outcome, reason, exit_code: exitCode, resumes: wait.resumes, resumes_in_a_row: wait.resumes_in_a_row, target: wait.account,
    });
  } finally {
    removeWait(relayHome, wait.job_id);
  }
}

function isWait(value: unknown, jobId: string): value is WaitRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  const time = (field: unknown) => field === null || (typeof field === "string" && !Number.isNaN(Date.parse(field)));
  const count = (field: unknown) => Number.isSafeInteger(field) && (field as number) >= 0;
  const stop = wait.stop as Record<string, unknown> | null;
  return wait.schema_version === 1 && wait.job_id === jobId && typeof wait.root === "string" && wait.root.startsWith("/")
    && typeof wait.account === "string" && (wait.provider === "claude" || wait.provider === "codex")
    && (wait.session_id === null || typeof wait.session_id === "string")
    && (wait.permission === "read-only" || wait.permission === "edit-in-workspace")
    && (wait.model === null || typeof wait.model === "string")
    && Number.isSafeInteger(wait.max_resumes) && (wait.max_resumes as number) >= 1
    && (wait.state === "watching" || wait.state === "waiting" || wait.state === "resuming")
    && (stop === null || (typeof stop === "object" && typeof stop.worker_id === "string" && time(stop.at) && typeof stop.reason === "string"
      && time(stop.reset_at) && (stop.source === null || typeof stop.source === "string")))
    && time(wait.next_check_at) && count(wait.resumes) && count(wait.resumes_in_a_row) && typeof wait.counted === "boolean"
    && time(wait.waiting_since) && (wait.worker_id === null || typeof wait.worker_id === "string")
    && (wait.owner_pid === null || (Number.isSafeInteger(wait.owner_pid) && (wait.owner_pid as number) > 0));
}
