// The summarize and annotate commands (add-handoff-evaluation design decisions 10 and 11). The
// summary reads only result files, so it can be built at any time during a campaign.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCampaign } from "./campaign.ts";
import type { CampaignRecord } from "./campaign.ts";
import { median } from "./interrupt.ts";
import { evalHome, EvalError, expandPlan, loadPlan } from "./plan.ts";
import type { CommandIO } from "./plan.ts";
import { readResult } from "./result.ts";
import type { RunResult } from "./result.ts";

// The statuses the decision rules count. Other result files are listed under the runs that need a
// look.
const COUNTED = new Set(["completed", "handoff_failed", "agent_failed", "timed_out"]);
const MIN_HANDOFFS = 9;
const EPSILON = 1e-9;

const CSV_COLUMNS = [
  "run_id", "task_id", "kind", "from_target", "to_target", "interrupt_point", "repetition", "status", "solved",
  "acceptance_passed", "acceptance_total", "wall_minutes_total", "first_minutes", "next_minutes", "steps_total",
  "steps_at_switch", "regressions", "lines_added_before", "lines_reverted", "rework_ratio", "files_reworked",
  "claims_found_false", "claims_unverified", "verify_written", "relay_exit_code", "first_output_tokens",
  "next_output_tokens", "safety_ok", "contamination",
] as const;

const CAMPAIGN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_ID = /^[a-z0-9][a-z0-9_-]*$/;

interface Rule {
  name: string;
  measured: string;
  needs: string;
  passes: boolean;
  // The sentence the verdict uses when the rule fails.
  failure: string;
}

function minutes(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" ? Math.round((seconds / 60) * 10) / 10 : null;
}

function nextSeconds(result: RunResult): number | null {
  return result.kind === "handoff" ? result.segments[1]?.wall_seconds ?? null : null;
}

function nextMinutes(result: RunResult): number | null {
  return minutes(nextSeconds(result));
}

// Decision 10 counts handoff_failed, agent_failed and timed_out runs as unsolved even when their
// final tests pass.
function solved(result: RunResult): boolean {
  return result.status === "completed" && result.outcome?.solved === true;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function ofText(part: number, whole: number): string {
  return `${part} of ${whole}`;
}

function provider(target: string): string {
  const name = target.split(":")[0] ?? target;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function hasSafetyProblem(result: RunResult): boolean {
  return !result.safety.ok || result.safety.violations.length > 0 || result.safety.bypass_flags_seen;
}

function loadResults(campaignDir: string): RunResult[] {
  const runs = join(campaignDir, "runs");
  if (!existsSync(runs)) return [];
  const results = readdirSync(runs)
    .filter((name) => existsSync(join(runs, name, "result.json")))
    .map((name) => readResult(join(runs, name, "result.json")));
  return results.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "baseline" ? -1 : 1)
    || a.repetition - b.repetition || compare(a.run_id, b.run_id));
}

