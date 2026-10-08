// A scratch repository with a relay job, for the handoff tests. relay init and the checkpoints use
// the fake gitleaks, so these tests run without the real scanner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "../../src/checkpoint/save";
import { openRepository, type Repository } from "../../src/git/repo";
import type { RelayEvent } from "../../src/job/events";
import { runRelayInProcess } from "../helpers/cli";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

export const FAKE_GITLEAKS = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");

export interface Job {
  scratch: ScratchRepo;
  jobId: string;
  repo(): Promise<Repository>;
  // Saves a checkpoint of the working tree and returns its commit.
  save(kind?: "manual" | "handoff"): Promise<string>;
  state(): Record<string, unknown>;
}

export async function makeJob(kind: "full" | "empty" = "full"): Promise<Job> {
  const scratch = makeScratchRepo(kind);
  const env = { RELAY_GITLEAKS: FAKE_GITLEAKS };
  const init = await runRelayInProcess(["init", "--title", "Build authentication"], { cwd: scratch.repo, relayHome: scratch.relayHome, env });
  if (init.code !== 0) throw new Error(`relay init failed: ${init.stderr}`);
  const state = () => JSON.parse(readFileSync(join(scratch.repo, ".relay", "state.json"), "utf8")) as Record<string, unknown>;
  const jobId = state().job_id as string;
  return {
    scratch, jobId, state,
    repo: () => openRepository(scratch.repo),
    async save(checkpointKind = "manual") {
      const result = await saveCheckpoint(await openRepository(scratch.repo), {
        relayHome: scratch.relayHome, command: "checkpoint", kind: checkpointKind, maxFileSizeMb: 20, env: { ...process.env, ...env },
      });
      if (!result.saved) throw new Error("nothing to save");
      return result.commit;
    },
  };
}

// An event as relay writes it, at a given time.
export function event(id: number, ts: string, type: string, data: Record<string, unknown>): RelayEvent {
  return { v: 1, id, ts, job: "3f9a2c1d", type, actor: "relay", data };
}
