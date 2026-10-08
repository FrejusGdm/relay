import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadFixture } from "./fixtures.ts";

export class EvalError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export interface Plan {
  name: string;
  path: string;
  sha256: string;
  repetitions: number;
  max_minutes_per_segment: number;
  baseline_roles: string[];
  handoffs: { task: string; from: string; to: string; points: string[]; optional: boolean }[];
}

export interface PlannedRun {
  id: string;
  kind: "baseline" | "handoff";
  task: string;
  repetition: number;
  from: string;
  to: string | null;
  point: string | null;
}

export interface CommandIO {
  usage: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

export function evalHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_EVAL_HOME || join(homedir(), ".relay-eval");
}

export async function loadPlan(nameOrPath: string, plansDir: string): Promise<Plan> {
  const isPath = nameOrPath.includes("/") || nameOrPath.endsWith(".toml");
  const path = isPath ? resolve(nameOrPath) : resolve(plansDir, `${nameOrPath}.toml`);
  const file = Bun.file(path);
  if (!await file.exists()) {
    throw new EvalError(isPath ? `No plan file ${path}.` : `No plan ${nameOrPath} in ${plansDir}.`, 2);
  }
  const bytes = await file.arrayBuffer();
  const invalid = (reason: string): never => {
    throw new EvalError(`The plan file ${path} is not valid: ${reason}.`, 2);
  };
  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return invalid("could not parse TOML");
  }
  if (typeof data.name !== "string" || data.name.trim() === "") invalid("name must be a non-empty string");
  for (const field of ["repetitions", "max_minutes_per_segment"]) {
    const value = data[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      invalid(`${field} must be a whole number above 0`);
    }
  }
  const role = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);
  if (!Array.isArray(data.baseline_roles) || data.baseline_roles.length === 0 || !data.baseline_roles.every(role)) {
    invalid("baseline_roles must be a non-empty list of role names");
  }
  const baselineRoles = data.baseline_roles as string[];
  if (new Set(baselineRoles).size !== baselineRoles.length) invalid("baseline_roles must contain distinct role names");
  if (!Array.isArray(data.handoffs) || data.handoffs.length === 0) invalid("handoffs must be a non-empty list");
  const handoffs = (data.handoffs as unknown[]).map((value, index) => {
    const prefix = `handoff ${index + 1}`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${prefix} must be a table`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.task !== "string" || !/^[a-z0-9-]+$/.test(entry.task)) {
      invalid(`${prefix} task must be a fixture name made of lower-case letters, digits and hyphens`);
    }
    if (!role(entry.from) || !role(entry.to)) invalid(`${prefix} from and to must be role names`);
    if (entry.from === entry.to) invalid(`${prefix} from and to must be different`);
    if (!baselineRoles.includes(entry.from as string)) {
      invalid(`${prefix} starts from the role ${entry.from as string}, which baseline_roles does not list`);
    }
    const point = (item: unknown) => {
      if (item === "event:first-test-run" || item === "event:untested-edit") return true;
      if (typeof item !== "string" || !/^steps:\d+$/.test(item)) return false;
      const percent = Number(item.slice(6));
      return Number.isInteger(percent) && percent >= 1 && percent <= 99;
    };
    if (!Array.isArray(entry.points) || entry.points.length === 0 || !entry.points.every(point)) {
      invalid(`${prefix} points must be a non-empty list of steps from 1 to 99 or supported events`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") invalid(`${prefix} optional must be a boolean`);
    return {
      task: entry.task as string, from: entry.from as string, to: entry.to as string,
      points: entry.points as string[], optional: (entry.optional ?? false) as boolean,
    };
  });
  const seen = new Set<string>();
  for (const [index, { task, from, to, points }] of handoffs.entries()) {
    for (const point of points) {
      const key = `${task} ${from} ${to} ${point}`;
      if (seen.has(key)) invalid(`handoff ${index + 1} repeats the ${task} handoff from ${from} to ${to} at ${point}`);
      seen.add(key);
    }
  }
  return {
    name: data.name as string, path, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    repetitions: data.repetitions as number, max_minutes_per_segment: data.max_minutes_per_segment as number,
    baseline_roles: baselineRoles, handoffs,
  };
}

export async function loadTargets(home: string): Promise<Record<string, string> | null> {
  const path = join(home, "targets.toml");
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  const invalid = (reason: string): never => { throw new EvalError(`${path} is not valid: ${reason}.`, 2); };
  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  } catch {
    return invalid("could not parse TOML");
  }
  const targets: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [role, value] of Object.entries(data)) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9-]*:[^\s:]+$/.test(value)) {
      invalid(`${role} must name an account as provider:account`);
    }
    targets[role] = value as string;
  }
  return targets;
}

function mapped(targets: Record<string, string> | null, role: string): boolean {
  return targets !== null && Object.hasOwn(targets, role);
}

export function expandPlan(plan: Plan, targets: Record<string, string> | null, home: string): PlannedRun[] {
  const handoffs = plan.handoffs.filter((entry) => !entry.optional || (mapped(targets, entry.from) && mapped(targets, entry.to)));
  for (const role of [...plan.baseline_roles, ...handoffs.flatMap((entry) => [entry.from, entry.to])]) {
    if (!mapped(targets, role)) {
      throw new EvalError(`The plan uses the role ${role}, but ${join(home, "targets.toml")} does not map it to an account.`, 3);
    }
  }
  const tasks = [...new Set(handoffs.map((entry) => entry.task))];
  const runs: PlannedRun[] = [];
  for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
    for (const task of tasks) {
      for (const from of plan.baseline_roles) {
        runs.push({ id: `${task}__baseline__${from}__r${repetition}`, kind: "baseline", task, repetition, from, to: null, point: null });
      }
    }
  }
  for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
    for (const { task, from, to, points } of handoffs) {
      for (const point of points) {
        runs.push({ id: `${task}__handoff__${from}-to-${to}__${point.replaceAll(":", "-")}__r${repetition}`, kind: "handoff", task, repetition, from, to, point });
      }
    }
  }
  return runs;
}

export async function expectedMinutes(runs: PlannedRun[], tasksDir: string): Promise<number> {
  const minutes = new Map<string, number>();
  for (const task of new Set(runs.map((run) => run.task))) {
    if (!existsSync(join(tasksDir, task, "task.toml"))) {
      throw new EvalError(`The plan names the task ${task}, but ${tasksDir} has no fixture with that name.`, 2);
    }
    try {
      minutes.set(task, (await loadFixture(tasksDir, task)).expected_agent_minutes);
    } catch (error) {
      throw new EvalError(error instanceof Error ? error.message : String(error), 2);
    }
  }
  return runs.reduce((sum, run) => sum + minutes.get(run.task)! * (run.kind === "handoff" ? 1.2 : 1), 0);
}

export function aboutTime(minutes: number): string {
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `about ${rounded} minutes`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function planTargets(runs: PlannedRun[], targets: Record<string, string>): string[] {
  const roles = runs.flatMap((run) => run.to === null ? [run.from] : [run.from, run.to]);
  return [...new Set(roles.map((role) => targets[role]!))];
}

export async function planCommand(args: string[], io: CommandIO): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) { io.err(`${io.usage}\n`); return 2; }
  const home = evalHome();
  const plan = await loadPlan(args[0]!, resolve(import.meta.dir, "..", "plans"));
  const targets = await loadTargets(home);
  const runs = expandPlan(plan, targets, home);
  const accounts = planTargets(runs, targets ?? {});
  const list = accounts.length < 2 ? accounts.join("") : `${accounts.slice(0, -1).join(", ")} and ${accounts.at(-1)}`;
  const baselines = runs.filter((run) => run.kind === "baseline").length;
  const handoffs = runs.length - baselines;
  const split = accounts.length === 2 ? ", split between both accounts" : accounts.length > 2 ? `, split between the ${accounts.length} accounts` : "";
  const time = aboutTime(await expectedMinutes(runs, resolve(import.meta.dir, "..", "tasks")));
  io.out(`Plan ${plan.name}: ${runs.length} ${runs.length === 1 ? "run" : "runs"} on ${list}.\n`);
  io.out(`${baselines} ${baselines === 1 ? "baseline" : "baselines"} and ${handoffs} ${handoffs === 1 ? "handoff" : "handoffs"}, ${plan.repetitions} ${plan.repetitions === 1 ? "repetition" : "repetitions"} each.\n`);
  io.out(`Expected agent time: ${time}${split}.\n`);
  io.out("This uses your real subscription limits. Nothing has run.\n");
  return 0;
}