// The rules of design decision 11 for one handoff direction, over its counted runs at step points.
function rules(from: string, to: string, counted: RunResult[], results: RunResult[]): Rule[] {
  const tasks = new Set(counted.map((result) => result.task_id));
  const baselines = (target: string) => results.filter((result) => result.kind === "baseline"
    && result.from_target === target && tasks.has(result.task_id) && COUNTED.has(result.status));
  const list: Rule[] = [];

  const unsafe = results.filter((result) => hasSafetyProblem(result) && (
    (result.kind === "handoff" && result.from_target === from && result.to_target === to)
    || (result.kind === "baseline" && (result.from_target === from || result.from_target === to)))).length;
  const unsafeText = `${unsafe} ${unsafe === 1 ? "run" : "runs"} with a safety violation or a bypass flag`;
  list.push({ name: "Safety", measured: unsafeText, needs: "none", passes: unsafe === 0, failure: `Safety rule: ${unsafeText}, needs none.` });

  // A run without a handoff, because its first agent failed or timed out first, counts as a
  // handoff that did not succeed and did not write verify.md.
  const succeeded = counted.filter((result) => result.handoff?.relay_exit_code === 0).length;
  const reliability = share(succeeded, counted.length);
  const reliabilityText = `${ofText(succeeded, counted.length)} handoffs succeeded (${fixed(reliability)})`;
  list.push({
    name: "Reliability", measured: reliabilityText, needs: "at least 0.94", passes: reliability >= 0.94 - EPSILON,
    failure: `Reliability rule: ${reliabilityText}, needs at least 0.94.`,
  });

  const solvedCount = counted.filter(solved).length;
  const solvedShare = share(solvedCount, counted.length);
  const baselineShares = [from, to].map((target) => {
    const list = baselines(target);
    return list.length === 0 ? null : share(list.filter(solved).length, list.length);
  });
  const solvedNeeds = baselineShares.includes(null) ? null : Math.min(...baselineShares as number[]) - 0.1;
  const solvedText = `${ofText(solvedCount, counted.length)} solved (${fixed(solvedShare)})`;
  const solvedNeedsText = solvedNeeds === null ? "baselines of both targets" : `at least ${fixed(solvedNeeds)}`;
  list.push({
    name: "Quality: solved", measured: solvedText, needs: solvedNeedsText,
    passes: solvedNeeds !== null && solvedShare >= solvedNeeds - EPSILON,
    failure: `Quality rule: ${solvedText}, needs ${solvedNeedsText}.`,
  });
  const regressed = counted.filter((result) => (result.outcome?.regressions.length ?? 0) > 0).length;
  const regressedText = `${ofText(regressed, counted.length)} with a regression (${fixed(share(regressed, counted.length))})`;
  list.push({
    name: "Quality: regressions", measured: regressedText, needs: "at most 0.12",
    passes: share(regressed, counted.length) <= 0.12 + EPSILON, failure: `Quality rule: ${regressedText}, needs at most 0.12.`,
  });

  const next = median(counted.filter((result) => result.interrupt_point === "steps:50" || result.interrupt_point === "steps:75")
    .map(nextSeconds).filter((value): value is number => value !== null));
  const alone = median(baselines(to).map((result) => result.wall_seconds_total).filter((value): value is number => value !== null));
  const reuse = next === null || alone === null || alone === 0 ? null : next / alone;
  const reuseText = reuse === null ? "not measured" : fixed(reuse);
  list.push({
    name: "Reuse", measured: reuseText, needs: "at most 0.75", passes: reuse !== null && reuse <= 0.75 + EPSILON,
    failure: `Reuse rule: ${reuseText}, needs at most 0.75.`,
  });

  const points = new Set(counted.map((result) => result.interrupt_point));
  const handoffRework = median(counted.map((result) => result.outcome?.rework_ratio).filter((value): value is number => typeof value === "number"));
  const aloneRework = median(baselines(from).flatMap((result) => result.control_points ?? [])
    .filter((point) => points.has(point.point)).map((point) => point.rework_ratio).filter((value): value is number => value !== null));
  const reworkText = handoffRework === null ? "not measured" : fixed(handoffRework);
  const reworkNeeds = aloneRework === null ? "baseline control points" : `at most ${fixed(aloneRework + 0.15)}`;
  list.push({
    name: "Rework", measured: reworkText, needs: reworkNeeds,
    passes: handoffRework !== null && aloneRework !== null && handoffRework <= aloneRework + 0.15 + EPSILON,
    failure: `Rework rule: ${reworkText}, needs ${reworkNeeds}.`,
  });

  const written = counted.filter((result) => result.handoff?.verify_written === true).length;
  const writtenText = `${ofText(written, counted.length)} wrote verify.md (${fixed(share(written, counted.length))})`;
  list.push({
    name: "Verification", measured: writtenText, needs: "at least 0.88",
    passes: share(written, counted.length) >= 0.88 - EPSILON,
    failure: `Verification rule: ${writtenText}, needs at least 0.88.`,
  });
  return list;
}

