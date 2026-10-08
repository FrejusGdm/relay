// Lock files under $RELAY_HOME/locks/ (design.md decisions 10 and 12): the job lock, held by a
// Lock files under $RELAY_HOME/locks/ (design.md decisions 10 and 12): the job lock, held by a
// command that writes, the short events lock, held while one event is appended, the config lock,
// held while config.toml is changed (add-provider-adapters, design decision 10), and the worker
// lock, held while relay run supervises an agent (add-provider-adapters, design decision 15). A job,
// config or worker lock file holds its owner as JSON. It is written to a temporary file first and
// then linked into place, which fails when the lock exists, so a reader never sees half an owner.
// The events lock is an flock lock instead (add-daemon-api-and-status, design decision 9): the
// kernel releases it when its holder dies, so a crash never leaves it held.
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { printable } from "../core/quote";
import { lock, LockTimeout } from "../platform/file-lock";
import { isJobId } from "./id";

interface Owner {
  pid: number;
  command: string;
  started_at: string;
  host: string;
}

// The worker lock's owner. add-relay-switch adds fields; readers ignore the ones they do not know.
interface WorkerOwner {
  pid: number;
  account: string;
  started_at: string;
}

const RETRY_MS = 10;
const SHORT_WAIT_MS = 2000;
const RECOVERY_STALE_MS = 10_000;

function lockPath(relayHome: string, jobId: string, suffix: "lock" | "events.lock" | "worker.lock"): string {
  if (!isJobId(jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(jobId)} in a path.`);
  const dir = join(relayHome, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${jobId}.${suffix}`);
}

// Holds the job lock for `command` (for example "checkpoint") and returns the function that
// releases it. A lock left by a process that no longer runs on this computer is replaced.
export function takeJobLock(relayHome: string, jobId: string, command: string): () => void {
  const path = lockPath(relayHome, jobId, "lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    const release = tryLock(path, command);
    if (release !== null) return release;
    const owner = readOwner(path, isOwner);
    if (owner === "gone") continue;
    if (owner !== null && isStale(owner.parsed)) {
      recoverStale(path, owner.text, isOwner);
      continue;
    }
    const holder = owner === null ? "another relay command" : `relay ${owner.parsed.command}, process ${owner.parsed.pid}`;
    throw new CommandError(ExitCode.Busy, [
      `Another relay command is working on this job (${holder}). Try again when it finishes.`,
    ]);
  }
  throw new CommandError(ExitCode.Busy, ["Another relay command is working on this job. Try again when it finishes."]);
}

export function workerLockPath(relayHome: string, jobId: string): string {
  return lockPath(relayHome, jobId, "worker.lock");
}

// The worker lock as its holder sees it: releasing removes the file only while this process still
// owns it, and `update` replaces the owner's fields through a temporary file and a rename, for
// example with the next worker after a handoff (add-relay-switch, design decision 15).
export type WorkerLock = (() => void) & { update(fields: Record<string, unknown>): void };

// Holds the worker lock of the job for `account` and returns it. Only one agent works on a job at
// a time; a lock left by a process that no longer runs is replaced. `extra` holds the fields that
// add-relay-switch adds to the owner.
export function takeWorkerLock(relayHome: string, jobId: string, account: string, extra: Record<string, unknown> = {}): WorkerLock {
  const path = lockPath(relayHome, jobId, "worker.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner: Record<string, unknown> = { pid: process.pid, account, started_at: new Date().toISOString(), ...extra };
    if (createLock(path, owner) !== null) return workerLock(path, owner);
    const current = readOwner(path, isWorkerOwner);
    if (current === "gone") continue;
    if (current !== null && isStale(current.parsed)) {
      recoverStale(path, current.text, isWorkerOwner);
      continue;
    }
    const holder = current === null ? "" : ` (${printable(current.parsed.account)}, process ${current.parsed.pid})`;
    throw new CommandError(ExitCode.Busy, [`Another agent is already working on this job${holder}.`]);
  }
  throw new CommandError(ExitCode.Busy, ["Another agent is already working on this job."]);
}

