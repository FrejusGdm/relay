// The facts relay holds about the outgoing worker (add-relay-switch, design decision 7): when it
// worked, how it ended, which files changed and how many commits it made. They fill the From line
// of checkpoint.md, and the section relay writes when the agent did not write notes. They come
// from the event log and the repository only, so they hold no text an agent wrote.
import { git } from "../git/run";
import type { Repository } from "../git/repo";
import { gitFailed, jobPrefix } from "../checkpoint/commit";
import type { RelayEvent } from "../job/events";
import { changedPaths, checkpointHead } from "./context";

export interface WorkerFacts {
  startedAt: Date | null;
  endedAt: Date | null;
  howItEnded: string;
  // The checkpoint that was latest when the worker started, or null when it is unknown.
  startCheckpoint: string | null;
  filesChanged: string[];
  commits: number;
}

const decoder = new TextDecoder();

export async function workerFacts(
  repo: Repository,
  input: { jobId: string; events: RelayEvent[]; workerId: string; workCheckpoint: string },
): Promise<WorkerFacts> {
  const mine = input.events.filter((event) => event.data.worker_id === input.workerId);
  const started = mine.find((event) => event.type === "worker_started");
  const ended = mine.findLast((event) => event.type === "worker_ended");
  const failure = mine.findLast((event) => event.type === "turn_failed");
  const startCheckpoint = await checkpointCommit(repo, input.jobId, started?.data.start_checkpoint);
  const filesChanged = startCheckpoint === null ? [] : await changedPaths(repo, startCheckpoint, input.workCheckpoint);
  return {
    startedAt: started === undefined ? null : new Date(started.ts),
    endedAt: ended === undefined ? null : new Date(ended.ts),
    howItEnded: howItEnded(failure?.data.reason, ended?.data),
    startCheckpoint,
    filesChanged,
    commits: await commitsBetween(repo, startCheckpoint, input.workCheckpoint),
  };
}

// The first wording that applies, in the order of design decision 7.
function howItEnded(failure: unknown, ended: Record<string, unknown> | undefined): string {
  if (failure === "usage_limit") return "stopped at its usage limit";
  if (failure === "rate_limit") return "stopped at a rate limit";
  if (ended?.end_reason === "stopped_by_switch") return "stopped by relay switch";
  if (ended?.end_reason === "exited" && typeof ended.exit_code === "number") return `exited by itself with code ${ended.exit_code}`;
  return "was stopped when its relay run ended";
}

async function checkpointCommit(repo: Repository, jobId: string, number: unknown): Promise<string | null> {
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
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
