import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createEventLog, readEvents, type JobRef } from "../../src/job/events";

let root: string;
let job: JobRef;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  job = { id: "3f9a2c1d", worktreeRoot: join(root, "repo"), relayHome: join(root, "relay-home") };
  mkdirSync(join(job.worktreeRoot, ".relay"), { recursive: true });
  createEventLog(job);
  log = join(job.worktreeRoot, ".relay", "events.jsonl");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("events get the envelope and ids from 1", async () => {
  const first = await appendEvent(job, "job_started", { title: "main" });
  await appendEvent(job, "checkpoint_saved", { number: 1 });
  const lines = readFileSync(log, "utf8").split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe("");
  expect(Object.keys(JSON.parse(lines[0]!))).toEqual(["v", "id", "ts", "job", "type", "actor", "data"]);
  expect(first).toEqual({ v: 1, id: 1, ts: first.ts, job: "3f9a2c1d", type: "job_started", actor: "relay", data: { title: "main" } });
  expect(first.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(readEvents(job).map((event) => [event.id, event.type])).toEqual([[1, "job_started"], [2, "checkpoint_saved"]]);
});

test("a partial last line is ignored, and the next event starts on a new line with the next id", async () => {
  await appendEvent(job, "a", {});
  await appendEvent(job, "b", {});
  writeFileSync(log, readFileSync(log, "utf8") + '{"v":1,"id":3,"ts":"2026-10-07T20:31');
  expect(readEvents(job).map((event) => event.id)).toEqual([1, 2]);

  const next = await appendEvent(job, "c", {});
  expect(next.id).toBe(3);
  const lines = readFileSync(log, "utf8").split("\n");
  expect(lines[2]).toBe('{"v":1,"id":3,"ts":"2026-10-07T20:31');
  expect(JSON.parse(lines[3]!).type).toBe("c");
  expect(readEvents(job).map((event) => [event.id, event.type])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
});

test("the last id is found when the last line is longer than the part read first", async () => {
  await appendEvent(job, "big", { text: "x".repeat(200_000) });
  expect((await appendEvent(job, "small", {})).id).toBe(2);
});

test.each([["no lock"], ["a stale events lock"]])("with %s, two processes appending 100 events each give consecutive ids in file order", async (start) => {
  if (start !== "no lock") {
    const ended = Bun.spawn(["true"]);
    await ended.exited;
    mkdirSync(join(job.relayHome, "locks"), { recursive: true });
    writeFileSync(join(job.relayHome, "locks", "3f9a2c1d.events.lock"), JSON.stringify({ pid: ended.pid, command: "append-event", started_at: "x", host: hostname() }));
  }
  const script = join(import.meta.dir, "..", "fixtures", "job", "append-events.ts");
  const run = (label: string) =>
    Bun.spawn([process.execPath, script, job.worktreeRoot, job.relayHome, job.id, "100", label], { stdout: "ignore", stderr: "pipe" });
  const writers = [run("one"), run("two")];
  const codes = await Promise.all(writers.map((child) => child.exited));
  expect(codes).toEqual([0, 0]);

  const lines = readFileSync(log, "utf8").split("\n");
  expect(lines.pop()).toBe("");
  expect(lines).toHaveLength(200);
  const events = lines.map((line) => JSON.parse(line));
  expect(events.map((event) => event.id)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  for (const label of ["one", "two"]) {
    expect(events.filter((event) => event.data.writer === label).map((event) => event.data.n)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  }
});

test("a whole event whose newline was never written keeps its id, and the next append gets the following one", async () => {
  await appendEvent(job, "a", {});
  await appendEvent(job, "b", {});
  writeFileSync(log, readFileSync(log, "utf8") + JSON.stringify({ v: 1, id: 3, ts: "2026-10-07T20:31:05.123Z", job: "3f9a2c1d", type: "c", actor: "relay", data: {} }));
  expect((await appendEvent(job, "d", {})).id).toBe(4);
  const ids = readEvents(job).map((event) => event.id);
  expect(ids).toEqual([1, 2, 3, 4]);
  const fileIds = readFileSync(log, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).id);
  expect(fileIds).toEqual([1, 2, 3, 4]);
});

test("a blank line at the end of the log does not stop the next append", async () => {
  await appendEvent(job, "a", {});
  writeFileSync(log, readFileSync(log, "utf8") + "\n\n");
  expect((await appendEvent(job, "b", {})).id).toBe(2);
  expect(readEvents(job).map((event) => event.id)).toEqual([1, 2]);
});

test("the events lock is gone after each append", async () => {
  await appendEvent(job, "a", {});
  expect(() => readFileSync(join(job.relayHome, "locks", "3f9a2c1d.events.lock"))).toThrow();
});
