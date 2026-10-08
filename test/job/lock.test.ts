import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { takeJobLock, withEventsLock } from "../../src/job/lock";

let relayHome: string;
let lockFile: string;

beforeEach(() => {
  relayHome = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  lockFile = join(relayHome, "locks", "3f9a2c1d.lock");
});
afterEach(() => rmSync(relayHome, { recursive: true, force: true }));

function plantLock(file: string, pid: number, command = "checkpoint"): void {
  mkdirSync(join(relayHome, "locks"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid, command, started_at: "2026-10-07T20:31:05.123Z", host: hostname() })}\n`);
}

// The ID of a process that has ended.
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

function caught(action: () => unknown): CommandError {
  try {
    action();
  } catch (error) {
    return error as CommandError;
  }
  throw new Error("nothing was thrown");
}

test("the job lock holds its owner and is removed on release", () => {
  const release = takeJobLock(relayHome, "3f9a2c1d", "checkpoint");
  const owner = JSON.parse(readFileSync(lockFile, "utf8"));
  expect(owner).toEqual({ pid: process.pid, command: "checkpoint", started_at: owner.started_at, host: hostname() });
  expect(statSync(join(relayHome, "locks")).mode & 0o777).toBe(0o700);
  release();
  expect(existsSync(lockFile)).toBe(false);
});

test("a lock held by a live process gives exit code 6", () => {
  plantLock(lockFile, process.pid);
  const error = caught(() => takeJobLock(relayHome, "3f9a2c1d", "rollback"));
  expect(error).toBeInstanceOf(CommandError);
  expect(error.code).toBe(6);
  expect(error.lines).toEqual([
    `Another relay command is working on this job (relay checkpoint, process ${process.pid}). Try again when it finishes.`,
  ]);
  expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
});

test("a lock left by a process that has ended is replaced", async () => {
  plantLock(lockFile, await deadPid());
  const release = takeJobLock(relayHome, "3f9a2c1d", "checkpoint");
  expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
  release();
});

test("a lock from another computer is never treated as stale", async () => {
  mkdirSync(join(relayHome, "locks"), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: await deadPid(), command: "checkpoint", started_at: "x", host: `${hostname()}-other` }));
  expect(caught(() => takeJobLock(relayHome, "3f9a2c1d", "checkpoint")).code).toBe(6);
});

test("a lock that cannot be read gives exit code 6", () => {
  mkdirSync(join(relayHome, "locks"), { recursive: true });
  writeFileSync(lockFile, "not json");
  expect(caught(() => takeJobLock(relayHome, "3f9a2c1d", "checkpoint")).lines).toEqual([
    "Another relay command is working on this job (another relay command). Try again when it finishes.",
  ]);
});

test("a job ID that is not 8 hexadecimal characters is never used in a path", () => {
  expect(() => takeJobLock(relayHome, "../../x", "checkpoint")).toThrow("relay refused to use the job ID");
});

test("the events lock waits for a live holder, then gives exit code 6 after 2 seconds", async () => {
  const eventsLock = join(relayHome, "locks", "3f9a2c1d.events.lock");
  plantLock(eventsLock, process.pid, "append-event");
  const started = Date.now();
  const error = await withEventsLock(relayHome, "3f9a2c1d", () => "ran").catch((caughtError) => caughtError as CommandError);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect((error as CommandError).code).toBe(6);
});

test("the events lock left by a process that has ended is replaced", async () => {
  plantLock(join(relayHome, "locks", "3f9a2c1d.events.lock"), await deadPid(), "append-event");
  expect(await withEventsLock(relayHome, "3f9a2c1d", () => "ran")).toBe("ran");
});

test("eight processes recovering the same stale lock: exactly one gets it", async () => {
  plantLock(lockFile, await deadPid());
  const script = join(import.meta.dir, "..", "fixtures", "job", "take-lock.ts");
  const startAt = String(Date.now() + 1500);
  const children = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, script, relayHome, "3f9a2c1d", startAt, "2500"], { stdout: "pipe", stderr: "pipe" }),
  );
  const outputs = await Promise.all(children.map(async (child) => {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return out.trim();
  }));
  expect(outputs.filter((out) => out === "got")).toHaveLength(1);
  expect(outputs.filter((out) => out === "busy")).toHaveLength(7);
  expect(existsSync(lockFile)).toBe(false);
  expect(existsSync(`${lockFile}.recover`)).toBe(false);
});

test("a recovery lock left for more than 10 seconds is removed, and the stale lock is then recovered", async () => {
  plantLock(lockFile, await deadPid());
  writeFileSync(`${lockFile}.recover`, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${lockFile}.recover`, old, old);
  const release = takeJobLock(relayHome, "3f9a2c1d", "checkpoint");
  expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
  release();
});

test("a recent recovery lock means another process is recovering, so the live check decides", async () => {
  plantLock(lockFile, await deadPid());
  writeFileSync(`${lockFile}.recover`, "");
  expect(caught(() => takeJobLock(relayHome, "3f9a2c1d", "checkpoint")).code).toBe(6);
  expect(existsSync(lockFile)).toBe(true);
});
