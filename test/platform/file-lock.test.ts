// Task 1.2: flock locks are exclusive across processes, die with their holder, and time out.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { lock, LockTimeout, tryLock } from "../../src/platform/file-lock";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

const CHILD = join(import.meta.dir, "lock-child.ts");

// Starts lock-child.ts and returns it with a function that reads its next output line.
function startChild(path: string, ...extra: string[]) {
  const child = Bun.spawn([process.execPath, CHILD, path, ...extra], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let buffered = "";
  const nextLine = async (): Promise<string> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`lock-child ended early; output so far: ${JSON.stringify(buffered)}`);
      buffered += new TextDecoder().decode(value);
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    return line;
  };
  return { child, nextLine };
}

test("a second process cannot take the lock while this one holds it", async () => {
  const path = join(tempRelayHome(), "test.lock");
  const handle = tryLock(path)!;
  expect(handle).not.toBeNull();
  try {
    const { child, nextLine } = startChild(path);
    expect(await nextLine()).toBe("busy");
    expect(await child.exited).toBe(0);
  } finally {
    handle.release();
  }
});

test("the lock is free again once its holder is killed with SIGKILL", async () => {
  const path = join(tempRelayHome(), "test.lock");
  const { child, nextLine } = startChild(path);
  expect(await nextLine()).toBe("locked");
  expect(tryLock(path)).toBeNull();
  child.kill("SIGKILL");
  await child.exited;
  const handle = tryLock(path);
  expect(handle).not.toBeNull();
  handle!.release();
});

test("a child process started by the holder does not keep the lock", async () => {
  const path = join(tempRelayHome(), "test.lock");
  const { child, nextLine } = startChild(path, "spawn");
  const sleeper = Number((await nextLine()).replace("child ", ""));
  try {
    expect(await nextLine()).toBe("locked");
    child.kill("SIGKILL");
    await child.exited;
    const handle = tryLock(path);
    expect(handle).not.toBeNull();
    handle!.release();
  } finally {
    process.kill(sleeper, "SIGKILL");
  }
});

test("lock waits for the lock and throws LockTimeout after the timeout", async () => {
  const path = join(tempRelayHome(), "test.lock");
  const held = tryLock(path)!;
  const started = Date.now();
  const error = await lock(path, 150).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LockTimeout);
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);

  const waiting = lock(path, 2000);
  setTimeout(() => held.release(), 50);
  const handle = await waiting;
  expect(tryLock(path)).toBeNull();
  handle.release();
  handle.release();
  const again = tryLock(path);
  expect(again).not.toBeNull();
  again!.release();
});
