import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aboutTime, evalHome, EvalError, expandPlan, expectedMinutes, loadPlan, loadTargets, planTargets } from "../src/plan.ts";

const plansDir = resolve(import.meta.dir, "..", "plans");
const tasksDir = resolve(import.meta.dir, "..", "tasks");
const targets = { claude: "claude:personal", codex: "codex:personal" };
const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-plan-"));
  folders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cases = [
  { name: "smoke", second: false, count: 2, minutes: 33, time: "about 35 minutes", first: "rate-limiter__baseline__claude__r1", last: "rate-limiter__handoff__claude-to-codex__steps-50__r1" },
  { name: "standard", second: false, count: 60, minutes: 1512, time: "about 25 hours", first: "ledger-import__baseline__claude__r1", last: "markdown-toc__handoff__codex-to-claude__steps-75__r3" },
  { name: "full", second: false, count: 144, minutes: 3780, time: "about 63 hours", first: "ledger-import__baseline__claude__r1", last: "markdown-toc__handoff__codex-to-claude__event-untested-edit__r3" },
  { name: "full", second: true, count: 156, minutes: 4104, time: "about 68 hours", first: "ledger-import__baseline__claude__r1", last: "markdown-toc__handoff__claude-to-claude_second__steps-50__r3" },
];

for (const item of cases) {
  test(`${item.name}${item.second ? " with a second Claude account" : ""} has stable runs, order and expected time`, async () => {
    const plan = await loadPlan(item.name, plansDir);
    const mapping = item.second ? { ...targets, claude_second: "claude:startup" } : targets;
    const runs = expandPlan(plan, mapping, "/eval-home");
    const ids = runs.map((run) => run.id);
    expect(runs.length).toBe(item.count);
    expect(ids[0]).toBe(item.first);
    expect(ids.at(-1)).toBe(item.last);
    expect(new Set(ids).size).toBe(ids.length);
    expect(expandPlan(plan, mapping, "/eval-home").map((run) => run.id)).toEqual(ids);
    const firstHandoff = runs.findIndex((run) => run.kind === "handoff");
    expect(runs.slice(0, firstHandoff).every((run) => run.kind === "baseline")).toBe(true);
    expect(runs.slice(firstHandoff).every((run) => run.kind === "handoff")).toBe(true);
    for (const kind of ["baseline", "handoff"] as const) {
      const group = runs.filter((run) => run.kind === kind);
      for (let repetition = 2; repetition <= plan.repetitions; repetition++) {
        const first = group.findIndex((run) => run.repetition === repetition);
        const last = group.findLastIndex((run) => run.repetition === repetition - 1);
        expect(first).toBeGreaterThan(last);
      }
    }
    const minutes = await expectedMinutes(runs, tasksDir);
    expect(minutes).toBeCloseTo(item.minutes);
    expect(aboutTime(minutes)).toBe(item.time);
    if (item.name === "standard") {
      expect(ids).toContain("ledger-import__handoff__claude-to-codex__steps-50__r2");
      expect(runs.filter((run) => run.kind === "baseline").length).toBe(24);
      expect(runs.filter((run) => run.kind === "handoff").length).toBe(36);
    }
  });
}

test("The first required role without an account is reported", async () => {
  const plan = await loadPlan("standard", plansDir);
  for (const [mapping, role] of [[null, "claude"], [{ claude: "claude:personal" }, "codex"]] as const) {
    try {
      expandPlan(plan, mapping, "/eval-home");
      throw new Error("The plan unexpectedly expanded.");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).exitCode).toBe(3);
      expect((error as EvalError).message).toBe(`The plan uses the role ${role}, but /eval-home/targets.toml does not map it to an account.`);
    }
  }
});

test("Optional entries do not require their unmapped roles", async () => {
  const plan = await loadPlan("smoke", plansDir);
  plan.handoffs.push({ task: "unused", from: "absent", to: "claude", points: ["steps:50"], optional: true });
  const runs = expandPlan(plan, targets, "/eval-home");
  expect(runs.length).toBe(2);
  expect(runs.some((run) => run.task === "unused")).toBe(false);
});

test("Only the distinct accounts of the selected runs are listed, in role order", async () => {
  const plan = await loadPlan("full", plansDir);
  const mapping = { ...targets, claude_second: "claude:startup", unused: "other:work" };
  const runs = expandPlan(plan, mapping, "/eval-home");
  expect(planTargets(runs, mapping)).toEqual(["claude:personal", "codex:personal", "claude:startup"]);
  expect(planTargets(runs.filter((run) => run.from === "codex" && run.to === null), mapping)).toEqual(["codex:personal"]);
  expect(planTargets(runs, { ...mapping, claude_second: "claude:personal" })).toEqual(["claude:personal", "codex:personal"]);
});

