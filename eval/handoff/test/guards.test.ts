import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPlanUnchanged, defaultCampaignName, readCampaign, writeCampaign } from "../src/campaign.ts";
import type { CampaignRecord } from "../src/campaign.ts";
import { git } from "../src/git.ts";
import { askYes, checkFixturesClean, checkFreeDisk, confirmationText, refuseUnattended } from "../src/guards.ts";
import { EvalError, expandPlan, expectedMinutes, loadPlan, planTargets } from "../src/plan.ts";

const repo = resolve(import.meta.dir, "..", "..", "..");
const main = join(repo, "eval/handoff/src/main.ts");
const plansDir = join(repo, "eval/handoff/plans");
const tasksDir = join(repo, "eval/handoff/tasks");
const targets = { claude: "claude:personal", codex: "codex:personal" };
// The tests that type yes use made-up accounts and a relay binary that does not exist, so that no
// later version of run can reach a real account from them.
const fakeTargets = { claude: "claude:eval-test", codex: "codex:eval-test" };
const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-guards-"));
  folders.push(dir);
  return dir;
}
function mappedHome(): string {
  const home = temp();
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:eval-test"\ncodex = "codex:eval-test"\n');
  return home;
}
function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RELAY_EVAL_HOME: home, RELAY_BIN: join(home, "no-relay-here") };
  delete env.CI;
  return env;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function captured(args: string[], env: NodeJS.ProcessEnv, piped = false) {
  const cmd = [process.execPath, "run", main, ...args];
  const options = { cwd: repo, env, stdout: "pipe", stderr: "pipe" } as const;
  const child = piped ? Bun.spawn(cmd, { ...options, stdin: "pipe" }) : Bun.spawn(cmd, { ...options, stdin: "ignore" });
  if (piped && child.stdin && typeof child.stdin !== "number") child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function terminalRun(args: string[], home: string, answer?: string) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, "run", main, ...args], {
    cwd: repo, env: environment(home),
    terminal: {
      cols: 120, rows: 40,
      data(_term, data) { output += decoder.decode(data, { stream: true }); },
    },
  });
  try {
    if (answer !== undefined) {
      const deadline = Date.now() + 10000;
      while (!output.includes("Type yes to start:")) {
        if (proc.exitCode !== null || Date.now() >= deadline) throw new Error(`The confirmation prompt did not appear: ${output}`);
        await Bun.sleep(20);
      }
      proc.terminal!.write(`${answer}\r`);
    }
    const exitCode = await proc.exited;
    await Bun.sleep(20);
    output += decoder.decode();
    return { exitCode, output: output.replaceAll("\r\n", "\n") };
  } finally {
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    proc.terminal!.close();
  }
}

test("Run refuses CI before looking at plans or targets", async () => {
  expect(await captured(["run", "smoke"], { ...process.env, RELAY_EVAL_HOME: temp(), CI: "true" })).toEqual({
    exitCode: 4, stdout: "", stderr: "The handoff evaluation uses real subscriptions, so it never runs in CI.\n",
  });
}, 30000);

test("Run refuses a pipe even when CI is absent", async () => {
  expect(await captured(["run", "smoke"], environment(temp()), true)).toEqual({
    exitCode: 4, stdout: "", stderr: "Run this in a terminal. The evaluation asks you to confirm before it starts.\n",
  });
}, 30000);

test("Declining confirmation creates nothing", async () => {
  const home = mappedHome();
  const result = await terminalRun(["run", "smoke", "--allow-dirty-fixtures"], home, "no");
  expect(result.exitCode).toBe(4);
  expect(result.output).toContain("to Anthropic through claude:eval-test\nand to OpenAI through codex:eval-test. The fixtures are synthetic code written for this test.");
  expect(result.output).toContain("about 35 minutes of agent time for 2 runs.");
  expect(result.output).toContain("Nothing ran.\n");
  expect(existsSync(join(home, "campaigns"))).toBe(false);
}, 30000);

