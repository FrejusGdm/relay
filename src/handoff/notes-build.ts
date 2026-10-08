// The facts relay holds about the outgoing worker (add-relay-switch, design decision 7): when it
// worked, how it ended, which files changed and how many commits it made. They fill the From line
// of checkpoint.md, and the section relay writes when the agent did not write notes.
//
// Agents can write to .relay/events.jsonl, so these facts never come from it: how the worker
// started and ended comes from relay's own record of the worker under RELAY_HOME, or from what the
// adapter reported to the running relay process, and the files and commits come from git.
import { git } from "../git/run";
import type { Repository } from "../git/repo";
import { gitFailed, jobPrefix } from "../checkpoint/commit";
import type { FailureReason } from "../adapters/types";
import { changedJobFiles, changedPaths, checkpointHead } from "./context";

// What relay recorded itself about the worker.
export interface WorkerRecord {
  startedAt: Date | null;
  endedAt: Date | null;
  // phase 3's end_reason: exited, interrupted, relay_stopped, and this change's stopped_by_switch
  // and start_failed; null while relay knows of no end.
  endReason: string | null;
  exitCode: number | null;
  // The reason of the worker's last failed turn, as the adapter reported it to relay.
  lastFailure: FailureReason | null;
  // The number of the checkpoint that was latest when the worker started.
  startCheckpoint: number | null;
}

export interface WorkerFacts {
  startedAt: Date | null;
  endedAt: Date | null;
  howItEnded: string;
  // The commit of the start checkpoint, or null when it is unknown.
  startCheckpoint: string | null;
  filesChanged: string[];
  // The job files under .relay/ that changed in the same time, kept apart because relay's own files
  // there change at every checkpoint.
  jobFilesChanged: string[];
  commits: number;
}

const decoder = new TextDecoder();

export async function workerFacts(
  repo: Repository,
  input: { jobId: string; record: WorkerRecord; workCheckpoint: string },
): Promise<WorkerFacts> {
  const { record } = input;
  const startCheckpoint = await checkpointCommit(repo, input.jobId, record.startCheckpoint);
  return {
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    howItEnded: howItEnded(record),
    startCheckpoint,
    filesChanged: startCheckpoint === null ? [] : await changedPaths(repo, startCheckpoint, input.workCheckpoint),
    jobFilesChanged: startCheckpoint === null ? [] : await changedJobFiles(repo, startCheckpoint, input.workCheckpoint),
    commits: await commitsBetween(repo, startCheckpoint, input.workCheckpoint),
  };
}

// The first wording that applies, in the order of design decision 7.
function howItEnded(record: WorkerRecord): string {
  if (record.lastFailure === "usage_limit") return "stopped at its usage limit";
  if (record.lastFailure === "rate_limit") return "stopped at a rate limit";
  if (record.endReason === "stopped_by_switch") return "stopped by relay switch";
  if (record.endReason === "exited" && record.exitCode !== null) return `exited by itself with code ${record.exitCode}`;
  return "was stopped when its relay run ended";
}

async function checkpointCommit(repo: Repository, jobId: string, number: number | null): Promise<string | null> {
  if (number === null || !Number.isSafeInteger(number) || number < 1) return null;
  const result = await git(repo, ["rev-parse", "-q", "--verify", `${jobPrefix(jobId)}checkpoints/${number}^{commit}`]);
  return result.code === 0 ? decoder.decode(result.stdout).trim() : null;
}

// Commits from the HEAD of the start checkpoint to the HEAD of the work checkpoint; 0 when the start
// checkpoint is unknown. A start checkpoint without a HEAD counts every commit.
async function commitsBetween(repo: Repository, start: string | null, work: string): Promise<number> {
  const to = await checkpointHead(repo, work);
  if (to === null || start === null) return 0;
  const from = await checkpointHead(repo, start);
  const result = await git(repo, ["rev-list", "--count", from === null ? to : `${from}..${to}`, "--"]);
  if (result.code !== 0) throw gitFailed("relay could not count the commits", result.stderr);
  return Number(decoder.decode(result.stdout).trim());
}
