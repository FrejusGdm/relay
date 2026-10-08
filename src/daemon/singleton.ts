// One daemon per relay folder (design.md decision 5): the daemon holds an flock on
// run/daemon.lock for its whole life and writes run/daemon.pid only while it holds the lock.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lock, LockTimeout, tryLock, type LockHandle } from "../platform/file-lock";

export interface PidFile {
  pid: number;
  started_at: string;
  version: string;
  socket: string;
}

const PID_FILE_MAX_BYTES = 4096;
const LOCK_WAIT_MS = 200;

export function lockPath(runDir: string): string {
  return join(runDir, "daemon.lock");
}

export function pidPath(runDir: string): string {
  return join(runDir, "daemon.pid");
}

// The daemon lock, or null when a daemon holds it. It waits up to 200 ms, because on macOS
// `relay daemon status` and `stop` take the lock for an instant to see whether it is free
// (daemonLockHolder), and a daemon starting at that instant must not exit as "already running".
export async function takeDaemonLock(runDir: string): Promise<LockHandle | null> {
  try {
    return await lock(lockPath(runDir), LOCK_WAIT_MS);
  } catch (error) {
    if (error instanceof LockTimeout) return null;
    throw error;
  }
}

// Whether a process holds daemon.lock: null when none does, otherwise the holder's pid, or a pid of
// null when relay cannot name it. On Linux the lock is never taken: /proc/locks lists each flock
// with the pid that took it and the file's inode, and the holder must also have the file open,
// which rules out a file with the same inode on another file system. Elsewhere, and when
// /proc/locks cannot be read, relay takes the lock for an instant and releases it.
export function daemonLockHolder(runDir: string, platform: string = process.platform): { pid: number | null } | null {
  const path = lockPath(runDir);
  const file = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (file === undefined) return null;
  if (platform === "linux") {
    const pids = flockHolders(file.ino);
    if (pids !== null) {
      const pid = pids.find((candidate) => hasOpen(candidate, file.dev, file.ino));
      return pid === undefined ? null : { pid };
    }
  }
  const handle = tryLock(path);
  if (handle === null) return { pid: null };
  handle.release();
  return null;
}

// The pids of the processes that hold an exclusive flock on a file with this inode, from lines
// such as "1: FLOCK  ADVISORY  WRITE 4121 00:2a:5678 0 EOF". Lines with "->" are processes waiting
// for a lock. Returns null when /proc/locks cannot be read.
function flockHolders(ino: bigint): number[] | null {
  let text: string;
  try {
    text = readFileSync("/proc/locks", "utf8");
  } catch {
    return null;
  }
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const [, type, , access, pid, file] = line.trim().split(/\s+/);
    if (type !== "FLOCK" || access !== "WRITE" || file?.split(":")[2] !== String(ino)) continue;
    if (/^[1-9]\d*$/.test(pid!)) pids.push(Number(pid));
  }
  return pids;
}

// True when the process has an open file descriptor on the file with this device and inode.
function hasOpen(pid: number, dev: bigint, ino: bigint): boolean {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  return fds.some((fd) => {
    try {
      const target = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
      return target.dev === dev && target.ino === ino;
    } catch {
      return false;
    }
  });
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
