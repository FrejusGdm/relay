// performHandoff: the one switch function (add-relay-switch, design decisions 1 and 2). relay
// switch, relay run on a job with earlier work, and a relay run that takes a switch request from
// another terminal all call it after the preflight. It runs the steps in a fixed order, writes the
// journal after each step that changes something, and on a failure puts back what it wrote,
// keeps the work checkpoint, and says where the work is saved.
import { copyFileSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "../checkpoint/save";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Account } from "../core/config/types";
import { onInterrupt, runInterruptActions, wasInterrupted } from "../core/cleanup";
import { appendEvent, readEventLogText, readEvents, type RelayEvent } from "../job/events";
import { takeJobLock } from "../job/lock";
import { readState, stateText, writeState, type JobState } from "../job/state";
import { now } from "../platform/clock";
import { processStartTime } from "../run/control";
import { relayInstructions } from "../run/instructions";
import { readAvailability } from "../accounts/availability";
import { newWorkerId, type WorkerRecord } from "../run/worker-record";
import type { Mode, PermissionLevel, ProviderAdapter } from "../adapters/types";
import { accountLabel, displayName } from "./account";
import { resultText, runChecks, type CheckResult } from "./checks";
import { compareClaims, type Mismatch } from "./claims";
import { recordHandoff, deleteHandoffRef } from "./commit";
import { commitLines, diffNumbers, diffStat, eventLines } from "./context";
import {
  checkRunEvent, handoffEvent, handoffFailedEvent, handoffNotesEvent, providerAllowedEvent, verificationEvent, type PendingEvent,
} from "./events";
import { makePrivateFolder } from "./files";
import { handoffFolder, markHandoff, newestHandoff, writeHandoffFile, writeHandoffRecord, type HandoffRecord } from "./handoff-record";
import { changedInstructionFiles, confirmInstructionFiles } from "./instruction-files";
import { BACKED_UP, deleteJournal, writeJournal, type Journal, type JournalStep } from "./journal";
import { workerFacts } from "./notes-build";
import { parseNotes, type ParsedNotes } from "./notes-parse";
import { notesSkipReason, requestNotes } from "./notes-request";
import type { HandoffEnv, Preflight } from "./preflight";
import { startCheckpointCommit } from "./preflight";
import { renderCheckpoint } from "./render-checkpoint";
import { continuationPrompt, instructionFileNames } from "./render-prompt";
import { scanHandoff } from "./scan";
import { writeHandoffSettings } from "./settings";
import { countVerification, readVerifyFile } from "./verify-file";
import type { Asker } from "./ask";

export interface StartPlan {
  account: Account;
  adapter: ProviderAdapter;
  mode: Mode;
  permission: PermissionLevel | null;
  instructions: string;
  prompt: string;
  fromHandoff: number;
  startCheckpoint: number;
}

export type StartOutcome = { ok: true; workerId: string } | { ok: false; reason: string };

interface HandoffRun {
  pre: Preflight;
  env: HandoffEnv;
  asker: Asker;
  progress(line: string): void;
  // Puts the terminal back after the outgoing agent had it.
  restoreTerminal(): void;
  // Step 12: starts the next agent and reports, after the start check, whether it started.
  start(plan: StartPlan): Promise<StartOutcome>;
  // False in the daemon: Control-C does not interrupt the switch there, because the daemon's own
  // SIGINT handler waits for running switches before it stops (add-daemon-api-and-status, decision 7).
  signals?: boolean;
}

export interface HandoffResult {
  number: number;
  checkpoint: { number: number; commit: string; reused: boolean };
  handoffRef: string;
  handoffCommit: string;
  promptPath: string;
  notesSource: "agent" | "relay";
  notesReason: string | null;
  checks: CheckResult[];
  claimsCount: number;
  mismatches: Mismatch[];
  toWorkerId: string | null;
  outcome: "started" | "prepared" | "start_failed";
}

// The step a failure happened in, for the handoff_failed event.
type Step = "stop" | "checkpoint" | "instruction_files" | "notes" | "checks" | "build" | "scan" | "write" | "record" | "start";

class HandoffFailure extends Error {
  constructor(readonly code: number, readonly lines: string[]) {
    super(lines[0]);
  }
}

