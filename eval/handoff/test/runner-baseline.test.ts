import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git.ts";
import type { PlannedRun } from "../src/plan.ts";
import { Relay } from "../src/relay-cli.ts";
import type { RunResult } from "../src/result.ts";
import { runOne } from "../src/runner.ts";
import type { RunContext } from "../src/runner.ts";
import type { StubScenario } from "./bin/stub-relay.ts";
import { cleanup, relayRepo, STUB_RELAY, temp, writeScenario } from "./helpers.ts";

afterEach(() => {
  delete process.env.RELAY_STUB_SCENARIO;
  cleanup();
});

const RUN: PlannedRun = { id: "tiny-ready__baseline__claude__r1", kind: "baseline", task: "tiny-ready", repetition: 1, from: "claude", to: null, point: null };
const START = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const SHA = /^[0-9a-f]{40}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function setup(scenario: (root: string) => StubScenario, overrides: Partial<RunContext> = {}) {
  const root = await relayRepo(["tiny-ready"]);
  process.env.RELAY_STUB_SCENARIO = writeScenario(scenario(root));
  const home = temp("eval-home");
  const output: string[] = [];
  const ctx: RunContext = {
    relay: new Relay(STUB_RELAY), home, campaign: "test", campaignDir: join(home, "campaigns", "test"), plan: "smoke",
    targets: { claude: "claude:eval-test", codex: "codex:eval-test" }, repoRoot: root, segmentLimitMs: 60_000,
    allowDirtyFixtures: false, keepWork: false, stop: new AbortController().signal,
    out: (text) => { output.push(text); }, pollMs: 50, ...overrides,
  };
  const runDir = join(ctx.campaignDir, "runs", RUN.id);
  return { root, home, ctx, output, runDir };
}

const solution = (root: string) => join(root, "eval", "handoff", "tasks", "tiny-ready", "solution", "src", "math.ts");

test("A normal baseline writes every field of result.json", async () => {
  const { root, home, ctx, output, runDir } = await setup((root) => ({
    workers: {
      "claude:eval-test": {
        // Steps far enough apart that each snapshot is taken before the next step.
        model: "stub-sonnet", step_delay_ms: 400,
        steps: [{ write: "src/math.ts", content: `${START}// TODO: fix sub\n` }, { run: ["bun", "test"] }, { copy: solution(root), to: "src/math.ts" }, { run: ["bun", "test"] }],
        usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, reasoning_output_tokens: null }, cost_usd_estimate: 0.12,
        end: "exited",
      },
    },
    status: { "claude:eval-test": { status: "available", used_percent: 12 } },
  }));
  const { result, limit } = await runOne(ctx, RUN);
  expect(limit).toBeNull();
  const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult;
  expect(written).toEqual(result);
  const taskVersion = (await git(root, ["rev-parse", "HEAD:eval/handoff/tasks/tiny-ready"])).stdout.trim();
  expect(result).toEqual({
    schema_version: 1, run_id: RUN.id, campaign: "test", plan: "smoke", task_id: "tiny-ready", task_version: taskVersion,
    kind: "baseline", repetition: 1, from_target: "claude:eval-test", to_target: null, interrupt_point: null,
    baseline_median_steps: null, baseline_runs_used: null, interrupt_step_target: null, steps_at_switch: null,
    status: "completed", started_at: expect.stringMatching(TIME), ended_at: expect.stringMatching(TIME),
    wall_seconds_total: expect.any(Number), steps_total: 4,
    tools: { relay: "0.0.0-stub", claude: null, codex: null, bun: Bun.version, git: expect.any(String), python3: expect.any(String) },
    base_sha: expect.stringMatching(SHA),
    segments: [{
      target: "claude:eval-test", worker_id: expect.stringMatching(/^[0-9a-f]{8}$/), model: "stub-sonnet",
      started_at: expect.stringMatching(TIME), ended_at: expect.stringMatching(TIME), wall_seconds: expect.any(Number),
      steps: 4, end_reason: "exited", exit_code: 0,
      usage: { source: "turn_completed", input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, reasoning_output_tokens: null, cost_usd_estimate: 0.12 },
      used_percent_before: 12, used_percent_after: 12,
    }],
    handoff: null,
    outcome: {
      final_checkpoint_sha: expect.stringMatching(SHA),
      visible_tests: { passed: 2, failed: 0, total: 2 },
      acceptance_tests: { passed: 3, failed: 0, total: 3, failing: [] },
      solved: true, regressions: [], lines_added_before: null, lines_reverted: null, rework_ratio: null, files_reworked: [],
    },
    control_points: [
      { point: "steps:25", step: 1, snapshot_sha: expect.stringMatching(SHA), acceptance_at_point: { passed: 1, failed: 2, total: 3 }, regressions: [], lines_added_before: 1, lines_reverted: 1, rework_ratio: 1, files_reworked: ["src/math.ts"] },
      { point: "steps:50", step: 2, snapshot_sha: expect.stringMatching(SHA), acceptance_at_point: { passed: 1, failed: 2, total: 3 }, regressions: [], lines_added_before: 1, lines_reverted: 1, rework_ratio: 1, files_reworked: ["src/math.ts"] },
      { point: "steps:75", step: 3, snapshot_sha: expect.stringMatching(SHA), acceptance_at_point: { passed: 3, failed: 0, total: 3 }, regressions: [], lines_added_before: 1, lines_reverted: 0, rework_ratio: 0, files_reworked: [] },
    ],
    safety: { ok: true, violations: [], bypass_flags_seen: false, argv_recorded: true },
    contamination: false, notes: "",
  });
  expect(readdirSync(runDir).sort()).toEqual([
    "acceptance-control-steps-25.xml", "acceptance-control-steps-50.xml", "acceptance-control-steps-75.xml",
    "acceptance-final.xml", "checkpoint.md", "events.jsonl", "relay-run.log", "result.json", "visible-final.xml",
  ]);
  expect(readFileSync(join(runDir, "relay-run.log"), "utf8")).toContain(`$ relay init --title "eval ${RUN.id}"`);
  expect(output).toEqual(["  Done in 0 min. Acceptance tests: 3 of 3 passed.\n"]);
  expect(existsSync(join(home, "work", RUN.id))).toBe(false);
  expect(existsSync(join(home, "tmp", `${RUN.id}.index`))).toBe(false);
}, 60000);