test("Confirmation writes the campaign record before looking for relay", async () => {
  const home = mappedHome();
  const result = await terminalRun(["run", "smoke", "--allow-dirty-fixtures", "--campaign", "test-campaign"], home, "yes");
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain("relay was not found. Build it first or set RELAY_BIN.");
  const dir = join(home, "campaigns", "test-campaign");
  const record = await readCampaign(dir);
  expect(record).not.toBeNull();
  expect(record?.plan).toBe("smoke");
  expect(record?.plan_sha256).toBe(new Bun.CryptoHasher("sha256").update(await Bun.file(join(plansDir, "smoke.toml")).arrayBuffer()).digest("hex"));
  expect(record?.targets).toEqual(fakeTargets);
  expect(Number.isNaN(Date.parse(record!.started_at))).toBe(false);
  expect(record?.tools.bun).toBe(Bun.version);
  expect(record?.tools.relay).toBeNull();
  expect(record?.tools.claude).toBeNull();
  expect(record?.tools.codex).toBeNull();
  expect(readFileSync(join(dir, "campaign.json"), "utf8")).toBe(`${JSON.stringify(record, null, 2)}\n`);
}, 30000);

test("A changed plan refuses before asking for confirmation", async () => {
  const home = mappedHome();
  await writeCampaign(join(home, "campaigns", "old"), {
    plan: "smoke", plan_sha256: "0", targets: fakeTargets, started_at: new Date().toISOString(),
    tools: { bun: Bun.version, git: null, python3: null },
  });
  const result = await terminalRun(["run", "smoke", "--campaign", "old", "--allow-dirty-fixtures"], home);
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain("The plan smoke changed since this campaign started. Start a new campaign with --campaign <name>.");
  expect(result.output).not.toContain("Type yes to start:");
}, 30000);

test("Only and max-runs affect the confirmation but every account of the plan is recorded", async () => {
  const home = mappedHome();
  const result = await terminalRun([
    "run", "smoke", "--only", "rate-limiter__baseline__claude__r1", "--max-runs", "1",
    "--campaign", "selected", "--allow-dirty-fixtures", "--retry-errors", "--keep-work",
  ], home, "yes");
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain("about 15 minutes of agent time for 1 run.");
  expect(result.output).not.toContain("OpenAI");
  expect((await readCampaign(join(home, "campaigns", "selected")))?.targets).toEqual(fakeTargets);
}, 30000);

test("Resuming with different accounts refuses before asking for confirmation", async () => {
  const home = mappedHome();
  const plan = await loadPlan("smoke", plansDir);
  await writeCampaign(join(home, "campaigns", "old"), {
    plan: "smoke", plan_sha256: plan.sha256, targets: { claude: "claude:eval-test", codex: "codex:other-test" },
    started_at: new Date().toISOString(), tools: { bun: Bun.version },
  });
  const result = await terminalRun(["run", "smoke", "--campaign", "old", "--allow-dirty-fixtures"], home);
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain(`The accounts in ${home}/targets.toml changed since this campaign started. Start a new campaign with --campaign <name>.`);
  expect(result.output).not.toContain("Type yes to start:");
}, 30000);

for (const [label, text] of [["broken JSON", "{"], ["an empty object", "{}"], ["a list", "[]"]] as const) {
  test(`A campaign.json with ${label} gives a plain message`, async () => {
    const home = mappedHome();
    const dir = join(home, "campaigns", "old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "campaign.json"), text);
    const result = await terminalRun(["run", "smoke", "--campaign", "old", "--allow-dirty-fixtures"], home);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain(`${join(dir, "campaign.json")} is not valid: `);
    expect(result.output).not.toContain(" at ");
    expect(result.output).not.toContain("changed since this campaign started");
  }, 30000);
}

test("Unknown run IDs and invalid campaign names refuse before confirmation", async () => {
  const home = mappedHome();
  const missing = await terminalRun(["run", "smoke", "--only", "missing", "--allow-dirty-fixtures"], home);
  expect(missing.exitCode).toBe(2);
  expect(missing.output).toContain("No run missing in plan smoke.");
  const invalid = await terminalRun(["run", "smoke", "--campaign", "../escape", "--allow-dirty-fixtures"], home);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.output).toContain("The campaign name ../escape can only use letters, digits, dots, hyphens and underscores.");
  expect(existsSync(join(home, "campaigns"))).toBe(false);
}, 30000);

