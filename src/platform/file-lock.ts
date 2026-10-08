// Advisory file locks with flock(2) (design.md decision 4). The kernel releases a lock when the
// process that holds it dies, so a crash never leaves a stale lock behind. Bun opens files with
// close-on-exec, so a child process never inherits a lock.
import { closeSync, constants, openSync } from "node:fs";
import { flock } from "./libc";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const RETRY_MS = 10;

export interface LockHandle {
  release(): void;
}

export class LockTimeout extends Error {
  constructor(readonly path: string, readonly timeoutMs: number) {
    super(`relay could not lock ${path} within ${timeoutMs} ms.`);
    this.name = "LockTimeout";
  }
}

// Opens (or creates, with mode 0600) the lock file and takes an exclusive lock without waiting.
// Returns null when another open file holds the lock. flock gives no error code through bun:ffi,
// so any refusal counts as "held"; the file was opened just before, so other failures are not
// expected. A symbolic link at the path is refused by the open call.
export function tryLock(path: string): LockHandle | null {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let locked = false;
  try {
    locked = flock(fd, LOCK_EX | LOCK_NB) === 0;
  } finally {
    if (!locked) closeSync(fd);
  }
  if (!locked) return null;
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

// Tries every 10 ms until the lock is free, and throws LockTimeout after timeoutMs.
export async function lock(path: string, timeoutMs: number): Promise<LockHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = tryLock(path);
    if (handle !== null) return handle;
    if (Date.now() >= deadline) throw new LockTimeout(path, timeoutMs);
    await Bun.sleep(RETRY_MS);
  }
}
