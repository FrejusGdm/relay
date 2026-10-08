import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..", "..");
const plansDir = join(repo, "eval", "handoff", "plans");
const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-plan-command-"));
  folders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], home: string) {
  const child = Bun.spawn([process.execPath, "run", join(repo, "eval/handoff/src/main.ts"), "plan", ...args], {
    cwd: repo, env: { ...process.env, RELAY_EVAL_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("The standard plan preview matches the golden text", async () => {
  const home = temp();
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "codex:personal"\n');
  const result = await run(["standard"], home);
  expect(result).toEqual({
    exitCode: 0, stdout: await Bun.file(join(import.meta.dir, "golden", "plan-standard.txt")).text(), stderr: "",
  });
}, 30000);

test("A preview without targets reports the first missing role", async () => {
  const home = temp();
  expect(await run(["standard"], home)).toEqual({
    exitCode: 3, stdout: "", stderr: `The plan uses the role claude, but ${home}/targets.toml does not map it to an account.\n`,
  });
}, 30000);

test("A missing named plan reports its plan directory", async () => {
  expect(await run(["nope"], temp())).toEqual({ exitCode: 2, stdout: "", stderr: `No plan nope in ${plansDir}.\n` });
}, 30000);

for (const args of [[], ["smoke", "standard"], ["--help"]]) {
  test(`Plan requires exactly one plan name: ${args.join(" ") || "none given"}`, async () => {
    const result = await run(args, temp());
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("bun run eval:handoff plan <plan>\n");
  }, 30000);
}

test("Smoke uses singular counts and one account has no split wording", async () => {
  const home = temp();
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "claude:personal"\n');
  expect(await run(["smoke"], home)).toEqual({
    exitCode: 0, stderr: "",
    stdout: "Plan smoke: 2 runs on claude:personal.\n1 baseline and 1 handoff, 1 repetition each.\nExpected agent time: about 35 minutes.\nThis uses your real subscription limits. Nothing has run.\n",
  });
}, 30000);

test("Full lists three accounts in role order", async () => {
  const home = temp();
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "codex:personal"\nclaude_second = "claude:startup"\n');
  expect(await run(["full"], home)).toEqual({
    exitCode: 0, stderr: "",
    stdout: "Plan full: 156 runs on claude:personal, codex:personal and claude:startup.\n24 baselines and 132 handoffs, 3 repetitions each.\nExpected agent time: about 68 hours, split between the 3 accounts.\nThis uses your real subscription limits. Nothing has run.\n",
  });
}, 30000);
