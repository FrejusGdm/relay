// Lock files under $RELAY_HOME/locks/ (design.md decisions 10 and 12): the job lock, held by a
// command that writes, and the short events lock, held while one event is appended. A job lock
// file holds its owner as JSON. It is written to a temporary file first and then linked into
// place, which fails when the lock exists, so a reader never sees half an owner. The events lock
// is an flock lock instead (add-daemon-api-and-status, design decision 9): the kernel releases it
// when its holder dies, so a crash never leaves it held.
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { lock, LockTimeout } from "../platform/file-lock";
import { isJobId } from "./id";

interface Owner {
  pid: number;
  command: string;
  started_at: string;
  host: string;
}

const EVENTS_WAIT_MS = 2000;
const RECOVERY_STALE_MS = 10_000;

function lockPath(relayHome: string, jobId: string, suffix: "lock" | "events.lock"): string {
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
    const owner = readOwner(path);
    if (owner === "gone") continue;
    if (owner !== null && isStale(owner.parsed)) {
      recoverStale(path, owner.text);
      continue;
    }
    const holder = owner === null ? "another relay command" : `relay ${owner.parsed.command}, process ${owner.parsed.pid}`;
    throw new CommandError(ExitCode.Busy, [
      `Another relay command is working on this job (${holder}). Try again when it finishes.`,
    ]);
  }
  throw new CommandError(ExitCode.Busy, ["Another relay command is working on this job. Try again when it finishes."]);
}

// Runs `action` while holding the events lock, trying every 10 ms for up to 2 seconds.
export async function withEventsLock<T>(relayHome: string, jobId: string, action: () => T): Promise<T> {
  const path = lockPath(relayHome, jobId, "events.lock");
  let handle;
  try {
    handle = await lock(path, EVENTS_WAIT_MS);
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

// Creates the lock with this process as its owner, or returns null when it exists.
function tryLock(path: string, command: string): (() => void) | null {
  const owner: Owner = { pid: process.pid, command, started_at: new Date().toISOString(), host: hostname() };
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
    const current = readOwner(path);
    if (current !== null && current !== "gone" && current.text === text) unlinkSync(path);
  };
}

// The lock's owner; "gone" when the lock disappeared, null when its content cannot be read.
function readOwner(path: string): { text: string; parsed: Owner } | "gone" | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "gone";
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Owner;
    if (Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.host === "string" && typeof parsed.command === "string") {
      return { text, parsed };
    }
  } catch {
    // Not an owner relay wrote.
  }
  return null;
}

// A lock is stale when it was taken on this computer by a process that no longer exists.
function isStale(owner: Owner): boolean {
  if (owner.host !== hostname()) return false;
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
function recoverStale(path: string, staleText: string): void {
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
    const current = readOwner(path);
    if (current !== null && current !== "gone" && current.text === staleText && isStale(current.parsed)) unlinkSync(path);
  } finally {
    closeSync(fd);
    unlinkSync(recovery);
  }
}