export async function performHandoff(run: HandoffRun): Promise<HandoffResult> {
  const { pre, env } = run;
  const { repo, job, to } = pre;
  const relayDir = join(repo.worktreeRoot, ".relay");
  const outgoing = pre.outgoing;
  // A job no agent worked on starts with the start prompt, not a handoff.
  if (outgoing === null) throw new Error("relay tried to hand off a job that no agent worked on.");
  // The worker this process holds is the same object its supervisor updates when the agent ends,
  // so after the stop it holds the end time and how the agent ended.
  const record = outgoing.held?.record ?? outgoing.record;
  const fromAccountId = record.account;
  const fromProvider = record.provider;
  const fromName = displayName(fromProvider);
  const toName = displayName(to.provider);
  const [, fromAccountName] = fromAccountId.split(":") as [string, string];
  const fromAccount = { id: fromAccountId as Account["id"], provider: fromProvider, name: fromAccountName };
  const fromLabel = accountLabel(fromAccount);
  const goBack = fromAccountId === to.id ? "" : `, or "relay run ${fromAccountId}" to go back`;
  const handoffs = env.config.handoff;
  const settings = { ...pre.settings, checks: pre.newChecks === null ? pre.settings.checks : pre.newChecks.map((command) => ({
    command, timeout_seconds: handoffs.checkTimeoutSeconds, added_at: now().toISOString(),
  })) };
  const number = Math.max(settings.next_handoff, (newestHandoff(env.relayHome, job.id)?.number ?? 0) + 1);

  let step: Step = "stop";
  let journal: Journal | null = null;
  let checkpoint: { number: number; commit: string; reused: boolean; tree: string } | null = null;
  let backupDir: string | null = null;
  let handoffRef: { ref: string; commit: string } | null = null;
  let factsAppended = false;
  // The facts gathered in steps 1 and 5 to 7, appended in step 10 in this order, or just before
  // handoff_failed when the switch stops earlier.
  let notesEvent: PendingEvent | null = null;
  let verificationRecorded: PendingEvent | null = null;
  const checkEvents: PendingEvent[] = [];
  const pending = () => [notesEvent, verificationRecorded, ...checkEvents, pre.allowed === null ? null : providerAllowedEvent(pre.allowed)]
    .filter((event): event is PendingEvent => event !== null);
  const confirmations = [...pre.confirmations];

  // Control-C after the agent is stopped: relay finishes the step it is in, then rolls back.
  let interrupted = false;
  const restoreSignal = run.signals === false ? () => {} : takeInterrupt(() => { interrupted = true; });
  const checkInterrupt = () => {
    if (interrupted || wasInterrupted()) throw new HandoffFailure(ExitCode.Interrupted, ["The switch was interrupted."]);
  };

  const releaseLock = takeJobLock(env.relayHome, job.id, "switch");
  let lockHeld = true;
  const unlock = () => {
    if (lockHeld) releaseLock();
    lockHeld = false;
  };
  const journalStep = (stepName: JournalStep) => {
    journal = {
      schema_version: 1, pid: process.pid, process_started_at: processStartTime(process.pid), started_at: journal?.started_at ?? now().toISOString(),
      to_account: to.id, handoff_number: number, step: stepName, checkpoint_commit: checkpoint?.commit ?? null,
      checkpoint_number: checkpoint?.number ?? null, backup_dir: backupDir, handoff_ref: handoffRef?.ref ?? null,
    };
    writeJournal(env.relayHome, job.id, journal);
  };

  try {
    // 2. Stop the outgoing agent through the relay process that holds it.
    const held = outgoing.held;
    failForTests("stop", env.env);
    if (held !== null) {
      run.progress(`Stopping ${fromLabel}`);
      const stopped = await held.stop(handoffs.stopTimeoutSeconds * 1000);
      run.restoreTerminal();
      if (stopped.alive) {
        throw new HandoffFailure(ExitCode.CannotStop, [
          `${fromLabel} (process ${held.record.pid}) did not stop. relay changed nothing else. Stop it yourself, then run relay switch ${to.id} again.`,
        ]);
      }
      journalStep("stopped");
    }

    // 3. The work checkpoint.
    step = "checkpoint";
    checkInterrupt();
    failForTests("checkpoint", env.env);
    const saved = await saveCheckpoint(repo, {
      relayHome: env.relayHome, command: "switch", kind: "handoff", maxFileSizeMb: env.config.checkpoint.maxFileSizeMb,
      env: env.env, message: `Handoff from ${fromAccountId} to ${to.id}`, lockHeld: true,
      trailers: [["Relay-Worker", record.worker_id], ["Relay-Target", record.account]],
    });
    const state = readState(relayDir);
    if (saved.saved) {
      checkpoint = { number: saved.number, commit: saved.commit, reused: false, tree: saved.tree };
      run.progress(`Saved checkpoint ${saved.commit.slice(0, 6)}`);
    } else {
      const latest = state.latest_checkpoint!;
      checkpoint = { number: latest.number, commit: latest.commit, reused: true, tree: saved.tree };
      run.progress(`Using checkpoint ${latest.commit.slice(0, 6)} (no changes since it was saved)`);
    }
    journalStep("checkpoint_saved");

    // 4. The files that instruct agents, again, against the work checkpoint.
    step = "instruction_files";
    checkInterrupt();
    const start = await startCheckpointCommit(repo, job.id, record);
    if (start !== null) {
      const paths = await changedInstructionFiles(repo, start, checkpoint.commit);
      const answered = pre.instructionFiles?.paths ?? [];
      if (paths.length > 0 && paths.join("\0") !== answered.join("\0")) {
        const how = await confirmInstructionFiles({
          asker: { ...run.asker, preset: undefined }, from: fromProvider, to, startCheckpoint: start, paths, worktreeRoot: repo.worktreeRoot,
          refusal: [`Nothing was sent. ${fromName} is stopped, and your work is saved in checkpoint ${checkpoint.commit.slice(0, 6)}.`],
        }).catch((error: unknown) => {
          if (error instanceof CommandError) throw new HandoffFailure(error.code, error.lines);
          throw error;
        });
        pre.instructionFiles = { paths, how, at: now() };
      }
    }
    if (pre.instructionFiles !== null) confirmations.push({ question: "Files that instruct agents changed", how: pre.instructionFiles.how });

    // 5. The notes.
    step = "notes";
    checkInterrupt();
    const notes = await getNotes(run, number, record, fromName);
    if (notes.parsed !== null && notes.parsed.invisibleRemoved > 0) {
      run.progress(`Removed ${notes.parsed.invisibleRemoved} invisible ${notes.parsed.invisibleRemoved === 1 ? "character" : "characters"} from ${fromName}'s notes.`);
    }
    notesEvent = notes.event;

    // 6. The next agent's verification of the previous handoff.
    const verify = await readVerifyFile(repo, checkpoint.commit);
    const previous = newestHandoff(env.relayHome, job.id);
    if (verify !== null && previous !== null) verificationRecorded = verificationEvent(previous.number, record.worker_id, countVerification(verify));

    // 7. The checks.
    step = "checks";
    checkInterrupt();
    if (pre.newChecks !== null) writeHandoffSettings(env.relayHome, settings);
    const checks = await runChecks({
      repo, jobId: job.id, relayHome: env.relayHome, handoff: number, checks: settings.checks, env: env.env,
      credentialNames: env.config.accounts.flatMap((account) => account.credentialEnv),
      maxFileBytes: env.config.checkpoint.maxFileSizeMb * 1024 * 1024, approvedPaths: state.approved_paths,
    });
    for (const check of checks) {
      run.progress(`Ran ${check.command} · ${check.counts === null ? resultText(check) : countsText(check)}`);
      checkEvents.push(checkRunEvent(number, check, env.relayHome));
    }
    checkInterrupt();

    // 8. Build everything in memory.
    step = "build";
    failForTests("build", env.env);
    const facts = await workerFacts(repo, {
      jobId: job.id, workCheckpoint: checkpoint.commit,
      record: {
        startedAt: new Date(record.started_at), endedAt: record.ended_at === null ? null : new Date(record.ended_at),
        endReason: record.end_reason, exitCode: record.exit_code,
        lastFailure: held?.lastFailure() ?? record.last_failure ?? null, startCheckpoint: record.start_checkpoint ?? null,
      },
    });
    const mismatches = notes.parsed === null ? [] : await compareClaims(repo, {
      notes: notes.parsed, checks, changedWhileWorking: [...facts.filesChanged, ...facts.jobFilesChanged], workCheckpoint: checkpoint.commit, from: fromProvider,
    });
    if (mismatches.length > 0) {
      run.progress(`Found ${mismatches.length} ${mismatches.length === 1 ? "difference" : "differences"} between the notes and the repository`);
    }
    const base = state.start.head;
    const nowEvents: RelayEvent[] = [...readEvents(job), ...pending().map((item) => ({
      v: 1 as const, id: 0, ts: now().toISOString(), job: job.id, type: item.type, actor: "relay" as const, data: item.data,
    }))];
    const rendered = renderCheckpoint({
      jobId: job.id, handoff: number, writtenAt: now(), title: state.title,
      from: fromAccount,
      to, worker: facts, worktreeRoot: repo.worktreeRoot, branch: repo.head.branch, base,
      checkpoint: { number: checkpoint.number, commit: checkpoint.commit },
      notes: notes.parsed === null ? { source: "relay", reason: notes.reason! } : { source: "agent", parsed: notes.parsed },
      checks, mismatches, diffStat: await diffStat(repo, base, checkpoint.commit),
      instructionFiles: pre.instructionFiles === null ? null : { paths: pre.instructionFiles.paths, confirmedAt: pre.instructionFiles.at },
      commitLines: await commitLines(repo, base, checkpoint.commit), eventLines: eventLines(nowEvents),
    });
    const instructions = relayInstructions(job.id, repo.worktreeRoot);
    const prompt = continuationPrompt({
      jobId: job.id, title: state.title, from: fromAccount,
      until: facts.endedAt ?? now(), stoppedByRelay: held !== null, checkpoint: checkpoint.commit, mismatches,
      diff: await diffNumbers(repo, base, checkpoint.commit), base, checks, notesSource: notes.parsed === null ? "relay" : "agent",
      nonce: rendered.nonce, files: instructionFileNames(repo.worktreeRoot),
    });
    const folder = handoffFolder(env.relayHome, job.id, number);
    const promptPath = join(folder, "prompt.md");
    const newState: JobState = {
      ...readState(relayDir), current_worker: null, updated_at: now().toISOString(),
      last_handoff: { number, to_account: to.id, checkpoint_number: checkpoint.number, outcome: pre.next.mode === "none" ? "prepared" : "starting", created_at: now().toISOString() },
    };
    const event = handoffEvent({
      number, fromWorkerId: record.worker_id, fromTarget: fromAccountId, toTarget: to.id, toWorkerId: null,
      checkpointNumber: checkpoint.number, checkpointCommit: checkpoint.commit, handoffRef: `refs/relay/jobs/${job.id}/handoffs/${number}`,
      notesSource: notes.parsed === null ? "relay" : "agent", notesReason: notes.reason, claimsCount: notes.parsed?.claims.length ?? 0,
      mismatches, checks, instructionFilesChanged: pre.instructionFiles?.paths ?? [], confirmations,
      invisibleRemoved: notes.parsed?.invisibleRemoved ?? 0, promptPath,
    });

    // 9. The secret scan of everything that is about to be written or sent.
    step = "scan";
    checkInterrupt();
    await scanHandoff({
      checkpointMd: rendered.text, sections: rendered.sections, stateJson: stateText(newState),
      events: [...pending(), event].map((item) => JSON.stringify(item)).join("\n"), instructions, prompt, notes: notes.parsed?.text ?? null,
    }, { from: fromProvider, to, checkpoint: checkpoint.commit.slice(0, 6), env: env.env }).catch((error: unknown) => {
      if (error instanceof CommandError) throw new HandoffFailure(error.code, error.lines);
      throw error;
    });

    // 10. Write the job files, after backing up the ones that are replaced or removed.
    step = "write";
    checkInterrupt();
    backupDir = join(folder, "backup");
    makePrivateFolder(backupDir);
    for (const name of BACKED_UP) {
      const path = join(relayDir, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) copyFileSync(path, join(backupDir, name));
      else if (name === "verify.md") writeFileSync(join(backupDir, ".verify-missing"), "");
    }
    journalStep("files_written");
    writeFileSync(join(relayDir, "checkpoint.md"), rendered.text);
    failForTests("write", env.env);
    writeState(relayDir, newState);
    rmSync(join(relayDir, "verify.md"), { force: true });
    writeHandoffFile(env.relayHome, job.id, number, "prompt.md", prompt);
    writeHandoffFile(env.relayHome, job.id, number, "instructions.md", instructions);
    if (notes.parsed !== null) writeHandoffFile(env.relayHome, job.id, number, "notes.md", notes.parsed.text);
    for (const item of pending()) await appendEvent(job, item.type, item.data);
    factsAppended = true;
    run.progress("Wrote .relay/checkpoint.md");

    // 11. Record the handoff in git and in the event log.
    step = "record";
    checkInterrupt();
    handoffRef = await recordHandoff(repo, {
      jobId: job.id, relayHome: env.relayHome, number, workCheckpoint: checkpoint, from: fromAccountId, to: to.id,
      notesSource: notes.parsed === null ? "relay" : "agent",
      tests: checks.length === 0 ? "none" : checks.map((check) => (check.counts === null ? resultText(check) : countsText(check))).join("; "),
      files: { checkpointMd: rendered.text, stateJson: stateText(newState), eventsJsonl: readEventLogText(job) },
    });
    failForTests("record", env.env);
    await appendEvent(job, event.type, event.data);
    const handoffRecord: HandoffRecord = {
      number, created_at: now().toISOString(), from_account: fromAccountId, to_account: to.id,
      checkpoint, handoff_ref: handoffRef.ref, handoff_commit: handoffRef.commit, prompt_path: promptPath,
      notes_source: notes.parsed === null ? "relay" : "agent", notes_reason: notes.reason, claims_count: notes.parsed?.claims.length ?? 0,
      mismatches: mismatches.map(({ claim, found }) => ({ claim, found })), checks: checks.map(({ command, outcome }) => ({ command, outcome })),
      confirmations, instruction_files_changed: pre.instructionFiles?.paths ?? [], to_worker_id: null,
      outcome: "prepared", start_error: null,
      start: { mode: pre.settings.mode, permission: pre.settings.mode === "headless" ? pre.next.permission : null },
    };
    writeHandoffRecord(env.relayHome, job.id, handoffRecord);
    writeHandoffSettings(env.relayHome, { ...settings, next_handoff: number + 1 });
    rmSync(backupDir, { recursive: true, force: true });
    backupDir = null;
    journalStep("handoff_recorded");

    const result: HandoffResult = {
      number, checkpoint: { number: checkpoint.number, commit: checkpoint.commit, reused: checkpoint.reused },
      handoffRef: handoffRef.ref, handoffCommit: handoffRef.commit, promptPath, notesSource: handoffRecord.notes_source,
      notesReason: notes.reason, checks, claimsCount: handoffRecord.claims_count, mismatches, toWorkerId: null, outcome: "prepared",
    };

    // 12. Start the next agent.
    step = "start";
    unlock();
    restoreSignal();
    if (pre.next.mode === "none") {
      setLastHandoff(relayDir, "prepared");
      deleteJournal(env.relayHome, job.id);
      run.progress(`Ready for ${accountLabel(to)}.`);
      run.progress(`Run "relay run ${to.id}" to start it.`);
      return result;
    }
    journalStep("starting");
    const started = await startNext(run, {
      account: to, adapter: pre.toAdapter, mode: pre.next.mode, permission: pre.next.permission, instructions, prompt,
      fromHandoff: number, startCheckpoint: checkpoint.number,
    });
    if (started.ok) {
      markHandoff(env.relayHome, job.id, number, "started", { to_worker_id: started.workerId });
      setLastHandoff(relayDir, "started");
      deleteJournal(env.relayHome, job.id);
      return { ...result, toWorkerId: started.workerId, outcome: "started" };
    }
    markHandoff(env.relayHome, job.id, number, "start_failed", { start_error: started.reason });
    setLastHandoff(relayDir, "start_failed");
    const failed = handoffFailedEvent({ number, toTarget: to.id, step: "start", reason: started.reason, exitCode: ExitCode.StartFailed, keptCheckpoint: checkpoint.number });
    await appendEvent(job, failed.type, failed.data);
    deleteJournal(env.relayHome, job.id);
    throw new CommandError(ExitCode.StartFailed, [
      `${accountLabel(to)} did not start: ${started.reason}.`,
      `Your work is saved in checkpoint ${checkpoint.commit.slice(0, 6)}, and the handoff is ready.`,
      `Run "relay run ${to.id}" to try again${goBack}.`,
    ]);
  } catch (error) {
    if (error instanceof CommandError && step === "start") throw error;
    const failure = error instanceof HandoffFailure ? error
      : error instanceof CommandError ? new HandoffFailure(interrupted ? ExitCode.Interrupted : error.code, error.lines)
      : interrupted ? new HandoffFailure(ExitCode.Interrupted, ["The switch was interrupted."])
      : null;
    await rollBack({
      run, step, stopped: journal !== null, checkpoint, backupDir, handoffRef, pending: factsAppended ? [] : pending(), number,
      code: failure?.code ?? ExitCode.Internal, reason: failure?.lines[0] ?? (error as Error).message,
    });
    if (failure === null) throw error;
    const saved = checkpoint === null ? "" : `, and your work is saved in checkpoint ${checkpoint.commit.slice(0, 6)}`;
    const lines = failure.lines.some((line) => line.startsWith("Nothing was written or sent.") || line.startsWith("Nothing was sent.")) || journal === null
      ? failure.lines
      : step === "checkpoint" && failure.code === ExitCode.SecretFound
        ? [...failure.lines, `${fromName} is stopped. Nothing was sent to ${toName}.`]
        : [...failure.lines, `${fromName} is stopped${saved}.`, `Run "relay switch ${to.id}" to try again${goBack}.`];
    throw new CommandError(failure.code, lines);
  } finally {
    unlock();
    restoreSignal();
  }
}

