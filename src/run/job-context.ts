// Finding the job relay run works in (add-provider-adapters, design decision 5): the repository
// that holds the current folder and its .relay/state.json, whose worktree root must be this
// checkout's. Every problem ends the command with exit code 3.
import { findJob } from "../checkpoint/save";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { openRepository, RepositoryError } from "../git/repo";
import type { JobRef } from "../job/events";
import type { JobState } from "../job/state";

export interface JobContext {
  job: JobRef;
  state: JobState;
}

export async function findJobContext(cwd: string, relayHome: string): Promise<JobContext> {
  let repo;
  try {
    repo = await openRepository(cwd);
  } catch (error) {
    if (error instanceof RepositoryError) throw new CommandError(ExitCode.NotPossibleHere, error.lines);
    throw error;
  }
  return findJob(repo, relayHome);
}
