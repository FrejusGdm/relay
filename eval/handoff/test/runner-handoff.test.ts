import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlannedRun } from "../src/plan.ts";
import { Relay } from "../src/relay-cli.ts";
import { runOne } from "../src/runner.ts";
import type { RunContext } from "../src/runner.ts";
import type { StubScenario, StubWorker } from "./bin/stub-relay.ts";
import { cleanup, relayRepo, STUB_RELAY, temp, writeScenario } from "./helpers.ts";

afterEach(() => {
  delete process.env.RELAY_STUB_SCENARIO;
  cleanup();
});

const RUN: PlannedRun = {
  id: "tiny-ready__handoff__claude-to-codex__steps-50__r1", kind: "handoff", task: "tiny-ready", repetition: 1,
  from: "claude", to: "codex", point: "steps:50",
};
const START = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const VERIFY = "| Claim | Holds | Evidence |\n|---|---|---|\n| sub is fixed | no | the TODO is still there |\n| add works | yes | test passes |\n";

// The first agent edits, then runs the tests, one step every 1.5 seconds, so the switch after
// step 2 comes before step 3.
const firstAgent: StubWorker = {
  step_delay_ms: 1500,
  steps: [{ write: "src/math.ts", content: `${START}// TODO: fix sub\n` }, { run: ["bun", "test"] }, { run: ["bun", "test"] }, { run: ["bun", "test"] }],
  end: "exited",
};

async function setup(scenario: (tasksDir: string) => StubScenario, medianSteps = 4) {
  const root = await relayRepo(["tiny-ready"]);
  const tasksDir = join(root, "eval", "handoff", "tasks");
  process.env.RELAY_STUB_SCENARIO = writeScenario(scenario(tasksDir));
  const home = temp("eval-home");
  const campaignDir = join(home, "campaigns", "test");
  // A completed baseline of the same task and starting target gives the median.
  const baselineDir = join(campaignDir, "runs", "tiny-ready__baseline__claude__r1");
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, "result.json"), JSON.stringify({
    schema_version: 1, kind: "baseline", task_id: "tiny-ready", from_target: "claude:eval-test", status: "completed", steps_total: medianSteps,
  }));
  const output: string[] = [];
  const ctx: RunContext = {
    relay: new Relay(STUB_RELAY), home, campaign: "test", campaignDir, plan: "smoke",
    targets: { claude: "claude:eval-test", codex: "codex:eval-test" }, repoRoot: root, segmentLimitMs: 60_000,
    allowDirtyFixtures: false, keepWork: false, stop: new AbortController().signal,
    out: (text) => { output.push(text); }, pollMs: 50,
  };
  return { ctx, output, tasksDir, runDir: join(campaignDir, "runs", RUN.id) };
}

