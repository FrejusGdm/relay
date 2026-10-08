// Only src/adapters/process.ts may start an agent process (design decision 5), so that every
// agent gets a chosen standard input, drained output and signals only through the held child.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ADAPTERS = join(import.meta.dir, "..", "..", "src", "adapters");
const SUPERVISOR = "process.ts";
// The same patterns as test/git/only-runner.test.ts uses for a process start.
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
  /(?<![.\w])exec(File)?(Sync)?\s*\(/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

const startsProcess = (text: string) => PROCESS_STARTS.some((pattern) => pattern.test(text));

test("no file under src/adapters/ other than process.ts starts a process", () => {
  const offenders = sourceFiles(ADAPTERS)
    .filter((file) => relative(ADAPTERS, file) !== SUPERVISOR && startsProcess(readFileSync(file, "utf8")))
    .map((file) => relative(ADAPTERS, file));
  expect(offenders).toEqual([]);
});

test("the check recognises the starts that process.ts makes", () => {
  expect(startsProcess(readFileSync(join(ADAPTERS, SUPERVISOR), "utf8"))).toBe(true);
  for (const text of ['import { spawn } from "node:child_process";', "Bun.spawn(['claude'])", "Bun.spawnSync(['codex'])", "await Bun.$`codex`"]) {
    expect(startsProcess(text)).toBe(true);
  }
});