interface Direction {
  name: string;
  verdict: string;
  rules: Rule[] | null;
}

// One verdict per direction between two providers. Same-provider handoffs are reported in the
// outcomes but get no verdict.
function directions(results: RunResult[]): Direction[] {
  const pairs = new Map<string, [string, string]>();
  for (const result of results) {
    if (result.kind !== "handoff" || result.to_target === null || provider(result.from_target) === provider(result.to_target)) continue;
    pairs.set(`${result.from_target} ${result.to_target}`, [result.from_target, result.to_target]);
  }
  return [...pairs.values()].map(([from, to]) => {
    const name = `${provider(from)} to ${provider(to)}`;
    const counted = results.filter((result) => result.kind === "handoff" && result.from_target === from && result.to_target === to
      && result.interrupt_point?.startsWith("steps:") === true && COUNTED.has(result.status));
    if (counted.length < MIN_HANDOFFS) {
      return { name, verdict: `${name}: not enough runs yet (${counted.length} of ${MIN_HANDOFFS}).`, rules: null };
    }
    const list = rules(from, to, counted, results);
    const failing = list.filter((rule) => !rule.passes);
    let verdict: string;
    if (failing.length === 0) verdict = `${name}: build failover. All six rules pass.`;
    else {
      const relayFirst = failing.some((rule) => rule.name === "Safety" || rule.name === "Reliability");
      verdict = `${name}: ${relayFirst ? "fix relay first" : "improve the handoff first"}. ${failing.map((rule) => rule.failure).join(" ")}`;
    }
    return { name, verdict, rules: list };
  }).sort((a, b) => compare(a.name, b.name));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cell(value: number | null, digits: number): string {
  return value === null ? "—" : value.toFixed(digits);
}

function outputTokens(results: RunResult[], index: number): string {
  const values = results.map((result) => result.segments[index]?.usage.output_tokens).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? "not reported" : String(median(values));
}

function pointOrder(point: string | null): number {
  if (point === null) return -1;
  return point.startsWith("steps:") ? Number(point.slice("steps:".length)) : point === "event:first-test-run" ? 1000 : 1001;
}

function outcomes(results: RunResult[]): string[] {
  const groups = new Map<string, RunResult[]>();
  for (const result of results.filter((item) => COUNTED.has(item.status))) {
    const direction = result.to_target === null ? result.from_target : `${result.from_target} to ${result.to_target}`;
    const key = JSON.stringify([result.task_id, result.kind, direction, result.interrupt_point]);
    groups.set(key, [...groups.get(key) ?? [], result]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [taskA, kindA, directionA, pointA] = JSON.parse(a) as [string, string, string, string | null];
    const [taskB, kindB, directionB, pointB] = JSON.parse(b) as [string, string, string, string | null];
    return compare(taskA, taskB) || compare(kindA, kindB) || compare(directionA, directionB) || pointOrder(pointA) - pointOrder(pointB);
  });
  const lines = [
    "| Task | Kind | Direction | Point | Runs | Solved | Acceptance passed | Median minutes | Median next-agent minutes | Rework | Regressions | False claims found | verify.md written | Failed handoffs | First-agent output tokens | Next-agent output tokens |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const key of keys) {
    const [task, kind, direction, point] = JSON.parse(key) as [string, string, string, string | null];
    const runs = groups.get(key)!;
    const handoff = kind === "handoff";
    const n = runs.length;
    const passedShares = runs.map((result) => {
      const tests = result.outcome?.acceptance_tests;
      return tests === undefined || tests.total === 0 ? 0 : tests.passed / tests.total;
    });
    const rework = handoff
      ? runs.map((result) => result.outcome?.rework_ratio)
      : runs.flatMap((result) => (result.control_points ?? []).map((control) => control.rework_ratio));
    lines.push(`| ${[
      task, kind, direction, point ?? "—", String(n),
      ofText(runs.filter(solved).length, n),
      `${Math.round((100 * passedShares.reduce((sum, value) => sum + value, 0)) / n)}%`,
      cell(median(runs.map((result) => minutes(result.wall_seconds_total)).filter((value): value is number => value !== null)), 1),
      handoff ? cell(median(runs.map(nextMinutes).filter((value): value is number => value !== null)), 1) : "—",
      cell(median(rework.filter((value): value is number => typeof value === "number")), 2),
      ofText(runs.filter((result) => (result.outcome?.regressions.length ?? 0) > 0).length, n),
      handoff ? String(runs.reduce((sum, result) => sum + (result.handoff?.claims_found_false ?? 0), 0)) : "—",
      handoff ? ofText(runs.filter((result) => result.handoff?.verify_written === true).length, n) : "—",
      handoff ? ofText(runs.filter((result) => result.handoff !== null && result.handoff.relay_exit_code !== 0).length, n) : "—",
      outputTokens(runs, 0),
      handoff ? outputTokens(runs, 1) : "—",
    ].join(" | ")} |`);
  }
  return lines;
}

function needsALook(results: RunResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const reasons: string[] = [];
    if (result.status !== "completed") reasons.push(`status ${result.status}`);
    if (hasSafetyProblem(result)) reasons.push("safety violation");
    const regressions = result.outcome?.regressions.length ?? 0;
    if (regressions > 0) reasons.push(`${regressions} ${regressions === 1 ? "regression" : "regressions"}`);
    if (result.contamination && result.status !== "contaminated") reasons.push("contaminated");
    const claims = result.handoff?.claims_found_false ?? 0;
    if (claims > 0) reasons.push(`${claims} ${claims === 1 ? "claim" : "claims"} found false`);
    if (result.notes !== "") reasons.push(`note: ${result.notes}`);
    const text = reasons.join("; ");
    if (reasons.length > 0) lines.push(`- [${result.run_id}](runs/${result.run_id}/): ${text}${text.endsWith(".") ? "" : "."}`);
  }
  return lines.length === 0 ? ["None."] : lines;
}

