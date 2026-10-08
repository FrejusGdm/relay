// Task 4.1: appendEvent's events lock is an flock lock: two processes appending at once give
// consecutive ids, and a holder killed with SIGKILL leaves the lock free.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createEventLog, type JobRef } from "../../src/job/events";

let root: string;
let job: JobRef;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  job = { id: "3f9a2c1d", worktreeRoot: join(root, "project"), relayHome: join(root, "relay-home") };
  mkdirSync(join(job.worktreeRoot, ".relay"), { recursive: true });
  mkdirSync(job.relayHome, { mode: 0o700 });
  createEventLog(job);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lines = () => readFileSync(join(job.worktreeRoot, ".relay", "events.jsonl"), "utf8").split("\n");

test("two processes appending 500 events each give 1,000 complete lines with consecutive ids", async () => {
  await appendEvent(job, "before", {});
  const script = join(import.meta.dir, "..", "fixtures", "job", "append-events.ts");
  const run = (label: string) =>
    Bun.spawn([process.execPath, script, job.worktreeRoot, job.relayHome, job.id, "500", label], { stdout: "ignore", stderr: "pipe" });
  expect(await Promise.all([run("one"), run("two")].map((child) => child.exited))).toEqual([0, 0]);
  const all = lines();
  expect(all.pop()).toBe("");
  const events = all.map((line) => JSON.parse(line));
  expect(events).toHaveLength(1001);
  expect(events.map((event) => event.id)).toEqual(Array.from({ length: 1001 }, (_, i) => i + 1));
  for (const label of ["one", "two"]) {
    expect(events.filter((event) => event.data.writer === label).map((event) => event.data.n)).toEqual(
      Array.from({ length: 500 }, (_, i) => i),
    );
  }
}, 60_000);

test("a process killed while it holds the events lock does not block the next append", async () => {
  mkdirSync(join(job.relayHome, "locks"), { mode: 0o700 });
  const holder = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "platform", "lock-child.ts"), join(job.relayHome, "locks", `${job.id}.events.lock`)],
    { stdout: "pipe" },
  );
  const { value } = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toBe("locked\n");
  holder.kill("SIGKILL");
  await holder.exited;
  const started = Date.now();
  expect((await appendEvent(job, "after", {})).id).toBe(1);
  expect(Date.now() - started).toBeLessThan(100);
});