function workerLock(path: string, owner: Record<string, unknown>): WorkerLock {
  const mine = () => {
    const current = readOwner(path, isWorkerOwner);
    return current !== null && current !== "gone" && current.parsed.pid === process.pid;
  };
  const release = () => {
    if (mine()) unlinkSync(path);
  };
  return Object.assign(release, {
    update(fields: Record<string, unknown>) {
      if (!mine()) return;
      Object.assign(owner, fields);
      const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(owner)}\n`);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    },
  });
}

// Runs `action` while holding the events lock, trying every 10 ms for up to 2 seconds.
export async function withEventsLock<T>(relayHome: string, jobId: string, action: () => T): Promise<T> {
  const path = lockPath(relayHome, jobId, "events.lock");
  let handle;
  try {
    handle = await lock(path, SHORT_WAIT_MS);
  } catch (error) {
    if (!(error instanceof LockTimeout)) throw error;
    throw new CommandError(ExitCode.Busy, [
      "Another relay process is writing to this job's event log. Try again when it finishes.",
    ]);
  }
  try {
    return action();
  } finally {
    handle.release();
  }
}

// Runs `action` while holding $RELAY_HOME/locks/config.lock, trying every 10 ms for up to 2
// seconds. The wait blocks, because the change to config.toml that it protects is synchronous.
export function withConfigLock<T>(relayHome: string, action: () => T): T {
  const dir = join(relayHome, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.lock");
  const deadline = Date.now() + SHORT_WAIT_MS;
  for (;;) {
    const release = tryLock(path, "edit-config");
    if (release !== null) {
      try {
        return action();
      } finally {
        release();
      }
    }
    const owner = readOwner(path, isOwner);
    if (owner !== null && owner !== "gone" && isStale(owner.parsed)) recoverStale(path, owner.text, isOwner);
    if (Date.now() >= deadline) {
      throw new CommandError(ExitCode.Busy, ["Another relay command is changing config.toml. Try again when it finishes."]);
    }
    Bun.sleepSync(RETRY_MS);
  }
}

// Creates the lock with this process as its owner, or returns null when it exists.
function tryLock(path: string, command: string): (() => void) | null {
  return createLock(path, { pid: process.pid, command, started_at: new Date().toISOString(), host: hostname() } satisfies Owner);
}

function createLock(path: string, owner: object): (() => void) | null {
  const text = `${JSON.stringify(owner)}\n`;
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return null;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
  // Releasing removes the lock only while it still holds this owner.
  return () => {
    const current = readOwner(path, () => true);
    if (current !== null && current !== "gone" && current.text === text) unlinkSync(path);
  };
}

function isOwner(value: Owner): boolean {
  return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === "string" && typeof value.command === "string";
}

function isWorkerOwner(value: WorkerOwner): boolean {
  return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.account === "string";
}

// The lock's owner; "gone" when the lock disappeared, null when its content cannot be read.
function readOwner<T extends { pid: number }>(path: string, valid: (value: T) => boolean): { text: string; parsed: T } | "gone" | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "gone";
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as T;
    if (typeof parsed === "object" && parsed !== null && valid(parsed)) return { text, parsed };
  } catch {
    // Not an owner relay wrote.
  }
  return null;
}

// A lock is stale when it was taken on this computer by a process that no longer exists. The worker
// lock names no computer; it lives in the relay folder of this computer.
function isStale(owner: { pid: number; host?: string }): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
}

// Removes a stale lock. Only one process recovers a lock at a time: it holds `<lock>.recover`,
// created with the exclusive-create flag, and removes the lock only if it still holds the stale
// owner it read, whose process is gone. A live owner's lock is never removed. When another process
// is recovering, this one does nothing and tries the lock again. A recovery lock older than
// 10 seconds was left by a process that stopped while recovering, and is removed.
function recoverStale<T extends { pid: number; host?: string }>(
  path: string,
  staleText: string,
  valid: (value: T) => boolean,
): void {
  const recovery = `${path}.recover`;
  let fd: number;
  try {
    fd = openSync(recovery, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    const age = Date.now() - (statSync(recovery, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > RECOVERY_STALE_MS) rmSync(recovery, { force: true });
    return;
  }
  try {
    const current = readOwner(path, valid);
    if (current !== null && current !== "gone" && current.text === staleText && isStale(current.parsed)) unlinkSync(path);
  } finally {
    closeSync(fd);
    unlinkSync(recovery);
  }
}
