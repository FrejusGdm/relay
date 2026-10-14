// relay run --resume-at-reset with the fake agents and a real daemon (add-resume-at-reset, task
// 3.1): the agent stops at a usage limit, relay run hands the wait to the daemon, the daemon resumes
// the same session on the same account after the reset, and relay run prints what happens and exits
// with the wait's exit code.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";
import { FAKE_SCANNER, jobId } from "../helpers/job";
import { spawnDaemon, stopDaemon, stopStartedDaemon } from "../helpers/relay-home";
import { makeScratchRepo } from "../helpers/scratch-repo";
import { readWait, writeWait } from "../../src/resume/wait";
import { jobEvents, relayRun, runFixture, spawnRelayRun, until, workers, type FakeScenario, type RunFixture } from "../run/helpers";

setDefaultTimeout(60_000);

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
// The daemon looks every 100 ms, resumes as soon as the reset time has passed and checks an
// unknown reset time every second.
const FAST = { RELAY_TEST_START_DAEMON: "1", RELAY_TEST_RESUME_TICK_MS: "100", RELAY_TEST_RESUME_MARGIN_MS: "0", RELAY_TEST_RESUME_CHECK_MS: "1000" };

let fixture: RunFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) {
    await stopStartedDaemon(fixture.relayHome);
    await fixture.cleanup();
  }
  fixture = undefined;
});

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

test("a limit with a known reset time: relay waits, resumes the same session and finishes", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Fix the test."], {
    session_id: SESSION,
    turns: [{ steps: [{ say: "Working." }, { run: "bun test", exit_code: 1 }, { limit: { window: "five_hour", resets_at: inSeconds(3) } }] }],
    resumes: [{ turns: [{ steps: [{ write: "src/a.ts", content: "fixed\n" }, { say: "Done." }] }] }],
  }, FAST);
  const code = await run.exited;
  expect({ code, stderr: run.stderr() }).toMatchObject({ code: 0 });
  const out = run.stdout();
  if (process.env.SHOW_OUTPUT) console.log(out + "---\n" + run.stderr());
  expect(out).toContain("Waiting for claude:work's limit to reset at ");
  expect(out).toContain(`To cancel, run relay resume-at-reset off --job ${f.jobId}`);
  expect(out).toContain("Continuing session 7c1e9a52 on claude:work (resume 1).");
  expect(out).toContain("  changed src/a.ts");
  expect(out).toContain("The task ended normally after 1 resume.");
  const records = workers(f);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ account: "claude:work", resumed_from: SESSION, provider_session_id: SESSION, end_reason: "exited" });
  const types = jobEvents(f).map((event) => event.type).filter((type) => type.startsWith("resume_at_reset_"));
  expect(types).toEqual(["resume_at_reset_on", "resume_at_reset_waiting", "resume_at_reset_resumed", "resume_at_reset_ended"]);
  expect(jobEvents(f).find((event) => event.type === "resume_at_reset_ended")!.data).toMatchObject({ outcome: "finished", exit_code: 0, resumes: 1 });
  expect(existsSync(join(f.relayHome, "jobs", f.jobId, "resume-at-reset.json"))).toBe(false);
});

// One scenario file for relay run and the daemon it starts: the daemon starts the resumed agents
// with the environment of the relay run that started it.
function scenarioEnv(scenario: FakeScenario): Record<string, string> {
  return { ...fakeEnv(scenario), ...FAST };
}

function resumeEvents(f: RunFixture) {
  return jobEvents(f).filter((event) => event.type.startsWith("resume_at_reset_"));
}

test("an unknown reset time: relay checks the account, resumes, and the check does not count", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION,
    turns: [{ steps: [{ limit: { window: "five_hour" } }] }],
    resumes: [{ turns: [{ steps: [{ say: "Done." }] }] }],
  }));
  expect(await run.exited).toBe(0);
  expect(run.stdout()).toContain("Waiting for claude:work's limit to reset. relay checks again at ");
  expect(run.stdout()).toContain("No reset time is known for claude:work. relay tries to continue now.");
  const events = resumeEvents(f);
  expect(events.find((event) => event.type === "resume_at_reset_waiting")!.data).toMatchObject({ reset_at: null, reason: "usage_limit" });
  expect(events.find((event) => event.type === "resume_at_reset_checked")!.data).toMatchObject({ result: "resuming" });
  expect(events.find((event) => event.type === "resume_at_reset_resumed")!.data).toMatchObject({ counted: false, resume: 1 });
});

