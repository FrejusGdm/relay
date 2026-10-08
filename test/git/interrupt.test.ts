import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, stopGitProcesses } from "../../src/git/run";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "git-interrupt", "run-git.ts");
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let scratch: ScratchRepo;
let pidFile: string;

// A clean filter that records its process ID and then hangs, so `git add` never finishes.
beforeEach(() => {
  scratch = makeScratchRepo();
  pidFile = join(scratch.root, "filter.pid");
  const filter = join(scratch.root, "slow-filter.sh");
  writeFileSync(filter, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
  scratch.write(".gitattributes", "notes.txt filter=slow\n");
  scratch.git("config", "filter.slow.clean", filter);
});
afterEach(() => {
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {}
  }
  scratch.cleanup();
});

async function filterPid(): Promise<number> {
  for (let i = 0; i < 250 && !existsSync(pidFile); i++) await Bun.sleep(20);
  const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
  expect(text).not.toBe("");
  return Number(text);
}

function processGroup(pid: number): number {
  return Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

test("on SIGINT, a relay process stops the git process group it started, filter included", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", FIXTURE, scratch.repo, join(scratch.root, "tmp.index")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = await filterPid();
  const group = processGroup(pid);
  expect(group).toBeGreaterThan(0);
  expect(group).not.toBe(processGroup(process.pid));
  expect(group).not.toBe(child.pid);

  child.kill("SIGINT");
  expect(await child.exited).toBe(130);
  expect(await gone(pid)).toBe(true);
  expect(await gone(-group)).toBe(true);
});

test("stopGitProcesses ends a running git call in the same process", async () => {
  const running = git(scratch.repo, ["add", "-A"], { indexFile: join(scratch.root, "tmp.index") });
  const pid = await filterPid();
  const group = processGroup(pid);
  await stopGitProcesses();
  const result = await running;
  expect(result.code).not.toBe(0);
  expect(await gone(pid)).toBe(true);
  expect(await gone(-group)).toBe(true);
});

test("a program a filter leaves in the background is stopped, and git's call returns without waiting for it", async () => {
  // The background sleep keeps git's standard error open after git has finished.
  const backgroundPidFile = join(scratch.root, "background.pid");
  const filter = join(scratch.root, "background-filter.sh");
  writeFileSync(filter, `#!/bin/sh\nsleep 30 > /dev/null &\necho $! > '${backgroundPidFile}'\nexec cat\n`, { mode: 0o755 });
  scratch.git("config", "filter.slow.clean", filter);
  const started = Date.now();
  const result = await git(scratch.repo, ["add", "-A"], { indexFile: join(scratch.root, "tmp.index"), timeoutMs: 20_000 });
  expect(result.code).toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
  const background = Number(readFileSync(backgroundPidFile, "utf8"));
  const group = processGroup(background);
  try {
    expect(await gone(background)).toBe(true);
    expect(group === 0 || (await gone(-group))).toBe(true);
  } finally {
    try {
      process.kill(background, "SIGKILL");
    } catch {}
  }
});

test("main.ts stops git processes on SIGINT, on SIGTERM and before a normal exit", () => {
  const text = readFileSync(MAIN, "utf8");
  expect(text).toContain('process.on("SIGINT", () => stop("SIGINT"');
  expect(text).toContain('process.on("SIGTERM", () => stop("SIGTERM"');
  expect(text).toMatch(/await stopGitProcesses\(\);\n {2}process\.exit\(code\);/);
  expect(text).toMatch(/await stopGitProcesses\(\);\nprocess\.exit\(interruptedCode \?\? code\);\s*$/);
});
