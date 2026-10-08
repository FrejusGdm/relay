// performHandoff (task 5.5): one test per row of the table in design decision 2, forcing each step
// to fail, and the event order of a switch that succeeds. The outgoing agent is a fake that ran
// under relay run, headless and finished, or interactive under a relay run that is still running.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "../../src/run/control";
import { takeJobLock } from "../../src/job/lock";
import { jobEvents, until, workers } from "../run/helpers";
import { runRelayInProcess } from "../helpers/cli";
import { relayIn, relayProcess, Scenarios, switchFixture, type SwitchFixture } from "./switch-helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

const state = () => JSON.parse(readFileSync(join(fixture.scratch.repo, ".relay", "state.json"), "utf8"));
const relayFile = (name: string) => readFileSync(join(fixture.scratch.repo, ".relay", name), "utf8");
const handoffRefs = () => fixture.scratch.git("for-each-ref", "--format=%(refname)", `refs/relay/jobs/${fixture.jobId}/handoffs/`).split("\n").filter(Boolean);
const types = () => jobEvents(fixture).map((event) => event.type);

// A finished headless Claude Code worker that changed a file.
async function claudeWorked(steps: object[] = [{ write: "src/auth.ts", content: "export const auth = 1;\n" }, { say: "Done." }]): Promise<void> {
  fixture.scenarios.set({ claude: { turns: [{ steps: steps as never }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Add auth."])).code).toBe(0);
}

async function switchNoStart(args: string[] = [], env: Record<string, string> = {}) {
  return relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary", ...args], { env });
}

test("step 0: a switch still running in another process stops the command with exit 6", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const other = Bun.spawn(["sleep", "30"]);
  try {
    await Bun.sleep(100);
    writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "switch.json"), JSON.stringify({
      schema_version: 1, pid: other.pid, process_started_at: processStartTime(other.pid), started_at: new Date().toISOString(),
      to_account: "codex:personal", handoff_number: 1, step: "stopped", checkpoint_commit: null, checkpoint_number: null, backup_dir: null, handoff_ref: null,
    }), { mode: 0o600 });
    expect(await switchNoStart()).toEqual({
      code: 6, stdout: "", stderr: `relay: A switch to codex:personal is already running (process ${other.pid}). Try again when it finishes.\n`,
    });
  } finally {
    other.kill();
  }
});

test("step 1: refusals of the preflight change nothing", async () => {
  fixture = await switchFixture({ allow: ["claude:work"] });
  expect(await switchNoStart()).toMatchObject({ code: 3, stderr: "relay: No agent has worked on this job yet. Start one with relay run codex:personal.\n" });
  await claudeWorked();
  const before = { events: relayFile("events.jsonl"), state: relayFile("state.json"), refs: fixture.scratch.git("for-each-ref") };
  expect(await relayIn(fixture, ["switch", "codex:home", "--no-start"])).toMatchObject({
    code: 2, stderr: "relay: codex:home is not one of your accounts. Add it with relay account add codex home.\n",
  });
  expect(await switchNoStart()).toMatchObject({
    code: 7,
    stderr: 'relay: codex:personal has not worked on this project before. Sending the repository to OpenAI needs your yes.\nRun "relay switch codex:personal" in a terminal, or add --yes.\n',
  });
  expect((await switchNoStart(["--yes"], { RELAY_CODEX_BIN: join(fixture.scratch.root, "no-such-codex") })).code).toBe(20);
  const release = takeJobLock(fixture.relayHome, fixture.jobId, "checkpoint");
  try {
    expect((await switchNoStart(["--yes"])).code).toBe(6);
  } finally {
    release();
  }
  expect((await switchNoStart(["--yes", "--permission", "full-access"])).code).toBe(25);
  fixture.scratch.git("config", "core.fsmonitor", "touch fsmonitor-ran");
  expect((await switchNoStart(["--yes"])).code).toBe(5);
  expect(existsSync(join(fixture.scratch.repo, "fsmonitor-ran"))).toBe(false);
  expect({ events: relayFile("events.jsonl").split("\n").filter((line) => !line.includes("checkpoint_refused")).join("\n"), state: relayFile("state.json"), refs: fixture.scratch.git("for-each-ref") })
    .toEqual({ ...before, events: before.events.split("\n").join("\n") });
});

test("step 1: a headless job never gets more than its ceiling (exit 32)", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json"), JSON.stringify({
    schema_version: 1, job_id: fixture.jobId, mode: "headless", permission: "read-only", checks: [], next_handoff: 1,
  }), { mode: 0o600 });
  expect(await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--permission", "edit-in-workspace"])).toMatchObject({
    code: 32, stderr: "relay: This job allows read-only. relay switch never gives the next agent more than that.\n",
  });
});

