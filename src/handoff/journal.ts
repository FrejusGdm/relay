// The switch journal, RELAY_HOME/jobs/<job>/switch.json (add-relay-switch, design decision 2,
// "Recovery"). A switch writes it after each step that changes something, so that the next
// relay switch or relay run can clean up a switch that relay did not finish, for example after a
// crash or a SIGKILL.
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { appendEvent, type JobRef } from "../job/events";
import { readState, writeState } from "../job/state";
import { processStartTime } from "../run/control";
import { accountLabel } from "./account";
import { deleteHandoffRef } from "./commit";
import { handoffFailedEvent } from "./events";
import { jobFolder, writePrivateFile } from "./files";
import { markHandoff } from "./handoff-record";

export type JournalStep = "stopped" | "checkpoint_saved" | "files_written" | "handoff_recorded" | "starting";

export interface Journal {
  schema_version: 1;
  pid: number;
  process_started_at: string | null;
  started_at: string;
  to_account: string;
  handoff_number: number;
  step: JournalStep | "preflight";
  checkpoint_commit: string | null;
  checkpoint_number: number | null;
  backup_dir: string | null;
  handoff_ref: string | null;
}

// The files a backup holds: the job files that step 10 replaces or removes.
export const BACKED_UP = ["checkpoint.md", "state.json", "verify.md"] as const;

export function journalPath(relayHome: string, jobId: string): string {
  return join(jobFolder(relayHome, jobId), "switch.json");
}

export function writeJournal(relayHome: string, jobId: string, journal: Journal): void {
  writePrivateFile(journalPath(relayHome, jobId), `${JSON.stringify(journal, null, 2)}\n`);
  crashForTests(journal.step);
}

export function deleteJournal(relayHome: string, jobId: string): void {
  rmSync(journalPath(relayHome, jobId), { force: true });
}

function readJournal(relayHome: string, jobId: string): Journal | null {
  try {
    const value = JSON.parse(readFileSync(journalPath(relayHome, jobId), "utf8")) as Journal;
    return value?.schema_version === 1 && Number.isSafeInteger(value.pid) && typeof value.to_account === "string" ? value : null;
  } catch {
    return null;
  }
}

// Whether the process that wrote the journal still runs: the same process ID with the same start
// time, so a process ID that the system gave to another program counts as gone.
function ownerRuns(journal: Journal): boolean {
  try {
    process.kill(journal.pid, 0);
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
  }
  return journal.process_started_at === null || processStartTime(journal.pid) === journal.process_started_at;
}

// Step 0 of every relay switch and relay run: refuses while another switch runs (exit code 6) and
// cleans up a switch whose process is gone. Returns the line to print, or null when there was
// nothing to clean up.
export async function recoverSwitch(repo: Repository, job: JobRef): Promise<string | null> {
  const journal = readJournal(job.relayHome, job.id);
  if (journal === null) {
    if (existsSync(journalPath(job.relayHome, job.id))) deleteJournal(job.relayHome, job.id);
    return null;
  }
  if (journal.pid !== process.pid && ownerRuns(journal)) {
    throw new CommandError(ExitCode.Busy, [`A switch to ${journal.to_account} is already running (process ${journal.pid}). Try again when it finishes.`]);
  }
  const relayDir = join(job.worktreeRoot, ".relay");
  if (journal.step === "files_written" && journal.backup_dir !== null) {
    for (const name of BACKED_UP) {
      const backup = join(journal.backup_dir, name);
      const target = join(relayDir, name);
      if (lstatSync(backup, { throwIfNoEntry: false })?.isFile()) copyFileSync(backup, target);
      else if (name === "verify.md" && existsSync(join(journal.backup_dir, ".verify-missing"))) rmSync(target, { force: true });
    }
    if (journal.handoff_ref !== null) {
      const found = await git(repo, ["rev-parse", "-q", "--verify", journal.handoff_ref]);
      if (found.code === 0) await deleteHandoffRef(repo, journal.handoff_ref, new TextDecoder().decode(found.stdout).trim());
    }
  }
  if (journal.step === "handoff_recorded" || journal.step === "starting") markHandoff(job.relayHome, job.id, journal.handoff_number, "start_failed");
  const statePath = join(relayDir, "state.json");
  if (existsSync(statePath)) {
    const state = readState(relayDir);
    writeState(relayDir, { ...state, current_worker: null, updated_at: new Date().toISOString() });
  }
  const kept = journal.checkpoint_number;
  if (journal.step !== "preflight") {
    const event = handoffFailedEvent({
      number: journal.handoff_number, toTarget: journal.to_account, step: journal.step, reason: "relay stopped during the switch",
      exitCode: ExitCode.Failed, keptCheckpoint: kept,
    });
    await appendEvent(job, event.type, event.data);
  }
  deleteJournal(job.relayHome, job.id);
  if (journal.backup_dir !== null) rmSync(journal.backup_dir, { recursive: true, force: true });
  const [provider, name] = journal.to_account.split(":") as ["claude" | "codex", string];
  const saved = journal.checkpoint_commit === null ? "" : ` Your work is saved in checkpoint ${journal.checkpoint_commit.slice(0, 6)}.`;
  return `The last switch to ${accountLabel({ provider, name })} did not finish. relay cleaned it up.${saved}`;
}

// RELAY_TEST_CRASH_AFTER=<step> makes the switch stop right after writing that step, as a crash
// would. It is read only when RELAY_TEST=1, which the test preload sets.
function crashForTests(step: string): void {
  if (process.env.RELAY_TEST === "1" && process.env.RELAY_TEST_CRASH_AFTER === step) process.exit(99);
}
