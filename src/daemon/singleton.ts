// One daemon per relay folder (design.md decision 5): the daemon holds an flock on
// run/daemon.lock for its whole life and writes run/daemon.pid only while it holds the lock.
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock, type LockHandle } from "../platform/file-lock";

export interface PidFile {
  pid: number;
  started_at: string;
  version: string;
  socket: string;
}

const PID_FILE_MAX_BYTES = 4096;

export function lockPath(runDir: string): string {
  return join(runDir, "daemon.lock");
}

export function pidPath(runDir: string): string {
  return join(runDir, "daemon.pid");
}

// The daemon lock, or null when a daemon holds it.
export function takeDaemonLock(runDir: string): LockHandle | null {
  return tryLock(lockPath(runDir));
}

// Writes daemon.pid.tmp and renames it, so a reader never sees half a file.
export function writePidFile(runDir: string, info: PidFile): void {
  const temporary = `${pidPath(runDir)}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, pidPath(runDir));
}

// Removes daemon.pid when it names this process, so a daemon never removes another one's file.
export function removeOwnPidFile(runDir: string): void {
  if (readPidFile(runDir)?.pid === process.pid) rmSync(pidPath(runDir), { force: true });
}

// The pid file's contents, or null when it is missing, not a regular file, too large or not the
// expected JSON. A symbolic link is not followed.
export function readPidFile(runDir: string): PidFile | null {
  let fd: number;
  try {
    fd = openSync(pidPath(runDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > PID_FILE_MAX_BYTES) return null;
    const buffer = Buffer.alloc(PID_FILE_MAX_BYTES);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.toString("utf8", 0, length)) as Partial<PidFile> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid! <= 0 ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.socket !== "string"
    ) {
      return null;
    }
    return { pid: parsed.pid!, started_at: parsed.started_at, version: parsed.version, socket: parsed.socket };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