test("step 2: an agent that does not stop: exit 33, and nothing else changed", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working." }, { hang: true }] }] } });
  const run = relayProcess(fixture, ["run", "claude:work"], { RELAY_TEST_FAIL_STEP: "stop" });
  await until(() => run.stdout().includes("Working."));
  const refs = fixture.scratch.git("for-each-ref");
  const result = await switchNoStart();
  expect(result.code).toBe(33);
  expect(fixture.scratch.git("for-each-ref")).toBe(refs);
  expect(run.child.exitCode).toBeNull();
  process.kill(-run.child.pid!, "SIGTERM");
  await run.exited;
});

test("step 3: a secret in the work stops the switch with exit 4; the agent stays stopped", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working." }, { hang: true }] }] } });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  fixture.scratch.write("src/config.ts", "export const key = 'FAKE-SECRET:github-pat';\n");
  const result = await switchNoStart();
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("relay: Stopped: possible secret in src/config.ts line 1 (github-pat).\n");
  expect(result.stderr).toEndWith("relay: Claude Code is stopped. Nothing was sent to Codex.\n");
  await run.exited;
  expect(state().current_worker).toBeNull();
  expect(handoffRefs()).toEqual([]);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "checkpoint", exit_code: 4 } });
});

test("step 4: a file that instructs agents changed between the question and the checkpoint: asked again, no means exit 7", async () => {
  fixture = await switchFixture();
  await claudeWorked([{ write: "AGENTS.md", content: "# Rules\n" }, { say: "Done." }]);
  let asked = 0;
  // The person answers yes to the first question; meanwhile .mcp.json changes, and the second
  // question gets no.
  const terminal = {
    beforeAnswer: () => {
      asked++;
      if (asked === 1) fixture.scratch.write(".mcp.json", "{}\n");
    },
    get answer() {
      return asked === 1 ? "y" : "n";
    },
  };
  const result = await runRelayInProcess(["switch", "codex:personal", "--no-start", "--no-summary"], {
    cwd: fixture.scratch.repo, relayHome: fixture.relayHome, env: fixture.env, terminal,
  });
  expect(asked).toBe(2);
  expect(result.stdout).toContain("Claude Code changed files that tell agents what to do:\n  AGENTS.md\nReview them with");
  expect(result.stdout).toContain("Claude Code changed files that tell agents what to do:\n  AGENTS.md\n  .mcp.json\n");
  expect(result.code).toBe(7);
  expect(result.stderr).toMatch(/^relay: Nothing was sent\. Claude Code is stopped, and your work is saved in checkpoint [0-9a-f]{6}\.\n$/);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "instruction_files", exit_code: 7 } });
  expect(fixture.scratch.git("show", `refs/relay/jobs/${fixture.jobId}/latest:.mcp.json`)).toBe("{}\n");
});

test("step 5: an agent that does not answer is not fatal: relay builds the notes", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-hangs-on-notes.json") });
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--yes"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Asking Claude Code for handoff notes\nClaude Code did not answer within 10 seconds. relay built the notes from the event log and the repository.\n");
  expect(relayFile("checkpoint.md")).toContain("Notes: built by relay: Claude Code did not answer within 10 seconds\n");
  expect(jobEvents(fixture).find((event) => event.type === "handoff_notes")?.data).toMatchObject({ outcome: "timed_out" });
}, 60_000);

test("step 7: a failing check is a result, not a failure", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary", "--yes", "--check", "exit 3"], { answers: [] });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Ran exit 3 · failed (exit code 3)\n");
  expect(relayFile("checkpoint.md")).toContain("| `exit 3` | failed (exit code 3) |");
});

test("step 8: an internal error at the build step: exit 70, nothing written", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const before = relayFile("checkpoint.md");
  const result = await switchNoStart(["--yes"], { RELAY_TEST_FAIL_STEP: "build" });
  expect(result.code).toBe(70);
  expect(relayFile("checkpoint.md")).toBe(before);
  expect(existsSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", "1"))).toBe(false);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "build", exit_code: 70 } });
});