test("Fixture cleanliness is checked through git", async () => {
  const dir = temp();
  await git(dir, ["init", "-b", "main"]);
  const fixture = join(dir, "eval", "handoff", "tasks", "demo");
  mkdirSync(fixture, { recursive: true });
  const path = join(fixture, "a.txt");
  writeFileSync(path, "Original.\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "Fixture for cleanliness test"]);
  await checkFixturesClean(dir, ["demo"]);
  writeFileSync(join(dir, ".gitignore"), "settings.local.json\n");
  await git(dir, ["add", ".gitignore"]);
  await git(dir, ["commit", "-m", "Ignore local settings"]);
  const local = join(fixture, ".start", ".claude", "settings.local.json");
  mkdirSync(join(fixture, ".start", ".claude"), { recursive: true });
  writeFileSync(local, '{ "permissions": { "allow": ["Bash(*)"] } }\n');
  await expect(checkFixturesClean(dir, ["demo"])).rejects.toThrow("The fixture demo has uncommitted changes.");
  rmSync(join(fixture, ".start"), { recursive: true });
  await checkFixturesClean(dir, ["demo"]);
  writeFileSync(path, "Changed.\n");
  try {
    await checkFixturesClean(dir, ["demo"]);
    throw new Error("The dirty fixture unexpectedly passed.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).exitCode).toBe(3);
    expect((error as EvalError).message).toBe("The fixture demo has uncommitted changes. Commit them so results can be traced to a version, or pass --allow-dirty-fixtures.");
  }
  const outside = temp();
  try {
    await checkFixturesClean(outside, ["demo"]);
    throw new Error("The non-repository unexpectedly passed.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).exitCode).toBe(3);
    expect((error as EvalError).message).toStartWith("Could not check the fixtures for uncommitted changes: ");
  }
}, 30000);

test("Disk checks use an existing ancestor without creating the requested path", async () => {
  const dir = temp();
  await checkFreeDisk(dir);
  const path = join(dir, "not-created", "campaign");
  try {
    await checkFreeDisk(path, Number.MAX_SAFE_INTEGER);
    throw new Error("The impossible disk minimum unexpectedly passed.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).exitCode).toBe(3);
    expect((error as EvalError).message).toBe(`Less than 1 GB free in ${path}. Free space before running.`);
  }
  expect(existsSync(join(dir, "not-created"))).toBe(false);
}, 30000);

test("Confirmation text groups accounts by company and preserves the trailing space", async () => {
  const standard = await loadPlan("standard", plansDir);
  const runs = expandPlan(standard, targets, "/eval-home");
  expect(confirmationText(runs, planTargets(runs, targets), await expectedMinutes(runs, tasksDir))).toBe(
    "This campaign sends the fixture repositories to Anthropic through claude:personal\nand to OpenAI through codex:personal. The fixtures are synthetic code written for this test.\nIt uses your real subscription limits: about 25 hours of agent time for 60 runs.\nType yes to start: ",
  );
  const full = await loadPlan("full", plansDir);
  const mapping = { ...targets, claude_second: "claude:startup" };
  const fullRuns = expandPlan(full, mapping, "/eval-home");
  expect(confirmationText(fullRuns, planTargets(fullRuns, mapping), 4104)).toContain("Anthropic through claude:personal and claude:startup");
  expect(confirmationText(runs.slice(0, 1), ["other:work"], 25)).toBe(
    "This campaign sends the fixture repositories to other through other:work. The fixtures are synthetic code written for this test.\nIt uses your real subscription limits: about 25 minutes of agent time for 1 run.\nType yes to start: ",
  );
});

test("Only the trimmed lowercase word yes confirms", async () => {
  for (const line of ["yes", " yes \t"]) expect(await askYes(async () => line)).toBe(true);
  for (const line of [null, "", "no", "Yes", "YES", "yes please"]) expect(await askYes(async () => line)).toBe(false);
  expect(() => refuseUnattended({ CI: "" }, true)).toThrow("The handoff evaluation uses real subscriptions, so it never runs in CI.");
  expect(() => refuseUnattended({}, false)).toThrow("Run this in a terminal. The evaluation asks you to confirm before it starts.");
  refuseUnattended({}, true);
});

test("Campaign names use local dates and existing records round trip", async () => {
  expect(defaultCampaignName("smoke", new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02-smoke");
  const dir = join(temp(), "campaign");
  expect(await readCampaign(dir)).toBeNull();
  const plan = await loadPlan("smoke", plansDir);
  const record: CampaignRecord = {
    plan: plan.name, plan_sha256: plan.sha256, targets, started_at: new Date().toISOString(),
    tools: { bun: Bun.version, git: null, python3: null },
  };
  await writeCampaign(dir, record);
  expect(await readCampaign(dir)).toEqual(record);
  checkPlanUnchanged(record, plan);
});
