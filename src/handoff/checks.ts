// Runs the job's checks at a handoff (add-relay-switch, design decision 9). Each check runs as
// /bin/sh -c "<command>" in the worktree root, with standard input at end of file, in a process
// group of its own, without provider credential variables, and with a time limit. Its whole output
// goes to a private log; only a cleaned excerpt of a failed check reaches checkpoint.md.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRemovedVariable } from "../accounts/environment";
import { buildSnapshotTree } from "../checkpoint/snapshot";
import { gitFailed } from "../checkpoint/commit";
import { onInterrupt, wasInterrupted } from "../core/cleanup";
import { printable } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { redactEnvValues } from "../secrets/redact";
import { removeInvisible } from "../text/invisible";
import { parseCounts, type Counts } from "./check-parsers";
import { makePrivateFolder } from "./files";
import type { CheckSetting } from "./settings";

export interface CheckResult {
  command: string;
  outcome: "passed" | "failed" | "timed_out" | "could_not_start";
  exitCode: number | null;
  signal: string | null;
  seconds: number;
  counts: Counts | null;
  logPath: string;
  // Failed and timed-out checks only: the last 30 lines of output, cleaned.
  excerpt: string[];
  // Set on the last check only, for the whole run.
  changedFiles: string[];
  timeoutSeconds: number;
  error?: string;
}

interface CheckRun {
  repo: Repository;
  jobId: string;
  relayHome: string;
  handoff: number;
  checks: CheckSetting[];
  // The person's environment. Secret-looking values in it are redacted from the excerpts.
  env: Record<string, string | undefined>;
  // Credential variables the person's accounts name in credential_env; checks never get them.
  credentialNames: string[];
  // For the snapshot trees before and after the checks, as for a checkpoint.
  maxFileBytes: number;
  approvedPaths: string[];
}

const KILL_AFTER_MS = 5000;
const EXCERPT_LINES = 30;
const EXCERPT_WIDTH = 200;
const KEPT_HANDOFFS = 20;
// The output read back for the counts and the excerpt: the end of the log.
const READ_BACK_BYTES = 1024 * 1024;
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export async function runChecks(run: CheckRun): Promise<CheckResult[]> {
  const folder = join(run.relayHome, "logs", "checks");
  makePrivateFolder(folder);
  const results: CheckResult[] = [];
  if (run.checks.length > 0) {
    const before = await snapshot(run);
    const env = checkEnv(run.env, run.credentialNames);
    for (const [index, check] of run.checks.entries()) {
      if (wasInterrupted()) break;
      const logPath = join(folder, `${run.jobId}-h${run.handoff}-${index + 1}.log`);
      results.push(await runOne(run, check, env, logPath));
    }
    const after = await snapshot(run);
    const last = results.at(-1);
    if (last !== undefined) last.changedFiles = await changedFiles(run.repo, before, after);
  }
  removeOldLogs(folder, run.jobId);
  return results;
}

// The words relay uses for a result everywhere: in checkpoint.md, the prompt and the progress line.
export function resultText(result: CheckResult): string {
  const counts = result.counts === null ? null
    : `${result.counts.passed} passed, ${result.counts.failed} failed${result.counts.skipped > 0 ? `, ${result.counts.skipped} skipped` : ""}`;
  switch (result.outcome) {
    case "passed":
      return counts ?? "passed";
    case "failed": {
      const how = result.exitCode !== null ? ` (exit code ${result.exitCode})` : result.signal !== null ? ` (stopped by ${result.signal})` : "";
      return `${counts ?? "failed"}${how}`;
    }
    case "timed_out":
      return `did not finish in ${result.timeoutSeconds} ${result.timeoutSeconds === 1 ? "second" : "seconds"}`;
    case "could_not_start":
      return `could not start: ${result.error}`;
  }
}

function checkEnv(base: Record<string, string | undefined>, credentialNames: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    // relay's own variables, such as RELAY_HOME, tell a program where relay keeps its files.
    if (value === undefined || name.startsWith("RELAY_") || isRemovedVariable(name) || credentialNames.includes(name)) continue;
    env[name] = value;
  }
  return { ...env, RELAY_CHECK: "1", CI: "1", NO_COLOR: "1" };
}

