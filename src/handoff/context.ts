// Context tiers 0 and 1 of a handoff (add-relay-switch, design decision 8): the diff since the job
// started, the commits made since then, and the recent relevant events, each read from git or the
// event log. relay never reads a provider transcript or anything in a profile folder.
import { gitFailed } from "../checkpoint/commit";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import type { RelayEvent } from "../job/events";
import { accountLabel, displayName } from "./account";
import { resultText, type CheckResult } from "./checks";

const RELEVANT = new Set([
  "worker_started", "worker_ended", "turn_failed", "command_ran", "checkpoint_saved", "checkpoint_refused", "rollback",
  "handoff_notes", "check_run", "handoff", "handoff_failed", "verification_recorded",
]);
const EVENT_LIMIT = 20;
const COMMAND_WIDTH = 120;
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

// git diff --stat from the job's base to the work checkpoint, at most 60 lines.
export async function diffStat(repo: Repository, base: string | null, work: string): Promise<string[]> {
  const output = await read(repo, ["diff", "--stat", "--no-renames", await baseTree(repo, base), work, ...WITHOUT_JOB_FILES], "the diff");
  return output.split("\n").filter((line) => line !== "").slice(0, STAT_LINES);
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

// The newest 20 relevant events, oldest first, one line each. Command lines were chosen by agents,
// so these lines go inside the fence in checkpoint.md.
export function eventLines(events: RelayEvent[]): string[] {
  const targets = new Map<string, string>();
  for (const event of events) {
    if (event.type === "worker_started") targets.set(String(event.data.worker_id), String(event.data.target));
  }
  const targetOf = (id: unknown) => targets.get(String(id));
  return events
    .filter((event) => RELEVANT.has(event.type))
    .slice(-EVENT_LIMIT)
    .map((event) => `- ${hhmm(new Date(event.ts))} ${eventText(event, targetOf)}`);
}

export function hhmm(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function label(target: string | undefined): string {
  const match = /^(claude|codex):(.+)$/.exec(target ?? "");
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
      return `${label(String(data.target))} started (worker ${data.worker_id})`;
    case "worker_ended": {
      const words = END_WORDS[String(data.end_reason)]
        ?? (data.exit_code === null || data.exit_code === undefined ? `exited (${data.signal})` : `exited with code ${data.exit_code}`);
      return `${workerLabel(data.worker_id)} ${words}`;
    }
    case "turn_failed":
      return `a turn of ${workerLabel(data.worker_id)} failed (${data.reason})`;
    case "command_ran":
      return `ran \`${cut(String(data.command))}\`${typeof data.exit_code === "number" ? `, exit code ${data.exit_code}` : ""}`;
    case "checkpoint_saved":
      return `saved checkpoint ${data.number} (${data.kind})`;
    case "checkpoint_refused":
      return `relay refused to save a checkpoint (${data.reason})`;
    case "rollback":
      return `rolled back to checkpoint ${data.to_checkpoint}`;
    case "handoff_notes": {
      const provider = /^(claude|codex):/.exec(targetOf(data.from_worker_id) ?? "")?.[1] as "claude" | "codex" | undefined;
      const name = provider === undefined ? "The agent" : displayName(provider);
      return data.outcome === "received" ? `${name} wrote handoff notes` : `relay built the handoff notes: ${data.reason}`;
    }
    case "check_run":
      return `relay ran \`${cut(String(data.command))}\`: ${resultText(checkFromEvent(data))}`;
    case "handoff":
      return `handoff ${data.number} from ${data.from_target} to ${data.to_target}`;
    case "handoff_failed":
      return `the handoff to ${data.to_target} stopped at the step ${data.step}`;
    case "verification_recorded":
      return `.relay/verify.md for handoff ${data.handoff}: ${data.yes} yes, ${data.no} no, ${data.unclear} unclear`;
    default:
      return event.type;
  }
}

function cut(command: string): string {
  const characters = Array.from(command.replace(/\s+/g, " "));
  return characters.length > COMMAND_WIDTH ? `${characters.slice(0, COMMAND_WIDTH).join("")}...` : characters.join("");
}

function checkFromEvent(data: Record<string, unknown>): CheckResult {
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const passed = number(data.passed);
  const failed = number(data.failed);
  return {
    command: String(data.command), outcome: data.outcome as CheckResult["outcome"],
    exitCode: number(data.exit_code), signal: typeof data.signal === "string" ? data.signal : null,
    seconds: number(data.seconds) ?? 0,
    counts: passed === null || failed === null ? null : { passed, failed, skipped: number(data.skipped) ?? 0 },
    logPath: "", excerpt: [], changedFiles: [], timeoutSeconds: number(data.seconds) ?? 0,
    error: "the shell did not start",
  };
}