// RELAY_TEST_FAIL_STEP=<step> makes that step fail, so the tests can check the rollback of each
// step. It is read only when RELAY_TEST=1, which the test preload sets.
function failForTests(step: Step, env: Record<string, string | undefined>): void {
  if (process.env.RELAY_TEST !== "1" || env.RELAY_TEST_FAIL_STEP !== step) return;
  const code = step === "stop" ? ExitCode.CannotStop : step === "build" ? ExitCode.Internal : ExitCode.Failed;
  throw new HandoffFailure(code, [`relay could not finish the step ${step} (a failure a test asked for).`]);
}

function countsText(check: CheckResult): string {
  const { passed, failed, skipped } = check.counts!;
  return `${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}`;
}

function setLastHandoff(relayDir: string, outcome: string): void {
  const state = readState(relayDir);
  const last = state.last_handoff as Record<string, unknown> | null | undefined;
  if (last !== null && last !== undefined) writeState(relayDir, { ...state, last_handoff: { ...last, outcome } });
}

// Step 5: asks the outgoing agent for its notes when it can answer, or records why relay builds them.
async function getNotes(
  run: HandoffRun, number: number, record: WorkerRecord, fromName: string,
): Promise<{ parsed: ParsedNotes | null; reason: string | null; event: PendingEvent }> {
  const { pre, env } = run;
  const skipped = (reason: string, outcome: "skipped" | "timed_out" | "failed" = "skipped", seconds = 0) => ({
    parsed: null, reason,
    event: handoffNotesEvent({ handoff: number, fromWorkerId: record.worker_id, outcome, reason, seconds, characters: 0, invisibleRemoved: 0 }),
  });
  const account = pre.outgoing?.account ?? null;
  const adapter = env.registry.get(record.provider);
  const capabilities = adapter.capabilities(record.transport);
  const availability = account === null ? "unknown" : readAvailability(env.relayHome, account).state;
  const reason = notesSkipReason(pre.askForNotes, {
    workerId: record.worker_id, account, accountId: record.account, provider: record.provider,
    sessionId: record.provider_session_id, capabilities,
    lastFailure: pre.outgoing?.held?.lastFailure() ?? record.last_failure ?? null, availability,
  });
  if (reason !== null) {
    if (pre.askForNotes === true) run.progress(`${presentTense(reason)}, so relay built the notes from the event log and the repository.`);
    return skipped(reason);
  }
  run.progress(`Asking ${fromName} for handoff notes`);
  const workerId = newWorkerId();
  // The log of the request holds the notes before the secret scan has read them, so it is removed
  // as soon as the answer is in.
  const logPath = join(env.relayHome, "logs", "workers", `${pre.job.id}-${workerId}.log`);
  const answer = await requestNotes({
    adapter, account: account!, sessionId: record.provider_session_id!, jobId: pre.job.id, workerId, cwd: pre.repo.worktreeRoot,
    instructions: relayInstructions(pre.job.id, pre.repo.worktreeRoot), env: env.env, logPath,
    timeoutMs: env.config.handoff.summaryTimeoutSeconds * 1000, stopTimeoutMs: env.config.handoff.stopTimeoutSeconds * 1000,
  }).finally(() => rmSync(logPath, { force: true }));
  if (answer.outcome !== "received") {
    run.progress(answer.outcome === "timed_out"
      ? `${answer.reason}. relay built the notes from the event log and the repository.`
      : `${fromName} did not write notes (${answer.reason}). relay built the notes from the event log and the repository.`);
    return skipped(answer.reason, answer.outcome, answer.seconds);
  }
  const parsed = parseNotes(answer.text);
  return {
    parsed, reason: null,
    event: handoffNotesEvent({
      handoff: number, fromWorkerId: record.worker_id, outcome: "received", reason: null, seconds: answer.seconds,
      characters: parsed.text.length, invisibleRemoved: parsed.invisibleRemoved,
    }),
  };
}

