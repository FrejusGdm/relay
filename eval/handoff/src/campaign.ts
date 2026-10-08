import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { askYes, checkFixturesClean, checkFreeDisk, confirmationText, refuseUnattended } from "./guards.ts";
import { evalHome, EvalError, expandPlan, expectedMinutes, loadPlan, loadTargets, planTargets } from "./plan.ts";
import type { CommandIO, Plan, PlannedRun } from "./plan.ts";
import { findRelay, Relay, toolVersions } from "./relay-cli.ts";
import { lastAttemptStatus } from "./result.ts";
import { runOne } from "./runner.ts";

export interface CampaignRecord {
  plan: string;
  plan_sha256: string;
  targets: Record<string, string>;
  started_at: string;
  tools: Record<string, string | null>;
}

export function defaultCampaignName(plan: string, now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${plan}`;
}

export async function readCampaign(dir: string): Promise<CampaignRecord | null> {
  const path = join(dir, "campaign.json");
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  const invalid = (reason: string): never => {
    throw new EvalError(`${path} is not valid: ${reason}. Fix it, or start a new campaign with --campaign <name>.`, 3);
  };
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return invalid("it is not JSON");
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const strings = (value: unknown, nullable: boolean) => isObject(value)
    && Object.values(value).every((item) => typeof item === "string" || (nullable && item === null));
  if (!isObject(data)) return invalid("it is not a JSON object");
  const record = data;
  for (const field of ["plan", "plan_sha256", "started_at"]) {
    if (typeof record[field] !== "string") invalid(`${field} is missing or not text`);
  }
  if (!strings(record.targets, false)) invalid("targets is missing or does not map roles to accounts");
  if (!strings(record.tools, true)) invalid("tools is missing or does not list versions");
  return record as unknown as CampaignRecord;
}

export function checkPlanUnchanged(record: CampaignRecord, plan: Plan): void {
  if (record.plan_sha256 !== plan.sha256) {
    throw new EvalError(`The plan ${plan.name} changed since this campaign started. Start a new campaign with --campaign <name>.`, 3);
  }
}

export function checkTargetsUnchanged(record: CampaignRecord, targets: Record<string, string>, home: string): void {
  const recorded = Object.entries(record.targets).sort().join("\n");
  if (recorded !== Object.entries(targets).sort().join("\n")) {
    throw new EvalError(`The accounts in ${join(home, "targets.toml")} changed since this campaign started. Start a new campaign with --campaign <name>.`, 3);
  }
}

export async function writeCampaign(dir: string, record: CampaignRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "campaign.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export async function runCommand(args: string[], io: CommandIO & { readLine: () => Promise<string | null> }): Promise<number> {
  const usage = () => { io.err(`${io.usage}\n`); return 2; };
  const planArg = args[0];
  if (!planArg || planArg.startsWith("--")) return usage();
  const options = new Map<string, string | true>();
  const valued = new Set(["--campaign", "--only", "--max-runs"]);
  const flags = new Set(["--retry-errors", "--keep-work", "--allow-dirty-fixtures"]);
  for (let index = 1; index < args.length; index++) {
    const option = args[index]!;
    if (options.has(option)) return usage();
    if (valued.has(option)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) return usage();
      if (option === "--max-runs" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return usage();
      options.set(option, value);
    } else if (flags.has(option)) options.set(option, true);
    else return usage();
  }
  refuseUnattended(process.env, process.stdin.isTTY === true);
  const home = evalHome();
  const plan = await loadPlan(planArg, resolve(import.meta.dir, "..", "plans"));
  const targets = await loadTargets(home);
  const planned = expandPlan(plan, targets, home);
  const roles = new Set(planned.flatMap((run) => run.to === null ? [run.from] : [run.from, run.to]));
  const mapping = Object.fromEntries(Object.entries(targets ?? {}).filter(([role]) => roles.has(role)));
  let runs = planned;
  const only = options.get("--only");
  if (typeof only === "string") {
    runs = runs.filter((run) => run.id === only);
    if (runs.length === 0) throw new EvalError(`No run ${only} in plan ${plan.name}.`, 2);
  }
  const givenName = options.get("--campaign");
  const name = typeof givenName === "string" ? givenName : defaultCampaignName(plan.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new EvalError(`The campaign name ${name} can only use letters, digits, dots, hyphens and underscores.`, 2);
  }
  const dir = join(home, "campaigns", name);
  const record = await readCampaign(dir);
  if (record) {
    checkPlanUnchanged(record, plan);
    checkTargetsUnchanged(record, mapping, home);
  }
  // A run with a result.json is done. A run whose last attempt was a harness error waits for
  // --retry-errors.
  runs = runs.filter((run) => {
    const runDir = join(dir, "runs", run.id);
    if (existsSync(join(runDir, "result.json"))) return false;
    return options.has("--retry-errors") || lastAttemptStatus(runDir) !== "harness_error";
  });
  const maximum = options.get("--max-runs");
  if (typeof maximum === "string") runs = runs.slice(0, Number(maximum));
  if (runs.length === 0) {
    io.out(`Nothing left to run in campaign ${name}.\n`);
    return 0;
  }
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  if (!options.has("--allow-dirty-fixtures")) {
    await checkFixturesClean(repoRoot, [...new Set(runs.map((run) => run.task))]);
  }
  await checkFreeDisk(home);
  io.out(confirmationText(runs, planTargets(runs, targets ?? {}), await expectedMinutes(runs, resolve(import.meta.dir, "..", "tasks"))));
  if (!await askYes(io.readLine)) { io.out("Nothing ran.\n"); return 4; }
  if (!record) {
    await writeCampaign(dir, {
      plan: plan.name, plan_sha256: plan.sha256, targets: mapping,
      started_at: new Date().toISOString(), tools: await toolVersions(process.env.RELAY_BIN || "relay", repoRoot),
    });
  }
  const relay = new Relay(findRelay());
  const stop = new AbortController();
  const onInterrupt = () => { stop.abort(); };
  process.on("SIGINT", onInterrupt);
  let exitCode = 0;
  try {
    for (const run of runs) {
      if (stop.signal.aborted) {
        io.err("Stopped. This run will start again next time.\n");
        return 130;
      }
      io.out(`[${planned.indexOf(run) + 1} of ${planned.length}] ${describeRun(run, mapping)}\n`);
      const { result, limit } = await runOne({
        relay, home, campaign: name, campaignDir: dir, plan: plan.name, targets: mapping, repoRoot,
        segmentLimitMs: plan.max_minutes_per_segment * 60_000,
        allowDirtyFixtures: options.has("--allow-dirty-fixtures"), keepWork: options.has("--keep-work"),
        stop: stop.signal, out: io.out,
      }, run);
      if (result.status === "stopped_by_person") {
        io.err("Stopped. This run will start again next time.\n");
        return 130;
      }
      if (result.safety.bypass_flags_seen) {
        io.err("relay started an agent with a permission bypass flag. Stopped.\n");
        return 1;
      }
      if (limit !== null) {
        io.err(`${limit.target} reached its limit. It resets at ${limit.retryAt ?? "an unknown time"}. Run the same command again after that.\n`);
        return 5;
      }
      if (result.status === "harness_error") {
        io.err(`The harness failed on ${run.id}: ${result.notes} The run stays pending.\n`);
        exitCode = 1;
        continue;
      }
      io.out(result.status === "completed" ? `Saved result ${run.id}.\n` : `Saved result ${run.id} (${result.status}).\n`);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  return exitCode;
}

function describeRun(run: PlannedRun, targets: Record<string, string>): string {
  const from = targets[run.from]!;
  if (run.kind === "baseline") return `${run.task}, baseline on ${from}, repetition ${run.repetition}`;
  const point = run.point!.startsWith("steps:") ? `${run.point!.slice("steps:".length)}% of steps`
    : run.point === "event:first-test-run" ? "the first test run" : "an untested edit";
  return `${run.task}, handoff from ${from} to ${targets[run.to!]!} at ${point}, repetition ${run.repetition}`;
}