test("relay stops with exit 23 after three resumes in a row that hit the limit again", async () => {
  const f = (fixture = await runFixture());
  const limitAt = (seconds: number) => ({ steps: [{ limit: { window: "five_hour" as const, resets_at: inSeconds(seconds) } }] });
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [limitAt(2)],
    resumes: [{ turns: [limitAt(4)] }, { turns: [limitAt(6)] }, { turns: [limitAt(8)] }, { turns: [{ steps: [{ say: "Never." }] }] }],
  }));
  expect(await run.exited).toBe(23);
  expect(run.stderr()).toContain("relay stopped after 3 resumes in a row that hit the limit again.");
  expect(workers(f)).toHaveLength(4);
  expect(new Set(workers(f).map((record) => record.provider_session_id))).toEqual(new Set([SESSION]));
  expect(new Set(workers(f).map((record) => record.account))).toEqual(new Set(["claude:work"]));
  expect(resumeEvents(f).at(-1)!.data).toMatchObject({ outcome: "gave_up", reason: "limit_again", exit_code: 23, resumes: 3, resumes_in_a_row: 3 });
});

test("--max-resumes sets how many resumes in a row may hit the limit", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--max-resumes", "1", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(2) } }] }],
    resumes: [{ turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(60) } }] }] }],
  }));
  expect(await run.exited).toBe(23);
  expect(run.stderr()).toContain("relay stopped after 1 resume in a row that hit the limit again.");
});

test("credits_required ends the run at once, without a wait", async () => {
  const f = (fixture = await runFixture());
  const result = await relayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."],
    { session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(60), kind: "credits" } }] }] });
  expect(result.code).toBe(23);
  expect(result.stderr).toBe("Claude Code stopped: this account has used its included usage and needs usage credits to continue.\nrelay does not wait for this.\n");
  expect(resumeEvents(f).map((event) => [event.type, event.data.outcome ?? null, event.data.reason ?? null])).toEqual([
    ["resume_at_reset_on", null, null], ["resume_at_reset_ended", "stopped", "credits_required"],
  ]);
  expect(jobEvents(f).find((event) => event.type === "turn_failed")!.data).toMatchObject({ reason: "credits_required" });
  expect(existsSync(join(f.relayHome, "jobs", f.jobId, "resume-at-reset.json"))).toBe(false);
});

test("a resumed agent that fails for another reason ends the wait with its exit code", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(2) } }] }],
    resumes: [{ turns: [{ steps: [{ error: "overloaded" }] }] }, { turns: [{ steps: [{ say: "Never." }] }] }],
  }));
  expect(await run.exited).toBe(24);
  expect(run.stdout()).toContain("Claude Code stopped: the service is overloaded.");
  expect(run.stderr()).toContain("relay stopped resuming this job (overloaded).");
  expect(workers(f)).toHaveLength(2);
});

test("--resume-at-reset needs --headless, and --max-resumes needs --resume-at-reset", async () => {
  const f = (fixture = await runFixture());
  expect(await relayRun(f, ["claude:work", "--resume-at-reset"])).toMatchObject({ code: 2, stderr: "relay: --resume-at-reset works only with --headless.\n" });
  expect(await relayRun(f, ["claude:work", "--headless", "--max-resumes", "2", "--prompt", "Go."]))
    .toMatchObject({ code: 2, stderr: "relay: --max-resumes works only with --resume-at-reset.\n" });
  expect(await relayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--max-resumes", "0", "--prompt", "Go."]))
    .toMatchObject({ code: 2, stderr: "relay: --max-resumes must be a whole number from 1 to 20.\n" });
  expect(workers(f)).toHaveLength(0);
});

test("relay status shows the wait, and relay resume-at-reset off cancels it", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(120) } }] }],
  }));
  await until(() => run.stdout().includes("You can close this terminal."), 20_000);
  const status = await runRelayInProcess(["status"], { cwd: f.scratch.repo, relayHome: f.relayHome });
  expect(status.stdout).toContain("Waiting for claude:work's limit to reset at ");
  const json = JSON.parse((await runRelayInProcess(["status", "--json"], { cwd: f.scratch.repo, relayHome: f.relayHome })).stdout);
  expect(json.resume_at_reset).toMatchObject({ state: "waiting", target: "claude:work", provider_session_id: SESSION, reason: "usage_limit", max_resumes: 3 });

  const off = await runRelayInProcess(["resume-at-reset", "off", "--job", f.jobId], { relayHome: f.relayHome });
  expect(off).toEqual({ code: 0, stdout: `Cancelled resume at reset for job ${f.jobId}.\n`, stderr: "" });
  expect(await run.exited).toBe(23);
  expect(run.stderr()).toContain("Cancelled.");
  expect(workers(f)).toHaveLength(1);
  expect(resumeEvents(f).at(-1)!.data).toMatchObject({ outcome: "cancelled", reason: "person" });
  expect(await runRelayInProcess(["resume-at-reset", "off", "--job", f.jobId], { relayHome: f.relayHome }))
    .toEqual({ code: 1, stdout: "", stderr: `Job ${f.jobId} has no resume at reset to cancel.\n` });
});

