// Worker records and the worker lock (task 9.3).
import { expect, test, setDefaultTimeout } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { takeWorkerLock } from "../../src/job/lock";
import { relayRun, runFixture, spawnRelayRun, steps, until, workers } from "./helpers";

// add-relay-switch: a second relay run in a job continues it through a handoff, which takes longer.
setDefaultTimeout(30_000);

const FIELDS = ["worker_id", "job_id", "account", "provider", "mode", "transport", "provider_version", "provider_session_id",
  "pid", "cwd", "permission", "argv", "resumed_from", "started_at", "ended_at", "exit_code", "signal", "end_reason", "log_path",
  // add-relay-switch
  "last_failure", "from_handoff", "start_checkpoint"];

test("a headless Codex run leaves a complete record with mode 0600", async () => {
  const fixture = await runFixture('[accounts."codex:personal"]\n');
  try {
    const result = await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Fix it."], steps({ say: "Fixed." }));
    expect(result.code).toBe(0);
    const [record] = workers(fixture);
    expect(Object.keys(record!).sort()).toEqual([...FIELDS].sort());
    expect(record).toMatchObject({
      job_id: fixture.jobId, account: "codex:personal", provider: "codex", mode: "headless", transport: "codex-app-server",
      provider_version: "0.160.0", cwd: fixture.scratch.repo, permission: "edit-in-workspace", argv: ["app-server"],
      resumed_from: null, exit_code: 0, signal: null, end_reason: "exited",
      log_path: join(fixture.relayHome, "logs", "workers", `${fixture.jobId}-${record!.worker_id}.log`),
    });
    expect(record!.worker_id).toMatch(/^[0-9a-f]{8}$/);
    expect(record!.provider_session_id).toEqual(expect.any(String));
    expect(record!.pid).toEqual(expect.any(Number));
    expect(Date.parse(record!.ended_at!)).toBeGreaterThanOrEqual(Date.parse(record!.started_at));
    const folder = join(fixture.relayHome, "jobs", fixture.jobId, "workers");
    expect(readdirSync(folder)).toEqual([`${record!.worker_id}.json`]);
    expect(statSync(join(folder, `${record!.worker_id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  } finally {
    fixture.cleanup();
  }
});

test("the record is replaced whole while the agent runs, never left half written", async () => {
  const fixture = await runFixture();
  try {
    const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], steps({ say: "Waiting." }, { hang: true }));
    await until(() => workers(fixture)[0]?.provider_session_id !== undefined && readFileSync(join(fixture.scratch.repo, ".relay", "events.jsonl"), "utf8").includes("worker_session_identified"));
    const running = workers(fixture)[0]!;
    expect(running).toMatchObject({ ended_at: null, exit_code: null, end_reason: null, transport: "claude-print" });
    const folder = join(fixture.relayHome, "jobs", fixture.jobId, "workers");
    expect(readdirSync(folder)).toEqual([`${running.worker_id}.json`]);
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toBe(130);
    expect(readdirSync(folder)).toEqual([`${running.worker_id}.json`]);
    expect(workers(fixture)[0]).toMatchObject({ worker_id: running.worker_id, end_reason: "interrupted" });
  } finally {
    fixture.cleanup();
  }
});

test("a second run in the same job is refused with exit 6 while the worker lock is held", async () => {
  const fixture = await runFixture();
  try {
    const release = takeWorkerLock(fixture.relayHome, fixture.jobId, "claude:work");
    try {
      const lock = JSON.parse(readFileSync(join(fixture.relayHome, "locks", `${fixture.jobId}.worker.lock`), "utf8"));
      expect(Object.keys(lock)).toEqual(["pid", "account", "started_at"]);
      expect(statSync(join(fixture.relayHome, "locks", `${fixture.jobId}.worker.lock`)).mode & 0o777).toBe(0o600);
      expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], steps({ say: "Hi." }))).toMatchObject({
        code: 6, stderr: "relay: Claude Code · work is working on this job. To hand it over, run relay switch claude:work.\n",
      });
      expect(workers(fixture)).toEqual([]);
    } finally {
      release();
    }
    expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], steps({ say: "Hi." }))).code).toBe(0);
    expect(readdirSync(join(fixture.relayHome, "locks")).filter((name) => name.includes("worker"))).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("a worker lock left by a process that has ended is replaced", async () => {
  const fixture = await runFixture();
  try {
    const gone = Bun.spawnSync(["true"]).pid;
    const path = join(fixture.relayHome, "locks", `${fixture.jobId}.worker.lock`);
    await Bun.write(path, JSON.stringify({ pid: gone, account: "codex:personal", started_at: new Date().toISOString() }));
    expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], steps({ say: "Hi." }))).code).toBe(0);
  } finally {
    fixture.cleanup();
  }
});