test("A provider limit saves an attempt and leaves the run pending", async () => {
  const { ctx, runDir } = await setup(() => ({
    workers: { "claude:eval-test": { step_delay_ms: 50, steps: [{ write: "src/math.ts", content: START }], end: "usage_limit", retry_at: "2026-10-08T15:45:00.000Z" } },
  }));
  const { result, limit } = await runOne(ctx, RUN);
  expect(limit).toEqual({ target: "claude:eval-test", retryAt: "2026-10-08T15:45:00.000Z" });
  expect(result).toMatchObject({ status: "limit_reached", outcome: null, control_points: null, steps_total: 1 });
  expect(existsSync(join(runDir, "result.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(runDir, "attempt-1.json"), "utf8"))).toEqual(result);
}, 60000);

test("A segment past its time limit is interrupted and measured as timed out", async () => {
  const { ctx, output } = await setup(() => ({
    workers: { "claude:eval-test": { step_delay_ms: 50, steps: [{ write: "src/math.ts", content: `${START}// TODO\n` }], end: "hang" } },
  }), { segmentLimitMs: 1500, stillWorkingMs: 600 });
  const { result } = await runOne(ctx, RUN);
  expect(result.status).toBe("timed_out");
  expect(output[0]).toBe("  Still working: 1 step, 0 min.\n");
  expect(result.segments[0]).toMatchObject({ end_reason: "interrupted", exit_code: null, usage: { source: "not reported", output_tokens: null } });
  expect(result.outcome).toMatchObject({ solved: false, acceptance_tests: { passed: 1, failed: 2, total: 3 } });
  expect(result.control_points).toHaveLength(3);
}, 60000);

test("A bypass flag in argv stops the run and records a safety violation", async () => {
  const { ctx } = await setup(() => ({
    workers: {
      "claude:eval-test": {
        argv: ["claude", "-p", "<prompt>", "--dangerously-skip-permissions"],
        step_delay_ms: 50, steps: [{ write: "src/math.ts", content: START }], end: "hang",
      },
    },
  }));
  const { result } = await runOne(ctx, RUN);
  expect(result.status).toBe("agent_failed");
  expect(result.safety).toEqual({
    ok: false, violations: [{ check: "bypass_flag", before: null, after: "--dangerously-skip-permissions" }],
    bypass_flags_seen: true, argv_recorded: true,
  });
  expect(result.segments[0]?.end_reason).toBe("interrupted");
}, 60000);

test("Ctrl-C stops relay run and saves the attempt as stopped by the person", async () => {
  const stop = new AbortController();
  const { ctx, runDir } = await setup(() => ({
    workers: { "claude:eval-test": { step_delay_ms: 50, steps: [{ write: "src/math.ts", content: START }], end: "hang" } },
  }), { stop: stop.signal });
  setTimeout(() => stop.abort(), 1500);
  const { result } = await runOne(ctx, RUN);
  expect(result.status).toBe("stopped_by_person");
  expect(readdirSync(runDir)).toContain("attempt-1.json");
  expect(readdirSync(runDir)).not.toContain("result.json");
}, 60000);

test("A target that relay reports as limited stops before anything runs", async () => {
  const { ctx, home } = await setup(() => ({
    workers: { "claude:eval-test": { steps: [], end: "exited" } },
    status: { "claude:eval-test": { status: "quota_exhausted", retry_at: "2026-10-08T15:45:00.000Z" } },
  }));
  try {
    await runOne(ctx, RUN);
    throw new Error("The limited target was used.");
  } catch (error) {
    expect((error as Error).message).toBe("claude:eval-test is not available (quota_exhausted). It resets at 2026-10-08T15:45:00.000Z.");
    expect((error as { exitCode?: number }).exitCode).toBe(5);
  }
  expect(existsSync(join(home, "work", RUN.id))).toBe(false);
}, 30000);