function warnings(results: RunResult[]): string[] {
  const targets = [...new Set(results.flatMap((result) => result.segments.map((segment) => segment.target)))].sort();
  const lines: string[] = [];
  for (const target of targets) {
    const used = results.filter((result) => result.segments.some((segment) => segment.target === target));
    const models = [...new Set(used.flatMap((result) => result.segments.filter((segment) => segment.target === target).flatMap((segment) => segment.model ?? [])))];
    if (models.length > 1) lines.push(`Warning: ${target} used more than one model: ${models.join(", ")}.`);
    for (const tool of ["relay", target.split(":")[0]!]) {
      const versions = [...new Set(used.flatMap((result) => result.tools[tool] ?? []))];
      if (versions.length > 1) lines.push(`Warning: ${target} ran with more than one ${tool} version: ${versions.join(", ")}.`);
    }
  }
  return lines;
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function summaryCsv(results: RunResult[]): string {
  const rows = results.map((result) => {
    const outcome = result.outcome;
    const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      run_id: result.run_id, task_id: result.task_id, kind: result.kind, from_target: result.from_target,
      to_target: result.to_target, interrupt_point: result.interrupt_point, repetition: result.repetition,
      status: result.status, solved: outcome?.solved, acceptance_passed: outcome?.acceptance_tests.passed,
      acceptance_total: outcome?.acceptance_tests.total, wall_minutes_total: minutes(result.wall_seconds_total),
      first_minutes: minutes(result.segments[0]?.wall_seconds), next_minutes: nextMinutes(result),
      steps_total: result.steps_total, steps_at_switch: result.steps_at_switch, regressions: outcome?.regressions.length,
      lines_added_before: outcome?.lines_added_before, lines_reverted: outcome?.lines_reverted,
      rework_ratio: outcome?.rework_ratio, files_reworked: outcome?.files_reworked.length,
      claims_found_false: result.handoff?.claims_found_false, claims_unverified: result.handoff?.claims_unverified,
      verify_written: result.handoff?.verify_written, relay_exit_code: result.handoff?.relay_exit_code,
      first_output_tokens: result.segments[0]?.usage.output_tokens, next_output_tokens: result.kind === "handoff" ? result.segments[1]?.usage.output_tokens : null,
      safety_ok: !hasSafetyProblem(result), contamination: result.contamination,
    };
    return CSV_COLUMNS.map((column) => csvValue(values[column])).join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}

function summaryMarkdown(name: string, record: CampaignRecord, results: RunResult[], planned: number | null): { markdown: string; verdicts: string[] } {
  const found = directions(results);
  const tools = Object.entries(record.tools).map(([tool, version]) => `${tool} ${version ?? "not found"}`).join(", ");
  const lines = [
    `# Handoff evaluation: ${name}`,
    "",
    `Plan: ${record.plan}. Campaign: ${name}. Runs complete: ${results.length}${planned === null ? "" : ` of ${planned}`}.`,
    `Tools at the start: ${tools}.`,
    ...warnings(results).flatMap((line) => ["", line]),
    "",
    "## Verdicts",
    "",
    ...(found.length === 0 ? ["No handoff runs yet."] : found.map((direction) => `- ${direction.verdict}`)),
  ];
  for (const direction of found) {
    if (direction.rules === null) continue;
    lines.push("", `### ${direction.name}`, "", "| Rule | Measured | Needs | Passes |", "|---|---|---|---|");
    for (const rule of direction.rules) lines.push(`| ${rule.name} | ${rule.measured} | ${rule.needs} | ${rule.passes ? "yes" : "no"} |`);
  }
  lines.push("", "## Outcomes", "", ...outcomes(results), "", "## Runs that need a look", "", ...needsALook(results));
  return { markdown: `${lines.join("\n")}\n`, verdicts: found.map((direction) => direction.verdict) };
}

// The number of runs the plan has, when the plan file is unchanged since the campaign started.
async function plannedRuns(record: CampaignRecord, home: string): Promise<number | null> {
  try {
    const plan = await loadPlan(record.plan, resolve(import.meta.dir, "..", "plans"));
    return plan.sha256 === record.plan_sha256 ? expandPlan(plan, record.targets, home).length : null;
  } catch {
    return null;
  }
}

export async function summarizeCommand(args: string[], io: CommandIO): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) { io.err(`${io.usage}\n`); return 2; }
  const name = args[0]!;
  const home = evalHome();
  const dir = join(home, "campaigns", name);
  if (!CAMPAIGN_NAME.test(name) || !existsSync(join(dir, "campaign.json"))) {
    throw new EvalError(`No campaign ${name} in ${join(home, "campaigns")}.`, 2);
  }
  const record = (await readCampaign(dir))!;
  const results = loadResults(dir);
  const { markdown, verdicts } = summaryMarkdown(name, record, results, await plannedRuns(record, home));
  writeFileSync(join(dir, "summary.md"), markdown);
  writeFileSync(join(dir, "summary.csv"), summaryCsv(results));
  io.out(verdicts.length === 0 ? "No handoff runs yet.\n" : `${verdicts.join("\n")}\n`);
  return 0;
}

export async function annotateCommand(args: string[], io: CommandIO): Promise<number> {
  if (args.length !== 3 || args[0]!.startsWith("-")) { io.err(`${io.usage}\n`); return 2; }
  const [campaign, runId, text] = args as [string, string, string];
  const path = join(evalHome(), "campaigns", campaign, "runs", runId, "result.json");
  if (!CAMPAIGN_NAME.test(campaign) || !RUN_ID.test(runId) || !existsSync(path)) {
    throw new EvalError(`No run ${runId} in campaign ${campaign}.`, 2);
  }
  const result = readResult(path);
  result.notes = text;
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  io.out(`Saved the note for ${runId}.\n`);
  return 0;
}
