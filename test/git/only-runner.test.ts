// Only src/git/run.ts may start git (design.md decision 8). Two checks hold this: at run time, the
// guard program test/fixtures/fake-provider/guard-bin/git stops any git process that does not come
// from the runner or a test helper; and this test reads every source file and fails if another one
// both can start processes and names git as a command, or sets the variable that passes the guard.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "../../src/git/run";
import { GIT_GUARD_PASS } from "../helpers/scratch-repo";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const RUNNER = "git/run.ts";
const GUARD_VARIABLE = Object.keys(GIT_GUARD_PASS)[0]!;
// Only these may name the variable that passes the guard: the runner, the preload that removes it,
// the helpers that build scratch repositories, and the evaluation harness's git runner, which is a
// separate program whose tests run under the same preload.
const MAY_PASS_GUARD = ["src/git/run.ts", "test/setup.ts", "test/helpers/", "eval/handoff/src/git.ts"];

const PROCESS_STARTS = [
  /\bspawn(Sync)?\b/,
  /child_process/,
  /\bexeca\b/,
  /\$\s*`/,
  /\bBun\s*\[/,
  /\bBun\s*\.\s*\$/,
  /import\s*\*\s*as\s+\w+\s+from\s*["']bun["']/,
  /\bgetBuiltinModule\b/,
  /\bcreateRequire\b/,
  // exec("...") after destructuring; a regular expression's .exec( is not a process start.
  /(?<![.\w])exec(File)?(Sync)?\s*\(/,
];
const GIT_COMMAND = [
  // A string that is the git program ("git", "/usr/bin/git") or a command line starting with it.
  /(["'`])(?:[^"'`\s]*\/)?git(?:\1|\s)/,
  // git after a shell separator, as in "cd src && git status" or sh -c "git status".
  /(?:&&|\|\||[;|(]|-c\s+["'`]?)\s*git\b/,
  // The name built from pieces, as in "g" + "it".
  /["'`](?:g|gi)["'`]\s*\+/,
];

function startsGit(text: string): boolean {
  return PROCESS_STARTS.some((pattern) => pattern.test(text)) && GIT_COMMAND.some((pattern) => pattern.test(text));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

test("no source file other than src/git/run.ts starts git", () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => relative(SRC, file) !== RUNNER && startsGit(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
  expect(offenders).toEqual([]);
});

test("only the runners, the preload and the test helpers name the variable that passes the git guard", () => {
  const offenders = [...sourceFiles(SRC), ...sourceFiles(join(ROOT, "test")), ...sourceFiles(join(ROOT, "eval"))]
    .map((file) => relative(ROOT, file))
    .filter((file) => !MAY_PASS_GUARD.some((allowed) => file.startsWith(allowed)))
    .filter((file) => readFileSync(join(ROOT, file), "utf8").includes(GUARD_VARIABLE));
  expect(offenders).toEqual([]);
  expect(GUARD_VARIABLE).toBe(readFileSync(join(SRC, RUNNER), "utf8").match(/env\.(\w+) = "1";/)![1]!);
});

test("the preload removes the variable that passes the git guard", () => {
  expect(process.env[GUARD_VARIABLE]).toBeUndefined();
});

test("the runner itself is found by the check", () => {
  expect(startsGit(readFileSync(join(SRC, RUNNER), "utf8"))).toBe(true);
});

test.each([
  'Bun.spawn(["git", "status"])',
  "Bun.spawnSync({ cmd: ['git', 'status'] })",
  'const program = "git";\nBun.spawn([program, "status"]);',
  'Bun.spawn(["/usr/bin/git", "status"])',
  "await Bun.$`git status`",
  'import { $ } from "bun";\nawait $`git status`;',
  'import { spawn } from "bun";\nspawn(["git", "log"]);',
  'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);',
  'const cp = require("child_process");\ncp.execSync("git status");',
  'const { exec } = await import("node:child_process");\nexec("git status");',
  'import { execa } from "execa";\nawait execa("git", ["status"]);',
  'const { spawn } = Bun;\nspawn(["git", "status"]);',
  'Bun["spawn"](["git", "status"]);',
  'import * as B from "bun";\nB.spawn(["git", "status"]);',
  'Bun.spawn(["sh", "-c", "cd src && git status"]);',
  "await Bun.$`cd ${dir} && git status`;",
  'Bun.spawn(["g" + "it", "status"]);',
  'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("child_process").execSync("git status");',
  'process.getBuiltinModule("node:child_process").execFileSync("git", ["status"]);',
])("finds a git process start: %p", (text) => {
  expect(startsGit(text)).toBe(true);
});

test.each([
  'Bun.spawn(["claude", "--version"])',
  'const note = "run git status yourself";',
  'Bun.spawn([codex, "exec"]);\nconst folder = ".git";',
  'import { git } from "../git/run";\nawait git(repo, ["status"]);',
  'const match = /^git version (\\S+)/.exec(output);\nthrow new Error(`git rev-parse failed`);',
])("ignores code that does not start git: %p", (text) => {
  expect(startsGit(text)).toBe(false);
});

test("at run time, a git process that does not come from the runner is stopped", () => {
  const folder = mkdtempSync(join(process.env.HOME!, "guard-"));
  const result = Bun.spawnSync(["git", "init", "-q"], { cwd: folder, stderr: "pipe" });
  expect(result.exitCode).toBe(97);
  expect(result.stderr.toString()).toBe(
    `Tests must not start git directly. Use git() from src/git/run.ts, or a test helper that sets ${GUARD_VARIABLE}=1.\n`,
  );
  expect(readdirSync(folder)).toEqual([]);
});

test("at run time, the runner's git process passes the guard", async () => {
  expect(Bun.which("git")).toBe(join(import.meta.dir, "..", "fixtures", "fake-provider", "guard-bin", "git"));
  const result = await git(process.env.HOME!, ["version"]);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toStartWith("git version ");
});
