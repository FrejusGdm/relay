// Task 4.5: relay doctor --reindex, and that deleting relay.db loses nothing.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../src/job/events";
import { runRelay } from "../helpers/cli";
import { jobId, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, testSocket, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRelayHomes();
});

async function job(): Promise<ScratchRepo> {
  const scratch = await setUpJob();
  cleanups.push(() => scratch.cleanup());
  return scratch;
}

const text = async (relayHome: string, path: string) => (await fetch(`http://relay${path}`, { unix: testSocket(relayHome) })).text();
const daemonPid = (relayHome: string) => JSON.parse(readFileSync(join(relayHome, "run", "daemon.pid"), "utf8")).pid as number;

test("with the daemon running, relay doctor --reindex rebuilds from 2 projects and a new daemon runs", async () => {
  const first = await job();
  const second = await job();
  appendFileSync(join(first.relayHome, "projects.list"), `${second.repo}\n`);
  const daemon = spawnDaemon(first.relayHome);
  cleanups.push(() => stopDaemon(daemon));
  const before = (await waitForDaemon(first.relayHome)).pid;

  const result = await runRelay(["doctor", "--reindex"], { env: { RELAY_HOME: first.relayHome } });
  expect(result).toEqual({ code: 0, stdout: "Rebuilt the index from .relay/ files in 2 projects.\n", stderr: "" });
  expect(await daemon.exited).toBe(0);
  const after = daemonPid(first.relayHome);
  cleanups.push(() => void runRelay(["daemon", "stop"], { env: { RELAY_HOME: first.relayHome } }));
  expect(after).not.toBe(before);
  expect((await waitForDaemon(first.relayHome)).pid).toBe(after);
}, 60_000);

test("deleting relay.db while the daemon is stopped gives byte-identical job, workers and checkpoints", async () => {
  const scratch = await job();
  const id = jobId(scratch);
  await appendEvent({ id, worktreeRoot: scratch.repo, relayHome: scratch.relayHome }, "worker_started", {
    worker_id: "w1", target: "claude:work", mode: "interactive", pid: null, provider_session_id: "s1", from_handoff: null,
  });
  const paths = [`/v1/jobs/${id}`, `/v1/jobs/${id}/workers`, `/v1/jobs/${id}/checkpoints`];

  const first = spawnDaemon(scratch.relayHome);
  await waitForDaemon(scratch.relayHome);
  const answers = await Promise.all(paths.map((path) => text(scratch.relayHome, path)));
  expect(await stopDaemon(first)).toBe(0);

  rmSync(join(scratch.relayHome, "relay.db"));
  const second = spawnDaemon(scratch.relayHome);
  cleanups.push(() => stopDaemon(second));
  await waitForDaemon(scratch.relayHome);
  expect(await Promise.all(paths.map((path) => text(scratch.relayHome, path)))).toEqual(answers);
  expect(JSON.parse(answers[1]!).workers).toHaveLength(1);
  expect(JSON.parse(answers[2]!).checkpoints).toHaveLength(1);
}, 60_000);