// "Claude Code was at its usage limit" becomes "Claude Code is at its usage limit".
function presentTense(reason: string): string {
  return reason.replace(/ was at its /, " is at its ");
}

// Step 12. An interactive agent takes the terminal, so its lines come first.
async function startNext(run: HandoffRun, plan: StartPlan): Promise<StartOutcome> {
  const name = displayName(plan.account.provider);
  run.progress(`Starting ${accountLabel(plan.account)}`);
  if (plan.mode === "interactive") run.progress(`Continuing on ${name}.`);
  const outcome = await run.start(plan);
  if (outcome.ok && plan.mode === "headless") run.progress(`Continuing on ${name}.`);
  return outcome;
}

async function rollBack(input: {
  run: HandoffRun; step: Step; stopped: boolean; checkpoint: { number: number; commit: string } | null; backupDir: string | null;
  handoffRef: { ref: string; commit: string } | null; pending: PendingEvent[]; number: number; code: number; reason: string;
}): Promise<void> {
  const { run, checkpoint } = input;
  const { job, repo, to } = run.pre;
  const relayDir = join(repo.worktreeRoot, ".relay");
  if (input.backupDir !== null) {
    for (const name of BACKED_UP) {
      const backup = join(input.backupDir, name);
      if (existsSync(backup)) copyFileSync(backup, join(relayDir, name));
      else if (name === "verify.md" && existsSync(join(input.backupDir, ".verify-missing"))) rmSync(join(relayDir, name), { force: true });
    }
  }
  if (input.handoffRef !== null) await deleteHandoffRef(repo, input.handoffRef.ref, input.handoffRef.commit).catch(() => {});
  if (input.backupDir !== null || input.handoffRef !== null) rmSync(handoffFolder(run.env.relayHome, job.id, input.number), { recursive: true, force: true });
  if (input.stopped || checkpoint !== null) {
    if (existsSync(join(relayDir, "state.json"))) {
      const state = readState(relayDir);
      writeState(relayDir, { ...state, current_worker: null, updated_at: now().toISOString() });
    }
    for (const item of input.pending) await appendEvent(job, item.type, item.data).catch(() => {});
    const failed = handoffFailedEvent({
      number: input.number, toTarget: to.id, step: input.step, reason: input.reason, exitCode: input.code, keptCheckpoint: checkpoint?.number ?? null,
    });
    await appendEvent(job, failed.type, failed.data).catch(() => {});
  }
  deleteJournal(run.env.relayHome, job.id);
}

// While the switch runs, Control-C sets a flag instead of ending relay at once, and stops what
// relay started, such as a check, through the actions registered with onInterrupt.
function takeInterrupt(handler: () => void): () => void {
  const listeners = process.rawListeners("SIGINT");
  process.removeAllListeners("SIGINT");
  const own = () => {
    handler();
    runInterruptActions();
  };
  process.on("SIGINT", own);
  const forget = onInterrupt(handler);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    forget();
    process.removeListener("SIGINT", own);
    for (const listener of listeners) process.on("SIGINT", listener as () => void);
  };
}
