// Context tiers 0 and 1 of a handoff (add-relay-switch, design decision 8): the diff since the job
// started, the commits made since then, and the recent relevant events, each read from git or the
// event log. relay never reads a provider transcript or anything in a profile folder.
import { gitFailed } from "../checkpoint/commit";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import type { RelayEvent } from "../job/events";
import { accountLabel, displayName } from "./account";
import { removeInvisible } from "../text/invisible";
import { resultText, type CheckResult } from "./checks";

const RELEVANT = new Set([
  "worker_started", "worker_ended", "turn_failed", "command_ran", "checkpoint_saved", "checkpoint_refused", "rollback",
  "handoff_notes", "check_run", "handoff", "handoff_failed", "verification_recorded",
]);
const EVENT_LIMIT = 20;
const FIELD_WIDTH = 120;
const OUTCOMES: CheckResult["outcome"][] = ["passed", "failed", "timed_out", "could_not_start"];
const STAT_LINES = 60;
const COMMIT_LIMIT = 20;
// Paths are compared without the job files, which change at every checkpoint.
const WITHOUT_JOB_FILES = ["--", ".", ":(exclude).relay"];

const decoder = new TextDecoder();

async function read(repo: Repository, args: string[], what: string): Promise<string> {
  const result = await git(repo, args, {});
  if (result.code !== 0) throw gitFailed(`relay could not read ${what}`, result.stderr);
  return decoder.decode(result.stdout);
}

// The tree a diff starts from: the job's base commit, or the empty tree in a repository that had no
// commit when the job started.
async function baseTree(repo: Repository, base: string | null): Promise<string> {
  return base ?? (await read(repo, ["hash-object", "-t", "tree", "/dev/null"], "the empty tree")).trim();
}

// The HEAD that a checkpoint recorded in its Relay-Head trailer, or null when there was none.
export async function checkpointHead(repo: Repository, commit: string): Promise<string | null> {
  const value = (await read(repo, ["log", "-1", "--format=%(trailers:key=Relay-Head,valueonly,separator=)", commit], "a checkpoint")).trim();
  return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

// The paths that differ between two commits, without .relay/.
export async function changedPaths(repo: Repository, from: string, to: string): Promise<string[]> {
  const output = await read(repo, ["diff", "--name-only", "-z", "--no-renames", from, to, ...WITHOUT_JOB_FILES], "the changed files");
  return output.split("\0").filter((path) => path !== "");
}

// The job files under .relay/ that differ between two commits, such as .relay/task.md when an agent
// edited it.
export async function changedJobFiles(repo: Repository, from: string, to: string): Promise<string[]> {
  const output = await read(repo, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ".relay"], "the changed job files");
  return output.split("\0").filter((path) => path !== "");
}

// git diff --stat from the job's base to the work checkpoint, at most 60 lines.
export async function diffStat(repo: Repository, base: string | null, work: string): Promise<string[]> {
  const output = await read(repo, ["diff", "--stat", "--no-renames", await baseTree(repo, base), work, ...WITHOUT_JOB_FILES], "the diff");
  return output.split("\n").filter((line) => line !== "").slice(0, STAT_LINES);
}

// How many files changed from the job's base to the work checkpoint, and the lines added and
// removed (binary files count as files only).
export async function diffNumbers(repo: Repository, base: string | null, work: string): Promise<{ files: number; added: number; removed: number }> {
  const output = await read(repo, ["diff", "--numstat", "--no-renames", await baseTree(repo, base), work, ...WITHOUT_JOB_FILES], "the diff");
  const numbers = { files: 0, added: 0, removed: 0 };
  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (match === null) continue;
    numbers.files++;
    numbers.added += match[1] === "-" ? 0 : Number(match[1]);
    numbers.removed += match[2] === "-" ? 0 : Number(match[2]);
  }
  return numbers;
}

// "<short hash> <subject>" for the newest 20 commits from the job's base to the work checkpoint's
// HEAD, newest first. The subjects were written by agents.
export async function commitLines(repo: Repository, base: string | null, work: string): Promise<string[]> {
  const head = await checkpointHead(repo, work);
  if (head === null) return [];
  const range = base === null ? [head] : [`${base}..${head}`];
  const output = await read(repo, ["log", `-n${COMMIT_LIMIT}`, "--format=%h %s", ...range, "--"], "the commits");
  return output.split("\n").filter((line) => line !== "");
}

