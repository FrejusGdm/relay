import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { git } from "./git.ts";
import { aboutTime, EvalError } from "./plan.ts";
import type { PlannedRun } from "./plan.ts";

export function refuseUnattended(env: NodeJS.ProcessEnv, stdinIsTTY: boolean): void {
  if (env.CI !== undefined) throw new EvalError("The handoff evaluation uses real subscriptions, so it never runs in CI.", 4);
  if (!stdinIsTTY) throw new EvalError("Run this in a terminal. The evaluation asks you to confirm before it starts.", 4);
}

export async function checkFixturesClean(repoRoot: string, taskIds: string[]): Promise<void> {
  for (const task of taskIds) {
    let output: string;
    try {
      const result = await git(resolve(repoRoot), ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", `eval/handoff/tasks/${task}`], { allowFailure: true });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim());
      output = result.stdout;
    } catch (error) {
      throw new EvalError(`Could not check the fixtures for uncommitted changes: ${error instanceof Error ? error.message : String(error)}`, 3);
    }
    if (output.trim() !== "") {
      throw new EvalError(`The fixture ${task} has uncommitted changes. Commit them so results can be traced to a version, or pass --allow-dirty-fixtures.`, 3);
    }
  }
}

export async function checkFreeDisk(path: string, minimumKilobytes = 1024 * 1024): Promise<void> {
  let folder = resolve(path);
  while (true) {
    try {
      if ((await stat(folder)).isDirectory()) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
    const parent = dirname(folder);
    if (parent === folder) throw new EvalError(`Could not find an existing folder for ${path}.`, 3);
    folder = parent;
  }
  let available: number;
  try {
    const child = Bun.spawn(["df", "-Pk", folder], {
      cwd: folder, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim());
    const column = stdout.trim().split(/\r?\n/)[1]?.trim().split(/\s+/)[3];
    available = column === undefined ? NaN : Number(column);
    if (!Number.isFinite(available)) throw new Error("df did not report available space.");
  } catch (error) {
    throw new EvalError(`Could not check free disk space in ${path}: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  if (available < minimumKilobytes) throw new EvalError(`Less than 1 GB free in ${path}. Free space before running.`, 3);
}

export function confirmationText(runs: PlannedRun[], targets: string[], minutes: number): string {
  const companies = new Map<string, string[]>();
  for (const target of targets) {
    const provider = target.split(":")[0]!;
    const company = provider === "claude" ? "Anthropic" : provider === "codex" ? "OpenAI" : provider;
    const accounts = companies.get(company) ?? [];
    accounts.push(target);
    companies.set(company, accounts);
  }
  const lines = [...companies].map(([company, accounts], index) => {
    const list = accounts.length < 2 ? accounts.join("") : `${accounts.slice(0, -1).join(", ")} and ${accounts.at(-1)}`;
    return `${index === 0 ? "This campaign sends the fixture repositories to" : "and to"} ${company} through ${list}`;
  });
  return `${lines.join("\n")}. The fixtures are synthetic code written for this test.\nIt uses your real subscription limits: ${aboutTime(minutes)} of agent time for ${runs.length} ${runs.length === 1 ? "run" : "runs"}.\nType yes to start: `;
}

export async function askYes(readLine: () => Promise<string | null>): Promise<boolean> {
  return (await readLine())?.trim() === "yes";
}