test("step 9: a scan that cannot finish stops the switch with exit 1", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const result = await switchNoStart(["--yes"], { FAKE_GITLEAKS_EXIT: "2", FAKE_GITLEAKS_STDERR: "failed to load config\n" });
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("relay: The secret scan did not finish: failed to load config. Nothing was written or sent.\n");
  expect(handoffRefs()).toEqual([]);
});

test("step 10: writing the job files fails: both files come back, no ref, handoff_failed at write", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const before = { checkpoint: relayFile("checkpoint.md"), state: relayFile("state.json") };
  const result = await switchNoStart(["--yes"], { RELAY_TEST_FAIL_STEP: "write" });
  expect(result.code).toBe(1);
  expect(relayFile("checkpoint.md")).toBe(before.checkpoint);
  const after = JSON.parse(relayFile("state.json"));
  expect({ ...after, updated_at: null, current_worker: null }).toEqual({ ...JSON.parse(before.state), updated_at: null, current_worker: null });
  expect(handoffRefs()).toEqual([]);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "write", exit_code: 1 } });
  expect(existsSync(join(fixture.relayHome, "jobs", fixture.jobId, "switch.json"))).toBe(false);
});

test("step 11: recording fails after the ref was created: the ref is deleted and the files come back", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  const before = relayFile("checkpoint.md");
  const result = await switchNoStart(["--yes"], { RELAY_TEST_FAIL_STEP: "record" });
  expect(result.code).toBe(1);
  expect(handoffRefs()).toEqual([]);
  expect(relayFile("checkpoint.md")).toBe(before);
  expect(types().at(-1)).toBe("handoff_failed");
});

test("step 12: the next agent does not start: exit 31, the handoff stays ready", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true }] }] }, codex: Scenarios.fixture("codex-exits-at-once.json") });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-summary"]);
  expect(result.code).toBe(31);
  expect(result.stderr).toMatch(/^relay: Codex · personal did not start: codex exited with code 1 after \d+ seconds?\.\nrelay: Your work is saved in checkpoint [0-9a-f]{6}, and the handoff is ready\.\nRun "relay run codex:personal" to try again, or "relay run claude:work" to go back\.\n$/);
  expect(await run.exited).toBe(31);
  expect(state().current_worker).toBeNull();
  expect(handoffRefs()).toEqual([`refs/relay/jobs/${fixture.jobId}/handoffs/1`]);
  const handoff = JSON.parse(readFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", "1", "handoff.json"), "utf8"));
  expect(handoff.outcome).toBe("start_failed");
  expect(types().at(-1)).toBe("handoff_failed");
});

test("Control-C during the checks: the check is stopped, no handoff, the checkpoint is kept, exit 130", async () => {
  fixture = await switchFixture();
  await claudeWorked();
  writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json"), JSON.stringify({
    schema_version: 1, job_id: fixture.jobId, mode: "interactive", permission: null,
    checks: [{ command: "sleep 30", timeout_seconds: 600, added_at: new Date().toISOString() }], next_handoff: 1,
  }), { mode: 0o600 });
  const run = relayProcess(fixture, ["switch", "codex:personal", "--no-start", "--no-summary", "--yes"]);
  await until(() => existsSync(join(fixture.relayHome, "logs", "checks", `${fixture.jobId}-h1-1.log`)));
  await Bun.sleep(200);
  process.kill(-run.child.pid!, "SIGINT");
  expect(await run.exited).toBe(130);
  expect(handoffRefs()).toEqual([]);
  expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "handoff_failed", data: { step: "checks", exit_code: 130 } });
  expect(jobEvents(fixture).some((event) => event.type === "check_run")).toBe(true);
});

test("the events of a successful switch, in order", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true }] }] }, codex: Scenarios.fixture("codex-starts.json") });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
  const result = await relayIn(fixture, ["switch", "codex:personal", "--check", "true"], { answers: [] });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const listed = types();
  const from = listed.lastIndexOf("worker_ended");
  expect(listed.slice(from)).toEqual(["worker_ended", "checkpoint_saved", "handoff_notes", "check_run", "handoff", "worker_started"]);
  const codex = workers(fixture).find((record) => record.account === "codex:personal")!;
  expect(state().current_worker).toMatchObject({ id: codex.worker_id, account: "codex:personal", from_handoff: 1 });
  process.kill(-run.child.pid!, "SIGTERM");
  await run.exited;
});