// The newest 20 relevant events, oldest first, one line each. Agents can write to the event log,
// so every value taken from an event is flattened to one line, cleaned and cut, and these lines go
// inside the fence in checkpoint.md.
export function eventLines(events: RelayEvent[]): string[] {
  const targets = new Map<string, string>();
  for (const event of events) {
    if (event.type === "worker_started") targets.set(flat(event.data.worker_id), flat(event.data.target));
  }
  const targetOf = (id: unknown) => targets.get(flat(id));
  return events
    .filter((event) => RELEVANT.has(event.type) && typeof event.data === "object" && event.data !== null)
    .slice(-EVENT_LIMIT)
    .map((event) => `- ${eventTime(event.ts)} ${eventText(event, targetOf)}`);
}

export function hhmm(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function eventTime(ts: unknown): string {
  const date = new Date(typeof ts === "string" ? ts : Number.NaN);
  return Number.isNaN(date.getTime()) ? "--:--" : hhmm(date);
}

// One line of at most 120 characters: line breaks and runs of white space become one space, and
// control and invisible characters are removed.
function flat(value: unknown): string {
  const text = removeInvisible(String(value)).text.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").trim();
  const characters = Array.from(text);
  return characters.length > FIELD_WIDTH ? `${characters.slice(0, FIELD_WIDTH).join("")}...` : text;
}

function label(target: string | undefined): string {
  const match = /^(claude|codex):([a-z0-9][a-z0-9-]{0,31})$/.exec(target ?? "");
  return match === null ? "an agent" : accountLabel({ provider: match[1] as "claude" | "codex", name: match[2]! });
}

const END_WORDS: Record<string, string> = {
  stopped_by_switch: "stopped by relay switch",
  relay_stopped: "was stopped when its relay run ended",
  interrupted: "was interrupted",
  start_failed: "did not start",
};

function eventText(event: RelayEvent, targetOf: (workerId: unknown) => string | undefined): string {
  const data = event.data;
  const workerLabel = (id: unknown) => label(targetOf(id));
  switch (event.type) {
    case "worker_started":
      return `${label(flat(data.target))} started (worker ${flat(data.worker_id)})`;
    case "worker_ended": {
      const words = END_WORDS[flat(data.end_reason)]
        ?? (typeof data.exit_code === "number" ? `exited with code ${data.exit_code}` : `exited (${flat(data.signal)})`);
      return `${workerLabel(data.worker_id)} ${words}`;
    }
    case "turn_failed":
      return `a turn of ${workerLabel(data.worker_id)} failed (${flat(data.reason)})`;
    case "command_ran":
      return `ran \`${flat(data.command)}\`${typeof data.exit_code === "number" ? `, exit code ${data.exit_code}` : ""}`;
    case "checkpoint_saved":
      return `saved checkpoint ${flat(data.number)} (${flat(data.kind)})`;
    case "checkpoint_refused":
      return `relay refused to save a checkpoint (${flat(data.reason)})`;
    case "rollback":
      return `rolled back to checkpoint ${flat(data.to_checkpoint)}`;
    case "handoff_notes": {
      const provider = /^(claude|codex):/.exec(targetOf(data.from_worker_id) ?? "")?.[1] as "claude" | "codex" | undefined;
      const name = provider === undefined ? "The agent" : displayName(provider);
      return data.outcome === "received" ? `${name} wrote handoff notes` : `relay built the handoff notes: ${flat(data.reason)}`;
    }
    case "check_run":
      return `relay ran \`${flat(data.command)}\`: ${flat(resultText(checkFromEvent(data)))}`;
    case "handoff":
      return `handoff ${flat(data.number)} from ${flat(data.from_target)} to ${flat(data.to_target)}`;
    case "handoff_failed":
      return `the handoff to ${flat(data.to_target)} stopped at the step ${flat(data.step)}`;
    case "verification_recorded":
      return `.relay/verify.md for handoff ${flat(data.handoff)}: ${flat(data.yes)} yes, ${flat(data.no)} no, ${flat(data.unclear)} unclear`;
    default:
      return flat(event.type);
  }
}

function checkFromEvent(data: Record<string, unknown>): CheckResult {
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const passed = number(data.passed);
  const failed = number(data.failed);
  return {
    command: String(data.command),
    outcome: OUTCOMES.includes(data.outcome as CheckResult["outcome"]) ? (data.outcome as CheckResult["outcome"]) : "failed",
    exitCode: number(data.exit_code), signal: typeof data.signal === "string" ? data.signal : null,
    seconds: number(data.seconds) ?? 0,
    counts: passed === null || failed === null ? null : { passed, failed, skipped: number(data.skipped) ?? 0 },
    logPath: "", excerpt: [], changedFiles: [], timeoutSeconds: number(data.seconds) ?? 0, ranAt: new Date(0),
    error: "the shell did not start",
  };
}
