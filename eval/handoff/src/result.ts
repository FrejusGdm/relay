// The result file of one run, schema version 1 (add-handoff-evaluation design decision 10). Field
// names use snake_case, like relay's event log.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestCounts } from "./junit.ts";
import type { Rework } from "./rework.ts";
import type { Violation } from "./safety.ts";

export const SCHEMA_VERSION = 1;

export type RunStatus =
  | "completed"
  | "finished_before_interrupt"
  | "handoff_failed"
  | "agent_failed"
  | "timed_out"
  | "contaminated"
  | "limit_reached"
  | "stopped_by_person"
  | "harness_error";

// Runs that did not measure the handoff. They are saved as attempt-<n>.json and the run stays
// pending.
export const ATTEMPT_STATUSES: readonly RunStatus[] = ["limit_reached", "stopped_by_person", "harness_error"];

export interface Usage {
  source: "turn_completed" | "not reported";
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  cost_usd_estimate: number | null;
}

export interface Segment {
  target: string;
  worker_id: string;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  wall_seconds: number | null;
  steps: number;
  end_reason: string | null;
  exit_code: number | null;
  usage: Usage;
  used_percent_before: number | null;
  used_percent_after: number | null;
}

type Counts = Pick<TestCounts, "passed" | "failed" | "total">;

interface HandoffResult {
  relay_exit_code: number;
  relay_error: string | null;
  checkpoint_sha: string | null;
  switch_seconds: number;
  next_first_step_seconds: number | null;
  prompt_bytes: number | null;
  claims_count: number | null;
  relay_mismatches: number;
  verify_written: boolean;
  claims_found_false: number;
  claims_unverified: number;
  acceptance_at_handoff: Counts | null;
}

// Rework is null for a baseline, which has control points instead, and for a run without a
// handoff checkpoint.
interface Outcome {
  final_checkpoint_sha: string;
  visible_tests: Counts;
  acceptance_tests: Counts & { failing: string[] };
  solved: boolean;
  regressions: string[];
  lines_added_before: number | null;
  lines_reverted: number | null;
  rework_ratio: number | null;
  files_reworked: string[];
}

interface ControlPoint extends Rework {
  point: string;
  step: number;
  snapshot_sha: string;
  acceptance_at_point: Counts;
  regressions: string[];
}

export interface RunResult {
  schema_version: number;
  run_id: string;
  campaign: string;
  plan: string;
  task_id: string;
  task_version: string | null;
  kind: "baseline" | "handoff";
  repetition: number;
  from_target: string;
  to_target: string | null;
  interrupt_point: string | null;
  baseline_median_steps: number | null;
  baseline_runs_used: number | null;
  interrupt_step_target: number | null;
  steps_at_switch: number | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  wall_seconds_total: number | null;
  steps_total: number;
  tools: Record<string, string | null>;
  base_sha: string | null;
  segments: Segment[];
  handoff: HandoffResult | null;
  outcome: Outcome | null;
  control_points: ControlPoint[] | null;
  safety: { ok: boolean; violations: Violation[]; bypass_flags_seen: boolean; argv_recorded: boolean };
  contamination: boolean;
  notes: string;
}

export function counts(tests: TestCounts): Counts {
  return { passed: tests.passed, failed: tests.failed, total: tests.total };
}

function attempts(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => /^attempt-(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number).sort((a, b) => a - b);
}

// Writes result.json, or the next attempt-<n>.json for a run that stays pending. Returns the path.
export function writeResult(dir: string, result: RunResult): string {
  mkdirSync(dir, { recursive: true });
  const name = ATTEMPT_STATUSES.includes(result.status) ? `attempt-${(attempts(dir).at(-1) ?? 0) + 1}.json` : "result.json";
  writeFileSync(join(dir, name), `${JSON.stringify(result, null, 2)}\n`);
  return join(dir, name);
}

export function readResult(path: string): RunResult {
  const data = JSON.parse(readFileSync(path, "utf8")) as RunResult;
  if (data.schema_version !== SCHEMA_VERSION) throw new Error(`${path} has schema version ${data.schema_version}, not ${SCHEMA_VERSION}.`);
  return data;
}

// The status of the newest attempt of a pending run, or null when it has none.
export function lastAttemptStatus(dir: string): RunStatus | null {
  const last = attempts(dir).at(-1);
  return last === undefined ? null : readResult(join(dir, `attempt-${last}.json`)).status;
}
