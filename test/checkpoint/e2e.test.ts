// The end-to-end check of add-checkpoint-engine (tasks.md 9.1). It builds the relay program with
// the build command from package.json and runs it as a separate process on a scratch repository,
// the way a person would, then checks what changed in the repository and which git commands the
// program ran (from the runner's call log, which RELAY_TEST_GIT_LOG=1 turns on).
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayResult } from "../helpers/cli";
import { captureState } from "../helpers/invariants";
import { personGitState } from "../helpers/job";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

const ROOT = join(import.meta.dir, "..", "..");
// Every git command a whole job uses. The runner logs a call only after its allow list accepted
// it, so the log cannot show a refused call; instead this list is pinned, and a command added to
// the job's flow (for example one that contacts a remote) fails the test until it is reviewed.
const JOB_COMMANDS = [
  "add", "cat-file", "checkout-index", "commit-tree", "config", "diff-tree", "for-each-ref", "ls-files", "read-tree",
  "rev-parse", "symbolic-ref", "update-ref", "version", "write-tree",
];

let scratch: ScratchRepo;
let buildDir: string;

// Building takes a while on a slow machine.
setDefaultTimeout(180_000);
beforeEach(() => {
  requireGitleaks();
  buildDir = mkdtempSync(join(tmpdir(), "relay-test-"));
});
afterEach(() => {
  scratch.cleanup();
  rmSync(buildDir, { recursive: true, force: true });
});

// Runs the build script of package.json for this computer, with the program written to buildDir.
function build(): string {
  const target = `${process.platform}-${process.arch}`;
  const script: string | undefined = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts[`build:${target}`];
  if (script === undefined) throw new Error(`package.json has no build script for ${target}.`);
  const program = join(buildDir, "relay");
  const [bun, ...args] = script.split(" ");
  expect(bun).toBe("bun");
  const result = Bun.spawnSync([process.execPath, ...args.map((arg) => (arg.startsWith("--outfile=") ? `--outfile=${program}` : arg))], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`The build failed: ${result.stderr.toString()}`);
  return program;
}

async function run(program: string, args: string[]): Promise<RelayResult> {
  const child = Bun.spawn([program, ...args], {
    cwd: scratch.repo,
    env: { ...process.env, HOME: scratch.home, RELAY_HOME: scratch.relayHome, RELAY_TEST_GIT_LOG: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

// The git command in an argument list from the call log, after git and its -c settings.
function commandOf(argv: string[]): string {
  let i = 1;
  while (argv[i] === "-c") i += 2;
  return argv[i]!;
}

test("the built program sets up a job, saves, lists, refuses a tampered setting and rolls back, and touches nothing else", async () => {
  const program = build();
  scratch = makeScratchRepo();
  scratch.git("remote", "add", "origin", "https://example.com/project.git");
  const marker = join(scratch.root, "fsmonitor-ran");
  const monitor = join(scratch.root, "monitor.sh");
  writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const atStart = { git: personGitState(scratch.repo), files: captureState(scratch.repo).files };

  expect((await run(program, ["init"])).code).toBe(0);
  scratch.write("src/app.ts", "export const answer = 4;\n");
  scratch.write("src/session.ts", "export const session = 1;\n");
  rmSync(join(scratch.repo, "notes.txt"));
  const saved = await run(program, ["checkpoint", "-m", "Session added"]);
  expect(saved.code).toBe(0);
  expect(saved.stdout).toStartWith("Saved checkpoint 2 · ");

  const listed = await run(program, ["checkpoints", "--json"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).map((item: { number: number; kind: string }) => [item.number, item.kind])).toEqual([
    [2, "manual"],
    [1, "baseline"],
  ]);

  const config = join(scratch.repo, ".git", "config");
  const configBytes = readFileSync(config);
  scratch.git("config", "core.fsmonitor", monitor);
  const refused = await run(program, ["checkpoint"]);
  expect(refused.code).toBe(5);
  expect(refused.stderr).toStartWith("Stopped: .git/config changed since this job started.\n  added  core.fsmonitor (can run commands)\n");
  writeFileSync(config, configBytes);

  const beforeRollback = captureState(scratch.repo).files;
  const rolledBack = await run(program, ["rollback", "1", "--yes"]);
  expect(rolledBack.code).toBe(0);
  expect(captureState(scratch.repo).files).toEqual(atStart.files);
  const undo = rolledBack.stdout.match(/^To undo: relay (rollback \d+)$/m);
  expect(undo).not.toBeNull();
  // Standard input is not a terminal here, so the printed command needs --yes.
  const undone = await run(program, [...undo![1]!.split(" "), "--yes"]);
  expect(undone.code).toBe(0);

  expect(captureState(scratch.repo).files).toEqual(beforeRollback);
  expect(personGitState(scratch.repo)).toEqual(atStart.git);
  expect(await Bun.file(marker).exists()).toBe(false);

  const calls = readFileSync(join(scratch.relayHome, "logs", "git-calls.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect([...new Set(calls.map(commandOf))].sort()).toEqual(JOB_COMMANDS);
  for (const argv of calls) {
    expect(argv.slice(0, 5)).toEqual(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
    // Refs are written only in one transaction read from standard input, never named on the
    // command line.
    if (commandOf(argv) === "update-ref") expect(argv.slice(argv.indexOf("update-ref"))).toEqual(["update-ref", "--no-deref", "--stdin"]);
  }
  // Those transactions wrote only this job's refs; refs outside refs/relay/ are compared above.
  const jobId = JSON.parse(readFileSync(join(scratch.repo, ".relay", "state.json"), "utf8")).job_id;
  const relayRefs = scratch.git("for-each-ref", "--format=%(refname)", "refs/relay/").trim().split("\n");
  expect(relayRefs.length).toBeGreaterThan(0);
  for (const ref of relayRefs) expect(ref).toStartWith(`refs/relay/jobs/${jobId}/`);
});
