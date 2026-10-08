// Every `bun run eval:handoff` command in the sh blocks of eval/handoff/README.md, except `run`,
// works as written (add-handoff-evaluation task 8.2). The commands run from the repository root
// with a temporary RELAY_EVAL_HOME that holds a targets.toml and the sample campaign
// all-rules-pass under the campaign name the README uses.
import { afterEach, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, REPO, temp } from "./helpers.ts";

afterEach(cleanup);

const README = readFileSync(join(REPO, "eval", "handoff", "README.md"), "utf8");
const CAMPAIGN = "2026-10-12-standard";

function shCommands(text: string): string[] {
  return [...text.matchAll(/^ *```sh\n([\s\S]*?)^ *```$/gm)]
    .flatMap((block) => block[1]!.split("\n").map((line) => line.trim()).filter(Boolean));
}

test("The README's sh blocks hold only harness commands, and every one except run works", async () => {
  const commands = shCommands(README);
  expect(commands.filter((line) => !line.startsWith("bun run eval:handoff "))).toEqual([]);
  const subcommands = new Set(commands.map((line) => line.split(" ")[3]));
  expect([...subcommands].sort()).toEqual(["annotate", "check-fixtures", "plan", "summarize"]);
  expect(README).toContain("bun run eval:handoff run smoke\n");

  const home = temp("eval-home");
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "codex:personal"\n');
  cpSync(join(import.meta.dir, "data", "campaigns", "all-rules-pass"), join(home, "campaigns", CAMPAIGN), { recursive: true });
  for (const command of commands) {
    const child = Bun.spawn(["sh", "-c", command], {
      cwd: REPO, env: { ...process.env, RELAY_EVAL_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ command, exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ command, exitCode: 0, stderr: "" });
    if (command.includes(" plan smoke")) expect(stdout).toContain("Plan smoke: 2 runs on claude:personal and codex:personal.\n");
  }
  expect(readFileSync(join(home, "campaigns", CAMPAIGN, "summary.md"), "utf8")).toContain(`# Handoff evaluation: ${CAMPAIGN}\n`);
  const result = JSON.parse(readFileSync(join(home, "campaigns", CAMPAIGN, "runs", "ledger-import__handoff__claude-to-codex__steps-50__r2", "result.json"), "utf8"));
  expect(result.notes).toBe("Reworked src/csv.ts for the same purpose.");
}, 180_000);
