import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { workerFacts } from "../../src/handoff/notes-build";
import { renderCheckpoint } from "../../src/handoff/render-checkpoint";
import { event, makeJob, type Job } from "./job";

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

const started = event(10, "2026-10-07T14:02:11.000Z", "worker_started", { worker_id: "5d2e8f01", target: "claude:personal", start_checkpoint: 2 });
const facts = async (events = [started], workerId = "5d2e8f01") =>
  workerFacts(await job.repo(), { jobId: job.jobId, events, workerId, workCheckpoint: work });

describe("Notes built by relay", () => {
  test("the built-notes example: 17 minutes, 2 files, 1 commit, at its usage limit", async () => {
    const result = await facts([
      started,
      event(11, "2026-10-07T14:15:00.000Z", "turn_failed", { worker_id: "5d2e8f01", reason: "usage_limit" }),
      event(12, "2026-10-07T14:19:02.000Z", "worker_ended", { worker_id: "5d2e8f01", end_reason: "stopped_by_switch", exit_code: 143 }),
    ]);
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
    ["a usage limit", [{ type: "turn_failed", reason: "usage_limit" }], "stopped at its usage limit"],
    ["a rate limit", [{ type: "turn_failed", reason: "rate_limit" }, { type: "worker_ended", end_reason: "stopped_by_switch" }], "stopped at a rate limit"],
    ["relay switch", [{ type: "turn_failed", reason: "crashed" }, { type: "worker_ended", end_reason: "stopped_by_switch" }], "stopped by relay switch"],
    ["its own exit", [{ type: "worker_ended", end_reason: "exited", exit_code: 0 }], "exited by itself with code 0"],
    ["the end of relay run", [{ type: "worker_ended", end_reason: "relay_stopped" }], "was stopped when its relay run ended"],
  ])("how it ended: %s", async (_name, extra, words) => {
    const events = [started, ...extra.map(({ type, ...data }, i) => event(20 + i, "2026-10-07T14:10:00.000Z", type, { worker_id: "5d2e8f01", ...data }))];
    expect((await facts(events)).howItEnded).toBe(words);
  });

  test("only the worker's own events count", async () => {
    const other = event(11, "2026-10-07T14:15:00.000Z", "turn_failed", { worker_id: "aaaaaaaa", reason: "usage_limit" });
    expect((await facts([started, other])).howItEnded).toBe("was stopped when its relay run ended");
  });

  test("without a start checkpoint, no files and no commits are counted", async () => {
    expect(await facts([], "5d2e8f01")).toMatchObject({ startedAt: null, endedAt: null, startCheckpoint: null, filesChanged: [], commits: 0 });
  });
});