test("Ctrl+C in the waiting relay run cancels the wait", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(120) } }] }],
  }));
  await until(() => run.stdout().includes("You can close this terminal."), 20_000);
  run.child.kill("SIGINT");
  expect(await run.exited).toBe(130);
  expect(run.stderr()).toContain("Cancelled. relay will not resume this job.");
  expect(existsSync(join(f.relayHome, "jobs", f.jobId, "resume-at-reset.json"))).toBe(false);
});

test("closing the terminal leaves the wait to the daemon, which survives a restart and resumes once", async () => {
  const f = (fixture = await runFixture());
  const env = scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(5) } }] }],
    resumes: [{ turns: [{ steps: [{ say: "Done." }] }] }],
  });
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, env);
  await until(() => run.stdout().includes("You can close this terminal."), 20_000);
  // The terminal closes: relay run ends, the wait stays.
  run.child.kill("SIGHUP");
  expect(await run.exited).toBe(143);
  expect(existsSync(join(f.relayHome, "jobs", f.jobId, "resume-at-reset.json"))).toBe(true);
  // The daemon restarts before the reset.
  await stopStartedDaemon(f.relayHome);
  const daemon = spawnDaemon(f.relayHome, env);
  try {
    await until(() => resumeEvents(f).some((event) => event.type === "resume_at_reset_ended"), 30_000);
    expect(resumeEvents(f).at(-1)!.data).toMatchObject({ outcome: "finished", exit_code: 0 });
    expect(resumeEvents(f).filter((event) => event.type === "resume_at_reset_resumed")).toHaveLength(1);
    expect(workers(f)).toHaveLength(2);
  } finally {
    await stopDaemon(daemon);
  }
});

test("a job that moved on is not resumed", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."], {}, scenarioEnv({
    session_id: SESSION, turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(3) } }] }],
  }));
  await until(() => run.stdout().includes("You can close this terminal."), 20_000);
  // Another agent ran in the job while it waited.
  const other = { ...workers(f)[0]!, worker_id: "0badf00d", account: "codex:personal", started_at: new Date().toISOString() };
  writeFileSync(join(f.relayHome, "jobs", f.jobId, "workers", "0badf00d.json"), JSON.stringify(other), { mode: 0o600 });
  expect(await run.exited).toBe(23);
  expect(run.stderr()).toContain("Another agent continued this job, so relay did not resume it.");
  expect(resumeEvents(f).at(-1)!.data).toMatchObject({ outcome: "cancelled", reason: "job_moved_on" });
});

test("two jobs on one account each resume their own session once", async () => {
  const f = (fixture = await runFixture());
  const second = makeScratchRepo();
  try {
    expect((await runRelayInProcess(["init"], { cwd: second.repo, relayHome: f.relayHome, env: FAKE_SCANNER })).code).toBe(0);
    const secondFixture: RunFixture = { ...f, scratch: { ...f.scratch, repo: second.repo }, jobId: jobId(second) };
    const env = scenarioEnv({
      turns: [{ steps: [{ limit: { window: "five_hour", resets_at: inSeconds(4) } }] }],
      resumes: [{ turns: [{ steps: [{ say: "Done." }] }] }, { turns: [{ steps: [{ say: "Done." }] }] }],
    });
    const first = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "One."], {}, env);
    const other = spawnRelayRun(secondFixture, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Two."], {}, env);
    expect(await first.exited).toBe(0);
    expect(await other.exited).toBe(0);
    for (const job of [f, secondFixture]) {
      const records = workers(job);
      expect(records).toHaveLength(2);
      expect(records[0]!.resumed_from).toBe(records[1]!.provider_session_id);
      expect(records.every((record) => record.account === "claude:work")).toBe(true);
    }
  } finally {
    second.cleanup();
  }
});

test("a second relay run never replaces a wait the daemon is using", async () => {
  const f = (fixture = await runFixture());
  const root = f.scratch.repo;
  writeWait(f.relayHome, {
    schema_version: 1, job_id: f.jobId, root, account: "claude:work", provider: "claude", session_id: SESSION, permission: "edit-in-workspace",
    model: null, max_resumes: 3, state: "resuming", stop: null, next_check_at: null, resumes: 1, resumes_in_a_row: 0, counted: true,
    waiting_since: new Date().toISOString(), worker_id: "12345678", owner_pid: null, updated_at: new Date().toISOString(),
  });
  const result = await relayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Go."]);
  expect(result.code).toBe(6);
  expect(result.stderr).toContain(`relay resume-at-reset off --job ${f.jobId}`);
  expect(workers(f)).toHaveLength(0);
  expect(readWait(f.relayHome, f.jobId)).toMatchObject({ state: "resuming", worker_id: "12345678" });
});
