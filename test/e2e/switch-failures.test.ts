// Failures end to end (task 7.5): a failed start and a retry that reuses the handoff, a crash after
// each journal step and the recovery, a planted core.fsmonitor, changed agent instructions without a
// terminal, a secret in the work, a busy job, and Control-C during the checks.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeJobLock } from "../../src/job/lock";
import { fakeGithubToken } from "../helpers/secrets";
import { jobEvents, until } from "../run/helpers";
import { relayProcess, relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const working = { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true as const }] }] };

async function run(args: string[], env: Record<string, string> = {}) {
  const child = relayProcess(fixture, args, env);
  const code = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr() };
}

// A relay run whose interactive Claude Code is working.
async function claudeWorking(scenario: object = working, env: Record<string, string> = {}) {
  fixture.scenarios.set({ claude: scenario as never });
  const agent = relayProcess(fixture, ["run", "claude:personal"], env);
  await until(() => agent.stdout().includes("Working.") || agent.stdout().includes("I changed") || agent.stdout().includes("I updated"));
  return agent;
}

async function claudeWorked() {
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Done." }] }] } });
  expect((await run(["run", "claude:personal", "--headless", "--prompt", "Go."])).code).toBe(0);
}

test("a failed start, then relay run codex:personal reuses the handoff", async () => {
  fixture = await e2eFixture();
  const agent = await claudeWorking();
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-exits-at-once.json") });
  const failed = await run(["switch", "codex:personal", "--no-summary"]);
  expect(failed.code).toBe(31);
  expect(await agent.exited).toBe(31);
  fixture.scenarios.set({ codex: Scenarios.fixture("codex-starts.json") });
  const retry = relayTerminal(fixture, ["run", "codex:personal"]);
  try {
    await until(() => retry.output().includes("Reading .relay/checkpoint.md"));
    expect(retry.output().replaceAll("\r", "")).toStartWith("Using the prepared handoff 1\nStarting Codex · personal\nContinuing on Codex.\n");
    await until(() => JSON.parse(readFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", "1", "handoff.json"), "utf8")).outcome === "started");
  } finally {
    retry.child.kill("SIGTERM");
    await retry.child.exited;
  }
});

describe("a crash after each journal step, then the recovery", () => {
  test("after stopped", async () => {
    fixture = await e2eFixture();
    const agent = await claudeWorking(working, { RELAY_TEST_CRASH_AFTER: "stopped" });
    const crashed = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(crashed.code).not.toBe(0);
    expect(await agent.exited).toBe(99);
    const recovered = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toStartWith("The last switch to Codex · personal did not finish. relay cleaned it up.");
    expect(jobEvents(fixture).some((event) => event.type === "handoff_failed" && event.data.reason === "relay stopped during the switch")).toBe(true);
  });

  test.each(["checkpoint_saved", "files_written", "handoff_recorded"])("after %s", async (step) => {
    fixture = await e2eFixture();
    await claudeWorked();
    fixture.scratch.write("src/b.ts", "b\n");
    const before = readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8");
    expect((await run(["switch", "codex:personal", "--no-start", "--no-summary"], { RELAY_TEST_CRASH_AFTER: step })).code).toBe(99);
    if (step === "files_written") expect(readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8")).toBe(before);
    const checkpoints = fixture.scratch.git("for-each-ref", `refs/relay/jobs/${fixture.jobId}/checkpoints/`);
    const recovered = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(recovered.code).toBe(0);
    const work = fixture.scratch.git("rev-parse", `refs/relay/jobs/${fixture.jobId}/latest`).trim().slice(0, 6);
    if (step === "handoff_recorded") {
      // A recorded handoff is kept, with the job files it wrote, so the next switch saves them.
      expect(recovered.stdout).toMatch(/^The last switch to Codex · personal did not finish\. relay cleaned it up\. Your work is saved in checkpoint [0-9a-f]{6}\.\nSaved checkpoint /);
    } else {
      expect(recovered.stdout).toStartWith(`The last switch to Codex · personal did not finish. relay cleaned it up. Your work is saved in checkpoint ${work}.\nUsing checkpoint ${work} (no changes since it was saved)\n`);
      expect(fixture.scratch.git("for-each-ref", `refs/relay/jobs/${fixture.jobId}/checkpoints/`)).toBe(checkpoints);
    }
    const handoffs = fixture.scratch.git("for-each-ref", "--format=%(refname)", `refs/relay/jobs/${fixture.jobId}/handoffs/`).split("\n").filter(Boolean);
    expect(handoffs).toHaveLength(step === "handoff_recorded" ? 2 : 1);
  });
});

test("a planted core.fsmonitor: exit 5, the agent keeps working, and the planted command never ran", async () => {
  fixture = await e2eFixture();
  const agent = await claudeWorking(Scenarios.fixture("claude-plants-fsmonitor.json"));
  try {
    expect((await run(["switch", "codex:personal", "--no-start", "--no-summary"])).code).toBe(5);
    expect(agent.child.exitCode).toBeNull();
    expect(existsSync(join(fixture.scratch.repo, "fsmonitor-ran"))).toBe(false);
  } finally {
    process.kill(-agent.child.pid!, "SIGKILL");
    await agent.exited;
  }
});

test("changed agent instructions without a terminal: exit 7", async () => {
  fixture = await e2eFixture();
  const agent = await claudeWorking(Scenarios.fixture("claude-edits-agents-md.json"));
  try {
    expect(await run(["switch", "codex:personal", "--no-start", "--no-summary"])).toEqual({
      code: 7, stdout: "",
      stderr: "relay: Claude Code changed files that tell agents what to do. Review them, then run relay switch codex:personal in a terminal, or add --yes.\n",
    });
    expect(agent.child.exitCode).toBeNull();
  } finally {
    process.kill(-agent.child.pid!, "SIGTERM");
    await agent.exited;
  }
});

test("a secret in the work diff: exit 4, and the agent is stopped", async () => {
  fixture = await e2eFixture();
  const agent = await claudeWorking();
  fixture.scratch.write("src/config.ts", `export const token = "${fakeGithubToken()}";\n`);
  const result = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
  expect(result.code).toBe(4);
  expect(result.stderr).toEndWith("relay: Claude Code is stopped. Nothing was sent to Codex.\n");
  await agent.exited;
});

test("a busy job: exit 6, and nothing is stopped", async () => {
  fixture = await e2eFixture();
  await claudeWorked();
  const release = takeJobLock(fixture.relayHome, fixture.jobId, "checkpoint");
  try {
    const result = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(result.code).toBe(6);
    expect(result.stderr).toContain("Another relay command is working on this job");
  } finally {
    release();
  }
});

test("Control-C during the checks: exit 130", async () => {
  fixture = await e2eFixture();
  await claudeWorked();
  writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json"), JSON.stringify({
    schema_version: 1, job_id: fixture.jobId, mode: "headless", permission: "edit-in-workspace",
    checks: [{ command: "sleep 30", timeout_seconds: 600, added_at: new Date().toISOString() }], next_handoff: 1,
  }), { mode: 0o600 });
  const child = relayProcess(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
  await until(() => existsSync(join(fixture.relayHome, "logs", "checks", `${fixture.jobId}-h1-1.log`)));
  await Bun.sleep(200);
  process.kill(-child.child.pid!, "SIGINT");
  expect(await child.exited).toBe(130);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "checks" } });
});