async function runOne(run: CheckRun, check: CheckSetting, env: Record<string, string>, logPath: string): Promise<CheckResult> {
  const result: CheckResult = {
    command: check.command, outcome: "could_not_start", exitCode: null, signal: null, seconds: 0, counts: null,
    logPath, excerpt: [], changedFiles: [], timeoutSeconds: check.timeout_seconds,
  };
  rmSync(logPath, { force: true });
  const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const started = performance.now();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // Standard output and standard error share the log file, so their lines stay in order.
    child = Bun.spawn(["/bin/sh", "-c", check.command], {
      cwd: run.repo.worktreeRoot, env, stdin: "ignore", stdout: log, stderr: log, detached: true,
    });
  } catch (error) {
    closeSync(log);
    result.error = printable((error as Error).message);
    return result;
  }
  closeSync(log);
  const group = child.pid;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    signalGroup(group, "SIGTERM");
    killTimer ??= setTimeout(() => signalGroup(group, "SIGKILL"), KILL_AFTER_MS);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, check.timeout_seconds * 1000);
  const forget = onInterrupt(stop);
  await child.exited;
  clearTimeout(timeout);
  forget();
  // A program the check left running in the background is stopped with it.
  await endGroup(group);
  clearTimeout(killTimer);

  result.seconds = Math.round((performance.now() - started) / 1000);
  result.signal = child.signalCode ?? null;
  result.exitCode = child.exitCode;
  result.outcome = timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed";
  const output = readEnd(logPath);
  result.counts = parseCounts(output);
  if (result.outcome !== "passed") result.excerpt = excerpt(output, run.env);
  return result;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function endGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, 0)) return;
  signalGroup(pid, "SIGTERM");
  for (let waited = 0; signalGroup(pid, 0) && waited < 1000; waited += 20) await Bun.sleep(20);
  signalGroup(pid, "SIGKILL");
}

function readEnd(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - READ_BACK_BYTES);
    const buffer = Buffer.alloc(size - start);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, start + length);
      if (read === 0) break;
      length += read;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

// The last 30 lines, without escape sequences, control characters other than tab, or invisible
// characters, with secret values from the environment replaced, each cut to 200 characters. The
// output is cleaned and redacted whole before it is split, so a value that spans lines, or one
// broken up by colour codes, is still found.
function excerpt(output: string, env: Record<string, string | undefined>): string[] {
  const plain = removeInvisible(output.replace(ESCAPES, "").replace(/\r\n?/g, "\n")).text.replace(/(?![\t\n])\p{Cc}/gu, "");
  const lines = redactEnvValues(plain, env).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-EXCERPT_LINES).map((line) => Array.from(line).slice(0, EXCERPT_WIDTH).join(""));
}

async function snapshot(run: CheckRun): Promise<string> {
  const { tree } = await buildSnapshotTree(run.repo, {
    jobId: run.jobId, relayHome: run.relayHome, maxFileBytes: run.maxFileBytes, approved: run.approvedPaths,
  });
  return tree;
}

async function changedFiles(repo: Repository, before: string, after: string): Promise<string[]> {
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", before, after, "--", ".", ":(exclude).relay"]);
  if (result.code !== 0) throw gitFailed("relay could not compare the files before and after the checks", result.stderr);
  return Buffer.from(result.stdout).toString("utf8").split("\0").filter((path) => path !== "");
}

// Keeps the logs of the newest 20 handoffs of the job.
function removeOldLogs(folder: string, jobId: string): void {
  const pattern = new RegExp(`^${jobId}-h([1-9][0-9]*)-[1-9][0-9]*\\.log$`);
  const names = readdirSync(folder).flatMap((name) => {
    const handoff = pattern.exec(name)?.[1];
    return handoff === undefined ? [] : [{ name, handoff: Number(handoff) }];
  });
  const kept = new Set([...new Set(names.map((entry) => entry.handoff))].sort((a, b) => b - a).slice(0, KEPT_HANDOFFS));
  for (const entry of names) if (!kept.has(entry.handoff)) rmSync(join(folder, entry.name), { force: true });
}
