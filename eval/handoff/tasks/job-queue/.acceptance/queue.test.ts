import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../src/queue.ts";

const fail = () => { throw new Error("boom"); };

async function withFile(run: (path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "queue-acceptance-"));
  try {
    await run(join(dir, "queue.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("With random returning 1 the retry delays are one and two seconds", async () => {
  let time = 0;
  const queue = new JobQueue({ maxAttempts: 3, baseDelayMs: 1000, random: () => 1, now: () => time });
  const id = queue.enqueue("email", {});
  expect(queue.get(id)?.runAt).toBe(0);
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.status).toBe("queued");
  expect(queue.get(id)?.runAt).toBe(1000);
  time = 1000;
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.status).toBe("queued");
  expect(queue.get(id)?.runAt).toBe(3000);
});

test("With random returning 0 the retry delays are halved", async () => {
  let time = 0;
  const queue = new JobQueue({ maxAttempts: 3, baseDelayMs: 1000, random: () => 0, now: () => time });
  const id = queue.enqueue("email", {});
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.runAt).toBe(500);
  time = 500;
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.runAt).toBe(1500);
});

test("Retry delays do not exceed the configured cap", async () => {
  let time = 0;
  const queue = new JobQueue({ baseDelayMs: 1000, maxDelayMs: 1500, maxAttempts: 5, random: () => 1, now: () => time });
  const id = queue.enqueue("email", {});
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.runAt).toBe(1000);
  time = 1000;
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.runAt).toBe(2500);
  time = 2500;
  await queue.runNext({ email: fail });
  expect(queue.get(id)?.runAt).toBe(4000);
});

test("A retry waits until its scheduled time", async () => {
  let time = 0;
  let calls = 0;
  const queue = new JobQueue({ random: () => 1, now: () => time });
  const id = queue.enqueue("email", {});
  const handlers = { email: () => { calls++; throw new Error("boom"); } };
  await queue.runNext(handlers);
  time = 999;
  expect(await queue.runNext(handlers)).toBeUndefined();
  expect(calls).toBe(1);
  time = 1000;
  expect((await queue.runNext(handlers))?.id).toBe(id);
  expect(calls).toBe(2);
});

test("The last allowed failure makes a job dead with its last error", async () => {
  let time = 0;
  let calls = 0;
  const queue = new JobQueue({ maxAttempts: 2, random: () => 1, now: () => time });
  const id = queue.enqueue("email", {});
  const handlers = { email: () => { throw new Error(++calls === 1 ? "first" : "second"); } };
  await queue.runNext(handlers);
  time = 1000;
  await queue.runNext(handlers);
  expect(queue.get(id)?.status).toBe("dead");
  expect(queue.get(id)?.attempts).toBe(2);
  expect(queue.get(id)?.lastError).toBe("second");
  time = 100000;
  expect(await queue.runNext(handlers)).toBeUndefined();
});

test("Dead letters contain only dead jobs in enqueue order", async () => {
  let time = 0;
  const queue = new JobQueue({ maxAttempts: 1, now: () => time, random: () => 1 });
  const first = queue.enqueue("bad", {});
  queue.enqueue("good", {});
  const third = queue.enqueue("bad", {});
  const handlers = { bad: fail, good: () => {} };
  await queue.runNext(handlers);
  await queue.runNext(handlers);
  await queue.runNext(handlers);
  expect(queue.deadLetters().map((job) => job.id)).toEqual([first, third]);
});

test("Jobs and their payloads survive reopening the file", async () => {
  let time = 0;
  const now = () => time;
  await withFile(async (path) => {
    const queue = JobQueue.open(path, { now });
    const first = queue.enqueue("email", { to: "a@example.com" });
    const second = queue.enqueue("report", { n: 2 });
    await queue.runNext({ email: () => {} });
    const copy = JobQueue.open(path, { now });
    expect(copy.get(first)?.status).toBe("done");
    expect(copy.get(first)?.payload).toEqual({ to: "a@example.com" });
    expect(copy.get(second)?.status).toBe("queued");
    expect(copy.get(second)?.payload).toEqual({ n: 2 });
  });
});

test("Every save leaves parseable JSON and no temporary file", async () => {
  let time = 0;
  const now = () => time;
  await withFile(async (path) => {
    const queue = JobQueue.open(path, { now });
    queue.enqueue("email", {});
    expect(existsSync(path + ".tmp")).toBe(false);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    await queue.runNext({ email: () => {} });
    expect(existsSync(path + ".tmp")).toBe(false);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
});

test("A running job is persisted before its handler and recovered as queued", async () => {
  let time = 0;
  const now = () => time;
  await withFile(async (path) => {
    const queue = JobQueue.open(path, { now });
    const id = queue.enqueue("email", {});
    let status: unknown;
    let attempts: unknown;
    await queue.runNext({ email: () => {
      const recovered = JobQueue.open(path, { now }).get(id);
      status = recovered?.status;
      attempts = recovered?.attempts;
    } });
    expect(status).toBe("queued");
    expect(attempts).toBe(1);
  });
});

test("Statistics include all four statuses even on an empty queue", async () => {
  let time = 0;
  const queue = new JobQueue({ maxAttempts: 1, now: () => time, random: () => 1 });
  const empty = queue.stats();
  expect(empty.queued).toBe(0);
  expect(empty.running).toBe(0);
  expect(empty.done).toBe(0);
  expect(empty.dead).toBe(0);
  queue.enqueue("good", {});
  queue.enqueue("bad", {});
  queue.enqueue("later", {});
  queue.enqueue("later", {});
  await queue.runNext({ good: () => {} });
  await queue.runNext({ bad: fail });
  const counts = queue.stats();
  expect(counts.queued).toBe(2);
  expect(counts.running).toBe(0);
  expect(counts.done).toBe(1);
  expect(counts.dead).toBe(1);
});

test("A missing handler fails the job without rejecting the run", async () => {
  let time = 0;
  const queue = new JobQueue({ maxAttempts: 1, now: () => time, random: () => 1 });
  const id = queue.enqueue("email", {});
  const job = await queue.runNext({});
  expect(job?.id).toBe(id);
  expect(queue.get(id)?.status).toBe("dead");
  expect(queue.get(id)?.lastError).toBe("no handler for type email");
});

test("New IDs stay distinct after reopening the queue", async () => {
  let time = 0;
  const now = () => time;
  await withFile((path) => {
    const queue = JobQueue.open(path, { now });
    const first = queue.enqueue("email", {});
    const second = queue.enqueue("email", {});
    const third = JobQueue.open(path, { now }).enqueue("email", {});
    expect(new Set([first, second, third]).size).toBe(3);
  });
});
