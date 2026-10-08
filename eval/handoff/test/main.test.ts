import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..", "..");
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const usage = `bun run eval:handoff plan <plan>
bun run eval:handoff run <plan> [--campaign <name>] [--only <run-id>] [--max-runs <n>]
                                [--retry-errors] [--keep-work] [--allow-dirty-fixtures]
bun run eval:handoff summarize <campaign>
bun run eval:handoff check-fixtures [<task-id> ...]
bun run eval:handoff annotate <campaign> <run-id> <text>\n`;

async function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "relay-eval-main-"));
  folders.push(home);
  const child = Bun.spawn([process.execPath, "run", join(repo, "eval/handoff/src/main.ts"), ...args], {
    cwd: repo, env: { ...process.env, RELAY_EVAL_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

for (const args of [["nonsense"], []]) {
  test(args.length ? "An unknown command prints usage" : "No command prints usage", async () => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(usage);
    expect(result.stdout).toBe("");
  }, 30000);
}

test("Summarize and annotate name a campaign or run that does not exist", async () => {
  const summary = await run(["summarize", "x"]);
  expect(summary.exitCode).toBe(2);
  expect(summary.stderr).toMatch(/^No campaign x in .+\/campaigns\.\n$/);
  expect(await run(["annotate", "a", "b", "c"])).toEqual({ exitCode: 2, stdout: "", stderr: "No run b in campaign a.\n" });
}, 30000);

for (const args of [["summarize"], ["summarize", "a", "b"], ["annotate", "a", "b"], ["annotate", "a", "b", "c", "d"]]) {
  test(`Wrong arguments print usage: ${args.join(" ")}`, async () => {
    expect(await run(args)).toEqual({ exitCode: 2, stdout: "", stderr: usage });
  }, 30000);
}

for (const args of [
  ["run"], ["run", "--campaign", "x"], ["run", "smoke", "--unknown"],
  ["run", "smoke", "--campaign"], ["run", "smoke", "--only"], ["run", "smoke", "--max-runs"],
  ["run", "smoke", "--campaign", "--keep-work"],
  ["run", "smoke", "--campaign", "one", "--campaign", "two"],
  ["run", "smoke", "--only", "one", "--only", "two"],
  ["run", "smoke", "--max-runs", "1", "--max-runs", "2"],
  ["run", "smoke", "--retry-errors", "--retry-errors"],
  ["run", "smoke", "--keep-work", "--keep-work"],
  ["run", "smoke", "--allow-dirty-fixtures", "--allow-dirty-fixtures"],
  ["run", "smoke", "--max-runs", "0"], ["run", "smoke", "--max-runs", "-1"],
  ["run", "smoke", "--max-runs", "1.5"], ["run", "smoke", "--max-runs", "many"],
  ["run", "smoke", "extra"],
]) {
  test(`Invalid run arguments print usage: ${args.join(" ")}`, async () => {
    expect(await run(args)).toEqual({ exitCode: 2, stdout: "", stderr: usage });
  }, 30000);
}
