// Task 4.4: the daemon follows each job's events.jsonl and projects.list.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, type JobRef } from "../../src/job/events";
import { runRelay } from "../helpers/cli";
import { jobId, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, testSocket, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRelayHomes();
});

// A scratch project with a job and a daemon following it.
async function project(): Promise<{ scratch: ScratchRepo; job: JobRef; events: string }> {
  const scratch = await setUpJob();
  cleanups.push(() => scratch.cleanup());
  const daemon = spawnDaemon(scratch.relayHome);
  cleanups.push(() => stopDaemon(daemon));
  await waitForDaemon(scratch.relayHome);
  const job = { id: jobId(scratch), worktreeRoot: scratch.repo, relayHome: scratch.relayHome };
  return { scratch, job, events: join(scratch.repo, ".relay", "events.jsonl") };
}

const get = async (relayHome: string, path: string) =>
  (await fetch(`http://relay${path}`, { unix: testSocket(relayHome) })).json() as Promise<Record<string, any>>;

// Polls until `check` passes or `ms` pass; returns how long it took.
async function within(ms: number, check: () => Promise<boolean>): Promise<number> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`not within ${ms} ms`);
    await Bun.sleep(50);
  }
  return Date.now() - started;
}

const workerLine = (job: JobRef, id: number, worker: string) =>
  JSON.stringify({ v: 1, id, ts: new Date().toISOString(), job: job.id, type: "worker_started", actor: "relay",
    data: { worker_id: worker, target: "claude:work", mode: "interactive", pid: null, provider_session_id: null, from_handoff: null } });

const lastId = (path: string) => JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!).id as number;

test("a checkpoint saved by relay checkpoint in another process shows within 2.5 seconds", async () => {
  const { scratch, job } = await project();
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job.last_checkpoint.number).toBe(1);
  scratch.write("feature.ts", "export const done = true;\n");
  const saved = await runRelay(["checkpoint", "-m", "From the terminal"], { cwd: scratch.repo, env: { RELAY_HOME: scratch.relayHome } });
  expect(saved.code).toBe(0);
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job.last_checkpoint?.number === 2);
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job.last_checkpoint).toMatchObject({ kind: "manual", message: "From the terminal" });
  const { checkpoints } = await get(scratch.relayHome, `/v1/jobs/${job.id}/checkpoints`);
  expect(checkpoints.map((checkpoint: { number: number; ref: string }) => [checkpoint.number, checkpoint.ref])).toEqual([
    [2, `refs/relay/jobs/${job.id}/checkpoints/2`],
    [1, `refs/relay/jobs/${job.id}/checkpoints/1`],
  ]);
  expect(checkpoints[0].commit).toBe(scratch.git("rev-parse", `refs/relay/jobs/${job.id}/checkpoints/2`).trim());
}, 30_000);

test("a line written in two halves is applied once, after the second half", async () => {
  const { scratch, job, events } = await project();
  const line = workerLine(job, lastId(events) + 1, "half");
  appendFileSync(events, line.slice(0, 40));
  await Bun.sleep(2500);
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers).toEqual([]);
  appendFileSync(events, `${line.slice(40)}\n`);
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers.length === 1);
  await Bun.sleep(300);
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers.map((worker: { id: string }) => worker.id)).toEqual(["half"]);
}, 30_000);

test("an invalid line is skipped and logged, and the next event is applied", async () => {
  const { scratch, job, events } = await project();
  const position = readFileSync(events).length;
  // appendEvent refuses to write after a line that is not an event, so the next line is written here.
  appendFileSync(events, `this is not json\n${workerLine(job, lastId(events) + 1, "after")}\n`);
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers.length === 1);
  const log = readFileSync(join(scratch.relayHome, "logs", "daemon.log"), "utf8").trim().split("\n").map((entry) => JSON.parse(entry));
  expect(log).toContainEqual(expect.objectContaining({ level: "warn", msg: "invalid_event_line", job: job.id, position }));
}, 30_000);

test("relay rollback makes the index show the new pre_rollback checkpoint", async () => {
  const { scratch, job } = await project();
  scratch.write("feature.ts", "export const done = true;\n");
  const env = { RELAY_HOME: scratch.relayHome };
  expect((await runRelay(["checkpoint", "-m", "Second"], { cwd: scratch.repo, env })).code).toBe(0);
  scratch.write("feature.ts", "export const done = false;\n");
  const rolled = await runRelay(["rollback", "2", "--yes"], { cwd: scratch.repo, env });
  expect(rolled.code).toBe(0);
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job.last_checkpoint?.kind === "pre_rollback");
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job.last_checkpoint.number).toBe(3);
}, 30_000);

test("an events.jsonl replaced by a shorter copy makes the daemon rebuild that job", async () => {
  const { scratch, job, events } = await project();
  const before = readFileSync(events, "utf8");
  await appendEvent(job, "worker_started", { worker_id: "later", target: "claude:work", mode: "interactive", pid: null });
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers.length === 1);
  writeFileSync(`${events}.copy`, before);
  renameSync(`${events}.copy`, events);
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers.length === 0);
  const log = readFileSync(join(scratch.relayHome, "logs", "daemon.log"), "utf8");
  expect(log).toContain('"msg":"job_rebuilt"');
}, 30_000);

test("a project deleted while the daemon runs is marked missing, and its checkpoints answer 409", async () => {
  const { scratch, job } = await project();
  rmSync(scratch.repo, { recursive: true, force: true });
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job?.project_missing === true);
  const response = await fetch(`http://relay/v1/jobs/${job.id}/checkpoints`, { unix: testSocket(scratch.relayHome) });
  expect(response.status).toBe(409);
  expect(((await response.json()) as any).error.code).toBe("project_missing");
  // The job stays in the index on the next checks, shown as missing.
  await Bun.sleep(2500);
  expect((await get(scratch.relayHome, `/v1/jobs/${job.id}`)).job).toMatchObject({ id: job.id, project_missing: true });
}, 30_000);

test("a project set up after the daemon started is picked up from projects.list", async () => {
  const { scratch } = await project();
  const other = await setUpJob();
  cleanups.push(() => other.cleanup());
  // The second project registered itself in its own relay folder; list it in the daemon's.
  appendFileSync(join(scratch.relayHome, "projects.list"), `${other.repo}\n`);
  await within(2500, async () => (await get(scratch.relayHome, "/v1/jobs")).jobs.length === 2);
}, 30_000);

test("a worker whose process is gone without an end is reported once as stopped", async () => {
  const { scratch, job } = await project();
  const sleeper = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  await appendEvent(job, "worker_started", { worker_id: "gone", target: "claude:work", mode: "interactive", pid: sleeper.pid });
  await within(2500, async () => (await get(scratch.relayHome, `/v1/jobs/${job.id}/workers`)).workers[0]?.state === "running");
  const stream = await fetch(`http://relay/v1/events?job=${job.id}`, { unix: testSocket(scratch.relayHome) });
  sleeper.kill("SIGKILL");
  await sleeper.exited;
  const reader = stream.body!.getReader();
  let text = "";
  await within(3000, async () => {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
    return text.includes("event: worker");
  });
  const frame = text.slice(text.indexOf("event: worker"));
  const data = JSON.parse(frame.split("\n")[1]!.replace("data: ", ""));
  expect(data).toMatchObject({ id: "gone", state: "stopped", ended_at: null });
  await reader.cancel();
}, 30_000);
