// relay run stays reachable for relay switch (task 6.2): its record in the worker lock file, the
// switch requests, a stale record, a relay run that does not answer, and SIGHUP.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "../../src/run/control";
import { relayIn, relayProcess, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";
import { jobEvents, until, workers } from "./helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

const lockPath = () => join(fixture.relayHome, "locks", `${fixture.jobId}.worker.lock`);
const requests = () => join(fixture.relayHome, "jobs", fixture.jobId, "requests");
const working = { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true as const }] }] };

test("the worker lock names the relay run, its start time, the worker and the account, with mode 0600", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  try {
    await until(() => run.stdout().includes("Working."));
    const lock = JSON.parse(readFileSync(lockPath(), "utf8"));
    expect(lock).toMatchObject({
      pid: run.child.pid, account: "claude:work", schema_version: 1, process_started_at: processStartTime(run.child.pid!),
      worker_id: workers(fixture)[0]!.worker_id, mode: "interactive", relay_version: expect.any(String),
    });
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
  } finally {
    process.kill(-run.child.pid!, "SIGTERM");
    await run.exited;
  }
  expect(existsSync(lockPath())).toBe(false);
});

test("after a handoff the worker lock names the next worker; request files are private", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working, codex: Scenarios.fixture("codex-starts.json") });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  try {
    await until(() => run.stdout().includes("Working."));
    const result = await relayIn(fixture, ["switch", "codex:personal", "--no-summary"]);
    expect(result.code).toBe(0);
    const codex = workers(fixture).find((record) => record.account === "codex:personal")!;
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: run.child.pid, account: "codex:personal", worker_id: codex.worker_id });
    expect(statSync(requests()).mode & 0o777).toBe(0o700);
    expect(readdirSync(requests())).toEqual([]);
    // The lines appear in both terminals, and Codex starts in the terminal of relay run.
    expect(run.stdout()).toContain("Stopping Claude Code · work\n");
    expect(run.stdout()).toContain("Continuing on Codex.\n");
    expect(result.stdout).toContain("Continuing on Codex.\n");
  } finally {
    process.kill(-run.child.pid!, "SIGTERM");
    await run.exited;
  }
});

test("a stale record whose process ID belongs to another program is never signalled, and is removed", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
  const other = Bun.spawn(["sleep", "30"]);
  try {
    mkdirSync(join(fixture.relayHome, "locks"), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: other.pid, account: "claude:work", started_at: new Date().toISOString(), process_started_at: "Thu Jan 1 00:00:00 2026", worker_id: "aaaaaaaa", mode: "interactive" }), { mode: 0o600 });
    const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(result.code).toBe(0);
    expect(other.exitCode).toBeNull();
    expect(existsSync(lockPath())).toBe(false);
  } finally {
    other.kill();
  }
});

test("a relay run that does not answer within 5 seconds: exit 33, and the request is removed", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  try {
    await until(() => run.stdout().includes("Working."));
    // The relay run is paused, so it takes no request.
    process.kill(run.child.pid!, "SIGSTOP");
    const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(result).toEqual({
      code: 33, stdout: "", stderr: `relay: The relay run for this job (process ${run.child.pid}) did not answer within 5 seconds. Nothing changed.\n`,
    });
    expect(readdirSync(requests())).toEqual([]);
  } finally {
    process.kill(run.child.pid!, "SIGCONT");
    process.kill(-run.child.pid!, "SIGTERM");
    await run.exited;
  }
});

test("request files older than one day are removed when relay run starts", async () => {
  fixture = await switchFixture();
  mkdirSync(requests(), { recursive: true });
  const old = join(requests(), "0123456789abcdef.json");
  writeFileSync(old, "{}");
  const day = Date.now() / 1000 - 2 * 86400;
  utimesSync(old, day, day);
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
  expect(existsSync(old)).toBe(false);
});

test("a closed terminal (SIGHUP) stops the agent, saves a checkpoint of kind auto and exits 143", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  process.kill(run.child.pid!, "SIGHUP");
  expect(await run.exited).toBe(143);
  const events = jobEvents(fixture);
  expect(events.findLast((event) => event.type === "worker_ended")?.data).toMatchObject({ end_reason: "relay_stopped" });
  expect(events.at(-1)).toMatchObject({ type: "checkpoint_saved", data: { kind: "auto" } });
  expect(run.stdout()).toMatch(/Claude Code · work stopped \(exit code 143\)\nSaved checkpoint [0-9a-f]{6}\n$/);
});
