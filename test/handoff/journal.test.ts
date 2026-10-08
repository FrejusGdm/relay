// Recovery after a crash (task 5.3): a journal left at each step by a process that is gone is
// cleaned up, and a journal of a live process stops the command with exit code 6.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { recordHandoff } from "../../src/handoff/commit";
import { writeHandoffRecord, readHandoffRecord, type HandoffRecord } from "../../src/handoff/handoff-record";
import { journalPath, recoverSwitch, writeJournal, type Journal, type JournalStep } from "../../src/handoff/journal";
import { readEvents } from "../../src/job/events";
import { processStartTime } from "../../src/run/control";
import { makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

let job: Job;
let work: string;
let deadPid: number;
beforeEach(async () => {
  job = await makeJob();
  job.scratch.write("src/work.ts", "work\n");
  work = await job.save("handoff");
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  deadPid = gone.pid;
});
afterEach(() => job.scratch.cleanup());

const relayDir = () => join(job.scratch.repo, ".relay");
const jobRef = () => ({ id: job.jobId, worktreeRoot: job.scratch.repo, relayHome: job.scratch.relayHome });
const ref = `refs/relay/jobs/`;

function journal(step: JournalStep, extra: Partial<Journal> = {}): Journal {
  const value: Journal = {
    schema_version: 1, pid: deadPid, process_started_at: "Thu Jan 1 00:00:00 2026", started_at: new Date().toISOString(),
    to_account: "codex:personal", handoff_number: 1, step, checkpoint_commit: work, checkpoint_number: 2,
    backup_dir: null, handoff_ref: null, ...extra,
  };
  writeJournal(job.scratch.relayHome, job.jobId, value);
  return value;
}

function record(): HandoffRecord {
  return {
    number: 1, created_at: new Date().toISOString(), from_account: "claude:work", to_account: "codex:personal",
    checkpoint: { number: 2, commit: work, reused: false, tree: "" }, handoff_ref: `${ref}${job.jobId}/handoffs/1`, handoff_commit: "",
    prompt_path: "", notes_source: "relay", notes_reason: null, claims_count: 0, mismatches: [], checks: [], confirmations: [],
    instruction_files_changed: [], to_worker_id: null, outcome: "prepared", start_error: null, start: { mode: "interactive", permission: null },
  };
}

const message = (commit: string) => `The last switch to Codex · personal did not finish. relay cleaned it up. Your work is saved in checkpoint ${commit.slice(0, 6)}.`;

async function recover(): Promise<string | null> {
  return recoverSwitch(await job.repo(), jobRef());
}

function lastEvent() {
  return readEvents(jobRef()).at(-1)!;
}

describe("A journal left by a process that is gone", () => {
  test.each(["stopped", "checkpoint_saved"] as const)("at %s: the checkpoint is kept and handoff_failed is appended", async (step) => {
    journal(step);
    expect(await recover()).toBe(message(work));
    expect(lastEvent()).toMatchObject({ type: "handoff_failed", data: { step, reason: "relay stopped during the switch", kept_checkpoint: 2 } });
    expect(JSON.parse(readFileSync(join(relayDir(), "state.json"), "utf8")).current_worker).toBeNull();
    expect(existsSync(journalPath(job.scratch.relayHome, job.jobId))).toBe(false);
  });

  test("at files_written: the job files come back and the unrecorded ref is deleted", async () => {
    const backup = join(job.scratch.relayHome, "jobs", job.jobId, "handoffs", "1", "backup");
    mkdirSync(backup, { recursive: true });
    for (const name of ["checkpoint.md", "state.json"]) copyFileSync(join(relayDir(), name), join(backup, name));
    writeFileSync(join(backup, ".verify-missing"), "");
    const before = { checkpoint: readFileSync(join(relayDir(), "checkpoint.md"), "utf8") };
    writeFileSync(join(relayDir(), "checkpoint.md"), "new\n");
    writeFileSync(join(relayDir(), "verify.md"), "new\n");
    const made = await recordHandoff(await job.repo(), {
      jobId: job.jobId, relayHome: job.scratch.relayHome, number: 1, workCheckpoint: { number: 2, commit: work }, from: "claude:work",
      to: "codex:personal", notesSource: "relay", tests: "none", files: { checkpointMd: "new\n", stateJson: "{}\n", eventsJsonl: "" },
    });
    journal("files_written", { backup_dir: backup, handoff_ref: made.ref });
    expect(await recover()).toBe(message(work));
    expect(readFileSync(join(relayDir(), "checkpoint.md"), "utf8")).toBe(before.checkpoint);
    expect(existsSync(join(relayDir(), "verify.md"))).toBe(false);
    expect(job.scratch.git("for-each-ref", `${ref}${job.jobId}/handoffs/`)).toBe("");
    expect(existsSync(backup)).toBe(false);
    expect(lastEvent()).toMatchObject({ type: "handoff_failed", data: { step: "files_written" } });
  });

  test.each(["handoff_recorded", "starting"] as const)("at %s: everything is kept and the handoff is marked start_failed", async (step) => {
    writeHandoffRecord(job.scratch.relayHome, job.jobId, record());
    journal(step);
    expect(await recover()).toContain("relay cleaned it up");
    expect(readHandoffRecord(job.scratch.relayHome, job.jobId, 1)?.outcome).toBe("start_failed");
    expect(lastEvent()).toMatchObject({ type: "handoff_failed", data: { step } });
  });

  test("a process ID that now belongs to another program counts as gone", async () => {
    // Process 1 runs, but it started at another time than the journal records.
    journal("stopped", { pid: 1, process_started_at: "Thu Jan 1 00:00:00 2026" });
    expect(await recover()).toContain("relay cleaned it up");
  });

  test("no journal: nothing to do", async () => {
    expect(await recover()).toBeNull();
  });
});

test("a journal of a process that still runs stops the command with exit code 6", async () => {
  const live = Bun.spawn(["sleep", "30"]);
  try {
    await Bun.sleep(100);
    journal("checkpoint_saved", { pid: live.pid, process_started_at: processStartTime(live.pid) });
    const error = await recover().then(() => null, (caught) => caught as CommandError);
    expect([error?.code, error?.lines]).toEqual([6, [`A switch to codex:personal is already running (process ${live.pid}). Try again when it finishes.`]]);
    expect(existsSync(journalPath(job.scratch.relayHome, job.jobId))).toBe(true);
  } finally {
    live.kill();
  }
});
