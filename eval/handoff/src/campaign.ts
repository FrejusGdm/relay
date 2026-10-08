import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.ts";
import { askYes, checkFixturesClean, checkFreeDisk, confirmationText, refuseUnattended } from "./guards.ts";
import { evalHome, EvalError, expandPlan, expectedMinutes, loadPlan, loadTargets, planTargets } from "./plan.ts";
import type { CommandIO, Plan } from "./plan.ts";

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

async function version(command: string[], cwd: string): Promise<string | null> {
  try {
    const child = Bun.spawn(command, { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) return null;
    const line = (stdout.trim() || stderr.trim()).split("\n")[0] ?? "";
    return /\d+\.\d+[\w.+-]*/.exec(line)?.[0] ?? (line || null);
  } catch {
    return null;
  }
}

// `--version` starts no agent and sends nothing to a provider. A program that is missing or fails
// is recorded as null.
async function toolVersions(): Promise<CampaignRecord["tools"]> {
  const cwd = resolve(import.meta.dir, "..", "..", "..");
  let gitVersion: string | null = null;
  try {
    const result = await git(cwd, ["--version"], { allowFailure: true });
    if (result.exitCode === 0) gitVersion = result.stdout.trim().replace(/^git version /, "");
  } catch {}
  return {
    relay: await version([process.env.RELAY_BIN || "relay", "--version"], cwd),
    claude: await version(["claude", "--version"], cwd),
    codex: await version(["codex", "--version"], cwd),
    bun: Bun.version,
    git: gitVersion,
    python3: await version(["python3", "--version"], cwd),
  };
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
  const maximum = options.get("--max-runs");
  if (typeof maximum === "string") runs = runs.slice(0, Number(maximum));
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
  if (!options.has("--allow-dirty-fixtures")) {
    await checkFixturesClean(resolve(import.meta.dir, "..", "..", ".."), [...new Set(runs.map((run) => run.task))]);
  }
  await checkFreeDisk(home);
  io.out(confirmationText(runs, planTargets(runs, targets ?? {}), await expectedMinutes(runs, resolve(import.meta.dir, "..", "tasks"))));
  if (!await askYes(io.readLine)) { io.out("Nothing ran.\n"); return 4; }
  if (!record) {
    await writeCampaign(dir, {
      plan: plan.name, plan_sha256: plan.sha256, targets: mapping,
      started_at: new Date().toISOString(), tools: await toolVersions(),
    });
  }
  io.err("Not built yet.\n");
  return 1;
}