test("A normal handoff measures the switch, the claims, regressions and rework", async () => {
  const { ctx, output, runDir } = await setup((tasksDir) => ({
    workers: {
      "claude:eval-test": firstAgent,
      "codex:eval-test": {
        step_delay_ms: 50,
        steps: [{ copy: join(tasksDir, "tiny-ready", "solution", "src", "math.ts"), to: "src/math.ts" }, { run: ["bun", "test"] }, { verify: VERIFY }],
        usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 },
        end: "exited",
      },
    },
    switch: { claims_count: 3, mismatches: [{ claim: "All tests pass", found: "2 acceptance tests fail" }] },
  }));
  const { result } = await runOne(ctx, RUN);
  expect(result).toMatchObject({
    status: "completed", kind: "handoff", from_target: "claude:eval-test", to_target: "codex:eval-test",
    interrupt_point: "steps:50", baseline_median_steps: 4, baseline_runs_used: 1, interrupt_step_target: 2,
    steps_at_switch: 2, steps_total: 5, control_points: null,
    handoff: {
      relay_exit_code: 0, relay_error: null, claims_count: 3, relay_mismatches: 1, verify_written: true,
      claims_found_false: 2, claims_unverified: 0, acceptance_at_handoff: { passed: 1, failed: 2, total: 3 },
    },
    outcome: {
      solved: true, acceptance_tests: { passed: 3, failed: 0, total: 3, failing: [] }, regressions: [],
      lines_added_before: 1, lines_reverted: 1, rework_ratio: 1, files_reworked: ["src/math.ts"],
    },
    safety: { ok: true, violations: [] }, contamination: false,
  });
  expect(result.handoff!.checkpoint_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(result.handoff!.prompt_bytes).toBeGreaterThan(0);
  expect(result.handoff!.next_first_step_seconds).toBeGreaterThanOrEqual(0);
  expect(result.segments.map((segment) => [segment.target, segment.steps, segment.end_reason, segment.usage.source])).toEqual([
    ["claude:eval-test", 2, "stopped_by_switch", "not reported"],
    ["codex:eval-test", 3, "exited", "turn_completed"],
  ]);
  expect(result.segments[1]?.usage.output_tokens).toBe(20);
  for (const name of ["handoff-prompt.md", "verify.md", "relay-switch.log", "acceptance-handoff.xml", "acceptance-final.xml", "checkpoint.md"]) {
    expect(readdirSync(runDir)).toContain(name);
  }
  expect(readFileSync(join(runDir, "verify.md"), "utf8")).toBe(VERIFY);
  expect(output).toEqual([
    "  Step 2 of about 4 on claude:eval-test. Switching.\n",
    "  Continuing on codex:eval-test.\n",
    expect.stringMatching(/^ {2}Done in \d+ min\. Acceptance tests: 3 of 3 passed\. 2 claims found false\.\n$/),
  ]);
}, 60000);

test("A failed relay switch is a failed handoff measured on the last checkpoint", async () => {
  const { ctx } = await setup(() => ({
    workers: { "claude:eval-test": { ...firstAgent, end: "hang" } },
    switch: { exit_code: 31, error: "The next agent did not start." },
  }));
  const { result } = await runOne(ctx, RUN);
  expect(result).toMatchObject({
    status: "handoff_failed", steps_at_switch: 2,
    handoff: { relay_exit_code: 31, relay_error: "The next agent did not start.", checkpoint_sha: null, verify_written: false, acceptance_at_handoff: null },
    outcome: { solved: false, acceptance_tests: { passed: 1, failed: 2, total: 3 }, rework_ratio: null },
  });
  expect(result.segments).toHaveLength(1);
}, 60000);

test("An agent that finishes before the point gets no handoff", async () => {
  const { ctx, output } = await setup(() => ({
    workers: { "claude:eval-test": { ...firstAgent, step_delay_ms: 50 } },
  }), 40);
  const { result } = await runOne(ctx, RUN);
  expect(result).toMatchObject({ status: "finished_before_interrupt", interrupt_step_target: 20, steps_at_switch: null, handoff: null, steps_total: 4 });
  expect(result.outcome?.solved).toBe(false);
  expect(output.some((line) => line.includes("Switching"))).toBe(false);
}, 60000);

test("An event that names the fixture sources makes the run contaminated", async () => {
  const { ctx } = await setup((tasksDir) => ({
    workers: {
      "claude:eval-test": { ...firstAgent, step_delay_ms: 50, steps: [{ run: ["cat", join(tasksDir, "tiny-ready", ".acceptance", "math.test.ts")] }] },
    },
  }), 40);
  const { result } = await runOne(ctx, RUN);
  expect(result.status).toBe("contaminated");
  expect(result.contamination).toBe(true);
}, 60000);

test("A handoff without completed baselines stops with exit code 3", async () => {
  const { ctx } = await setup(() => ({ workers: {} }));
  await expect(runOne({ ...ctx, campaignDir: join(ctx.home, "campaigns", "empty") }, RUN))
    .rejects.toThrow("Run the baselines for tiny-ready on claude:eval-test first. The handoff point depends on them.");
  expect(existsSync(join(ctx.home, "work"))).toBe(false);
}, 30000);