test("A fixture with a broken task.toml is reported with exit code 2", async () => {
  const dir = temp();
  mkdirSync(join(dir, "broken"));
  writeFileSync(join(dir, "broken", "task.toml"), 'id = "broken"\n');
  const plan = await loadPlan("smoke", plansDir);
  plan.handoffs[0]!.task = "broken";
  try {
    await expectedMinutes(expandPlan(plan, targets, "/eval-home"), dir);
    throw new Error("The plan unexpectedly expanded.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).exitCode).toBe(2);
    expect((error as EvalError).message).toBe("Fixture broken: task.toml has no title.");
  }
});

test("A plan that names a task without a fixture is rejected with exit code 2", async () => {
  const plan = await loadPlan("smoke", plansDir);
  plan.handoffs[0]!.task = "no-such-task";
  try {
    await expectedMinutes(expandPlan(plan, targets, "/eval-home"), tasksDir);
    throw new Error("The plan unexpectedly expanded.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).exitCode).toBe(2);
    expect((error as EvalError).message).toBe(`The plan names the task no-such-task, but ${tasksDir} has no fixture with that name.`);
  }
});

const valid = `name = "test"
repetitions = 1
max_minutes_per_segment = 120
baseline_roles = ["claude"]

[[handoffs]]
task = "rate-limiter"
from = "claude"
to = "codex"
points = ["steps:50"]
`;

for (const [label, text] of [
  ["invalid point", valid.replace("steps:50", "steps:0")],
  ["missing handoffs", valid.split("[[handoffs]]")[0]!],
  ["invalid TOML", 'name = "unfinished'],
  ["empty name", valid.replace('name = "test"', 'name = ""')],
  ["fractional repetitions", valid.replace("repetitions = 1", "repetitions = 1.5")],
  ["zero time cap", valid.replace("max_minutes_per_segment = 120", "max_minutes_per_segment = 0")],
  ["duplicate baselines", valid.replace('["claude"]', '["claude", "claude"]')],
  ["invalid role", valid.replace('to = "codex"', 'to = "Codex"')],
  ["same roles", valid.replace('to = "codex"', 'to = "claude"')],
  ["empty points", valid.replace('["steps:50"]', "[]")],
  ["invalid optional flag", `${valid}optional = "yes"\n`],
  ["start role without baselines", valid.replace('baseline_roles = ["claude"]', 'baseline_roles = ["codex"]')],
  ["repeated point", valid.replace('["steps:50"]', '["steps:50", "steps:50"]')],
  ["repeated handoff entry", `${valid}\n[[handoffs]]\ntask = "rate-limiter"\nfrom = "claude"\nto = "codex"\npoints = ["steps:25", "steps:50"]\n`],
  ["task path", valid.replace('task = "rate-limiter"', 'task = "../tasks/job-queue"')],
  ["upper-case task", valid.replace('task = "rate-limiter"', 'task = "Rate-limiter"')],
] as const) {
  test(`A plan with ${label} is rejected with exit code 2`, async () => {
    const path = join(temp(), "invalid.toml");
    writeFileSync(path, text);
    try {
      await loadPlan(path, plansDir);
      throw new Error("The invalid plan unexpectedly loaded.");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).exitCode).toBe(2);
      expect((error as EvalError).message.startsWith(`The plan file ${path} is not valid: `)).toBe(true);
    }
  });
}

test("Plan hashes cover the bytes and path arguments resolve against the working directory", async () => {
  const plan = await loadPlan("eval/handoff/plans/smoke.toml", plansDir);
  expect(plan.path).toBe(join(plansDir, "smoke.toml"));
  const bytes = await Bun.file(plan.path).arrayBuffer();
  expect(plan.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  expect(plan.handoffs[0]?.optional).toBe(false);
  const missing = join(temp(), "missing.toml");
  await expect(loadPlan(missing, plansDir)).rejects.toThrow(`No plan file ${missing}.`);
});

test("Targets can be absent, mapped or invalid", async () => {
  const home = temp();
  expect(await loadTargets(home)).toBeNull();
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "codex:personal"\n');
  expect(await loadTargets(home)).toEqual(targets);
  for (const value of ['"codex"', '"codex:two:accounts"', '"codex:has space"', "3", "{}", '""']) {
    writeFileSync(join(home, "targets.toml"), `codex = ${value}\n`);
    try {
      await loadTargets(home);
      throw new Error("The invalid targets unexpectedly loaded.");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).exitCode).toBe(2);
      expect((error as EvalError).message).toBe(`${home}/targets.toml is not valid: codex must name an account as provider:account.`);
    }
  }
  writeFileSync(join(home, "targets.toml"), 'claude = "');
  await expect(loadTargets(home)).rejects.toThrow(`${home}/targets.toml is not valid: could not parse TOML.`);
});

test("Evaluation home and time wording follow the supplied values", () => {
  expect(evalHome({ RELAY_EVAL_HOME: "/custom-eval" })).toBe("/custom-eval");
  expect(evalHome({})).toBe(join(homedir(), ".relay-eval"));
  expect(aboutTime(33)).toBe("about 35 minutes");
  expect(aboutTime(1512)).toBe("about 25 hours");
  expect(aboutTime(59)).toBe("about 1 hour");
  expect(aboutTime(60)).toBe("about 1 hour");
  expect(aboutTime(0)).toBe("about 5 minutes");
});
