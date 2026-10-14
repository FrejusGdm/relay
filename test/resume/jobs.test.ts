// The daemon's JobResumer in the test process (add-resume-at-reset, design decision 5), with the
// start of the resumed agent replaced: a long resumed agent never holds up other jobs or the
// daemon's shutdown, and an agent the daemon itself stopped is resumed again instead of being taken
// for another agent.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterRegistry } from "../../src/adapters/registry";
import { validateConfig } from "../../src/core/config/validate";
import { setClock } from "../../src/platform/clock";
import { parseToml } from "../../src/platform/toml";
import { JobResumer, type Started } from "../../src/resume/jobs";
import type { Timing } from "../../src/resume/timing";
import { readWait, writeWait, type WaitRecord } from "../../src/resume/wait";
import type { LastEnd } from "../../src/run/run";
import { tempRelayHome } from "../helpers/relay-home";

const TIMING: Timing = { tickMs: 50, checkMs: 15 * 60_000, checkJitterMs: 0, marginMs: 0, resetJitterMs: 0, maxUnknownMs: 7 * 86_400_000 };
const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
const { config } = validateConfig(parseToml('[accounts."claude:work"]\n'), { relayHome: "/r", homedir: "/home/person" });

afterEach(() => setClock(null));

// A job folder with an event log and one worker record, and its due wait.
function job(relayHome: string, jobId: string, workerId: string): WaitRecord {
  const root = join(relayHome, "projects", jobId);
  mkdirSync(join(root, ".relay"), { recursive: true });
  writeFileSync(join(root, ".relay", "events.jsonl"), "");
  record(relayHome, jobId, workerId, new Date(Date.now() - 60_000));
  const wait: WaitRecord = {
    schema_version: 1, job_id: jobId, root, account: "claude:work", provider: "claude", session_id: SESSION, permission: "edit-in-workspace",
    model: null, max_resumes: 3, state: "waiting",
    stop: { worker_id: workerId, at: new Date(Date.now() - 60_000).toISOString(), reason: "usage_limit", reset_at: new Date(Date.now() - 1000).toISOString(), source: "stream_event" },
    next_check_at: new Date(Date.now() - 1000).toISOString(), resumes: 0, resumes_in_a_row: 0, counted: false,
    waiting_since: new Date(Date.now() - 60_000).toISOString(), worker_id: null, owner_pid: null, updated_at: new Date().toISOString(),
  };
  writeWait(relayHome, wait);
  return wait;
}

function record(relayHome: string, jobId: string, workerId: string, startedAt: Date, resumedFrom: string | null = null): void {
  const folder = join(relayHome, "jobs", jobId, "workers");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${workerId}.json`), JSON.stringify({
    worker_id: workerId, job_id: jobId, account: "claude:work", provider: "claude", started_at: startedAt.toISOString(),
    provider_session_id: SESSION, resumed_from: resumedFrom,
  }), { mode: 0o600 });
}

function resumer(relayHome: string, start: (wait: WaitRecord) => Promise<Started>): JobResumer {
  return new JobResumer({
    relayHome, env: process.env, timing: TIMING, random: () => 0, config: () => config, registry: () => createAdapterRegistry({}, process.env),
    log: { info: () => {}, warn: () => {}, error: () => {} }, start: (wait) => start(wait),
  });
}

function lastEnd(workerId: string, terminated: boolean): LastEnd {
  return {
    workerId, account: config.accounts[0]!, sessionId: SESSION, permission: "edit-in-workspace", model: null,
    lastTurn: terminated ? null : { completed: true }, interrupted: false, terminated, code: terminated ? 143 : 0, endedAt: new Date(),
  };
}

test("a long resumed agent does not hold up another job's resume or the daemon's shutdown", async () => {
  const relayHome = tempRelayHome();
  job(relayHome, "aaaaaaaa", "11111111");
  job(relayHome, "bbbbbbbb", "22222222");
  const started: string[] = [];
  let finishLong!: (end: LastEnd | null) => void;
  const watcher = resumer(relayHome, async (wait) => {
    started.push(wait.job_id);
    const done = wait.job_id === "aaaaaaaa" ? new Promise<LastEnd | null>((resolve) => { finishLong = resolve; }) : Promise.resolve(lastEnd("33333333", false));
    return { workerId: wait.job_id === "aaaaaaaa" ? "44444444" : "33333333", done };
  });
  await watcher.tick();
  for (let i = 0; i < 100 && started.length < 2; i++) await Bun.sleep(10);
  expect(started.sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  // The sweep and stop() end while job aaaaaaaa's agent still runs.
  await watcher.tick();
  const stopped = await Promise.race([watcher.stop().then(() => true), Bun.sleep(1000).then(() => false)]);
  expect(stopped).toBe(true);
  finishLong(lastEnd("44444444", false));
  await watcher.finished();
  expect(readWait(relayHome, "aaaaaaaa")).toBeNull();
});

test("an agent the daemon stopped while it shut down is resumed again, not taken for another agent", async () => {
  const relayHome = tempRelayHome();
  job(relayHome, "aaaaaaaa", "11111111");
  const starts: string[] = [];
  const watcher = resumer(relayHome, async (wait) => {
    const workerId = starts.length === 0 ? "55555555" : "66666666";
    starts.push(workerId);
    record(relayHome, wait.job_id, workerId, new Date(), SESSION);
    return { workerId, done: Promise.resolve(lastEnd(workerId, starts.length === 1)) };
  });
  await watcher.tick();
  await watcher.finished();
  expect(readWait(relayHome, "aaaaaaaa")).toMatchObject({ state: "waiting", stop: { worker_id: "55555555" }, resumes: 1, counted: false });
  await watcher.tick();
  await watcher.finished();
  expect(starts).toEqual(["55555555", "66666666"]);
  expect(readWait(relayHome, "aaaaaaaa")).toBeNull();
});

test("a wait left resuming by a daemon that died is resumed again with the agent it had started", async () => {
  const relayHome = tempRelayHome();
  const wait = job(relayHome, "aaaaaaaa", "11111111");
  record(relayHome, "aaaaaaaa", "77777777", new Date(), SESSION);
  writeWait(relayHome, { ...wait, state: "resuming", resumes: 1, worker_id: null });
  const starts: string[] = [];
  const watcher = resumer(relayHome, async (current) => {
    starts.push(current.stop!.worker_id);
    return { workerId: "88888888", done: Promise.resolve(lastEnd("88888888", false)) };
  });
  await watcher.tick();
  expect(readWait(relayHome, "aaaaaaaa")).toMatchObject({ state: "waiting", stop: { worker_id: "77777777" } });
  await watcher.tick();
  await watcher.finished();
  expect(starts).toEqual(["77777777"]);
});

test("stopping the daemon waits for a resume that is starting, so the daemon can stop its agent", async () => {
  const relayHome = tempRelayHome();
  job(relayHome, "aaaaaaaa", "11111111");
  const order: string[] = [];
  const watcher = resumer(relayHome, async () => {
    await Bun.sleep(200);
    order.push("registered");
    return { workerId: "99999999", done: Promise.resolve(lastEnd("99999999", true)) };
  });
  void watcher.tick();
  await Bun.sleep(50);
  await watcher.stop();
  order.push("stopped");
  await watcher.finished();
  expect(order).toEqual(["registered", "stopped"]);
  // The agent the stopping daemon ended is resumed by the next daemon.
  expect(readWait(relayHome, "aaaaaaaa")).toMatchObject({ state: "waiting", stop: { worker_id: "99999999" } });
});
