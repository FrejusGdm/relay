// The handoff commit and ref (task 5.2): a commit on the work checkpoint with the new job files,
// under refs/relay/jobs/<job>/handoffs/<n>, built with a temporary index.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { recordHandoff } from "../../src/handoff/commit";
import { captureState } from "../helpers/invariants";
import { runRelayInProcess } from "../helpers/cli";
import { FAKE_GITLEAKS, makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

let job: Job;
let work: string;
beforeEach(async () => {
  job = await makeJob();
  job.scratch.write(".relay/verify.md", "| Claim | Holds | Evidence |\n|---|---|---|\n| a | yes | b |\n");
  work = await job.save("handoff");
});
afterEach(() => job.scratch.cleanup());

const input = () => ({
  jobId: job.jobId, relayHome: job.scratch.relayHome, number: 3, workCheckpoint: { number: 2, commit: work },
  from: "claude:personal", to: "codex:personal", notesSource: "agent" as const, tests: "231 passed, 1 failed",
  files: { checkpointMd: "# Checkpoint\n", stateJson: "{}\n", eventsJsonl: "{\"id\":1}\n" },
});

test("the commit's parent, tree, message and trailers", async () => {
  const before = captureState(job.scratch.repo);
  const { ref, commit } = await recordHandoff(await job.repo(), input());
  expect(ref).toBe(`refs/relay/jobs/${job.jobId}/handoffs/3`);
  expect(job.scratch.git("rev-parse", ref).trim()).toBe(commit);
  expect(job.scratch.git("rev-parse", `${commit}^`).trim()).toBe(work);
  expect(job.scratch.git("show", `${commit}:.relay/checkpoint.md`)).toBe("# Checkpoint\n");
  expect(job.scratch.git("show", `${commit}:.relay/state.json`)).toBe("{}\n");
  expect(job.scratch.git("show", `${commit}:.relay/events.jsonl`)).toBe("{\"id\":1}\n");
  // verify.md stays in the work checkpoint and is gone from the handoff commit.
  expect(job.scratch.git("ls-tree", "-r", "--name-only", work)).toContain(".relay/verify.md");
  const files = job.scratch.git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);
  expect(files).not.toContain(".relay/verify.md");
  const changed = job.scratch.git("diff-tree", "-r", "--name-only", work, commit).split("\n").filter(Boolean).sort();
  expect(changed).toEqual([".relay/checkpoint.md", ".relay/events.jsonl", ".relay/state.json", ".relay/verify.md"]);
  expect(job.scratch.git("log", "-1", "--format=%B", commit)).toBe([
    "relay handoff 3: claude:personal to codex:personal", "", `Relay-Job: ${job.jobId}`, "Relay-Handoff: 3", "Relay-Checkpoint: 2",
    "Relay-From: claude:personal", "Relay-To: codex:personal", "Relay-Notes: agent", "Relay-Tests: 231 passed, 1 failed",
    `Relay-Version: ${(await import("../../src/core/version")).VERSION}`, "", "",
  ].join("\n"));
  expect(captureState(job.scratch.repo)).toEqual(before);
});

test("relay checkpoints does not list it, and a second create of the same ref fails", async () => {
  await recordHandoff(await job.repo(), input());
  const listed = await runRelayInProcess(["checkpoints", "--json"], {
    cwd: job.scratch.repo, relayHome: job.scratch.relayHome, env: { RELAY_GITLEAKS: FAKE_GITLEAKS },
  });
  expect(JSON.parse(listed.stdout).map((entry: { number: number }) => entry.number)).toEqual([2, 1]);
  await expect(recordHandoff(await job.repo(), input())).rejects.toThrow("relay could not record the handoff");
});
