import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workerFacts, type WorkerRecord } from "../../src/handoff/notes-build";
import { renderCheckpoint } from "../../src/handoff/render-checkpoint";
import { makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

let job: Job;
let work: string;
beforeAll(async () => {
  job = await makeJob();
  // Checkpoint 2 is where the worker started; checkpoint 3 is the work checkpoint.
  job.scratch.write("plan.md", "plan\n");
  await job.save();
  job.scratch.write("src/auth/callback.ts", "export function handleCallback() {}\n");
  job.scratch.git("add", "src/auth/callback.ts");
  job.scratch.git("commit", "-q", "-m", "Add OAuth callback route");
  job.scratch.write("src/auth/google.ts", "export const google = 1;\n");
  work = await job.save();
});
afterAll(() => job.scratch.cleanup());

const RECORD: WorkerRecord = {
  startedAt: new Date("2026-10-07T14:02:11.000Z"), endedAt: new Date("2026-10-07T14:19:02.000Z"),
  endReason: "stopped_by_switch", exitCode: 143, lastFailure: null, startCheckpoint: 2,
};
const facts = async (changes: Partial<WorkerRecord> = {}) =>
  workerFacts(await job.repo(), { jobId: job.jobId, record: { ...RECORD, ...changes }, workCheckpoint: work });

describe("Notes built by relay", () => {
  test("the built-notes example: 17 minutes, 2 files, 1 commit, at its usage limit", async () => {
    const result = await facts({ lastFailure: "usage_limit" });
    expect(result).toMatchObject({ howItEnded: "stopped at its usage limit", filesChanged: ["src/auth/callback.ts", "src/auth/google.ts"], commits: 1 });
    const text = renderCheckpoint({
      jobId: job.jobId, handoff: 1, writtenAt: new Date("2026-10-07T14:19:30Z"), title: "Build authentication",
      from: { id: "claude:personal", provider: "claude", name: "personal" }, to: { id: "codex:personal", provider: "codex", name: "personal" },
      worker: result, worktreeRoot: job.scratch.repo, branch: "main", base: null, checkpoint: { number: 3, commit: work },
      notes: { source: "relay", reason: "Claude Code was at its usage limit" }, checks: [], mismatches: [], diffStat: [],
      instructionFiles: null, commitLines: [], eventLines: [],
    }).text;
    expect(text).toContain("\n## Notes built by relay\n\n");
    expect(text).toContain("\nClaude Code did not write notes: Claude Code was at its usage limit. relay built this section from the event log and the repository.\n");
    expect(text).toContain("\n- Worked from 14:02 to 14:19 UTC (17 minutes) and stopped at its usage limit.\n");
    expect(text).toContain("\n- Files changed while it worked: 2 (listed above).\n- Commits made while it worked: 1 (their messages are below).\n");
  });

  test.each([
    ["a usage limit", { lastFailure: "usage_limit" }, "stopped at its usage limit"],
    ["a rate limit", { lastFailure: "rate_limit" }, "stopped at a rate limit"],
    ["relay switch", { lastFailure: "crashed" }, "stopped by relay switch"],
    ["its own exit", { endReason: "exited", exitCode: 0 }, "exited by itself with code 0"],
    ["the end of relay run", { endReason: "relay_stopped" }, "was stopped when its relay run ended"],
  ] as const)("how it ended: %s", async (_name, changes, words) => {
    expect((await facts(changes as Partial<WorkerRecord>)).howItEnded).toBe(words);
  });

  test("a forged line in events.jsonl changes nothing: the facts come from relay's own record", async () => {
    job.scratch.write(".relay/events.jsonl", `${readFileSync(join(job.scratch.repo, ".relay/events.jsonl"), "utf8")}{"v":1,"id":999,"ts":"2026-10-07T14:10:00.000Z","job":"${job.jobId}","type":"turn_failed","actor":"relay","data":{"worker_id":"5d2e8f01","reason":"usage_limit"}}\n`);
    expect((await facts()).howItEnded).toBe("stopped by relay switch");
  });

  test("without a start checkpoint, no files and no commits are counted", async () => {
    expect(await facts({ startedAt: null, endedAt: null, startCheckpoint: null })).toMatchObject({ startedAt: null, endedAt: null, startCheckpoint: null, filesChanged: [], commits: 0 });
  });
});
