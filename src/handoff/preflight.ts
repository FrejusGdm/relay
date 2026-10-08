// The checks of a switch that change nothing (add-relay-switch, design decision 3). They run, and
// the person answers every question, before the outgoing agent is stopped, so that a refusal or a
// "no" leaves the job exactly as it was and the agent still working.
import { jobPrefix } from "../checkpoint/commit";
import { buildSnapshotTree } from "../checkpoint/snapshot";
import { findJob, openJob } from "../checkpoint/save";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { AdapterRegistry } from "../adapters/registry";
import type { Mode, PermissionLevel, ProviderAdapter } from "../adapters/types";
import type { Account, RelayConfig } from "../core/config/types";
import { openRepository, RepositoryError, type Repository } from "../git/repo";
import { git } from "../git/run";
import type { JobRef } from "../job/events";
import type { JobState } from "../job/state";
import { processStartTime, readSupervisor, type Supervisor } from "../run/control";
import { checkAgentReady } from "../run/ready";
import { readWorkerRecords, type WorkerRecord } from "../run/worker-record";
import { accountLabel, resolveAccount } from "./account";
import { checkAllowList } from "./allow-list";
import type { AnswerHow, Asker } from "./ask";
import { changedInstructionFiles, confirmInstructionFiles } from "./instruction-files";
import { nextStart } from "./permission";
import { readHandoffSettings, type HandoffSettings } from "./settings";

export interface HandoffEnv {
  relayHome: string;
  homedir: string;
  uid: number;
  env: Record<string, string | undefined>;
  config: RelayConfig;
  registry: AdapterRegistry;
}

// The worker that a relay process holds: its record, and how to stop it.
export interface HeldWorker {
  record: WorkerRecord;
  stop(timeoutMs: number): Promise<{ how: string; exitCode: number | null; alive: boolean }>;
  lastFailure(): WorkerRecord["last_failure"];
}

interface PreflightInput {
  cwd: string;
  arg: string;
  command: "switch" | "run";
  startMode: Mode | "none";
  permission?: PermissionLevel;
  noSummary: boolean;
  newChecks: string[] | null;
  asker: Asker;
  // The worker this process holds, when this process is the relay run that supervises the job.
  held: HeldWorker | null;
}

export interface Preflight {
  repo: Repository;
  job: JobRef;
  state: JobState;
  to: Account;
  toAdapter: ProviderAdapter;
  settings: HandoffSettings;
  // The newest worker of the job, and its account when it still exists in config.toml.
  outgoing: { record: WorkerRecord; account: Account | null; held: HeldWorker | null } | null;
  // A relay run in another process that holds the job's agent.
  supervisor: (Supervisor & { checked: boolean }) | null;
  next: { mode: Mode | "none"; permission: PermissionLevel | null };
  askForNotes: true | "flag" | "config";
  newChecks: string[] | null;
  allowed: { account: string; company: string; how: AnswerHow } | null;
  confirmations: { question: string; how: AnswerHow }[];
  instructionFiles: { paths: string[]; how: AnswerHow; at: Date } | null;
}

export async function preflight(handoffEnv: HandoffEnv, input: PreflightInput): Promise<Preflight> {
  const { relayHome, config } = handoffEnv;
  // 1. The repository and the job.
  let repo: Repository;
  try {
    repo = await openRepository(input.cwd);
  } catch (error) {
    if (error instanceof RepositoryError) throw new CommandError(ExitCode.NotPossibleHere, error.lines);
    throw error;
  }
  // 2. The account.
  const to = resolveAccount(input.arg, config);
  // 3 to 5. The current worker, and the relay run that holds it.
  // The trust check runs in step 8, after the checks that need no git command.
  const { job } = findJob(repo, relayHome);
  const records = readWorkerRecords(relayHome, job.id);
  const newest = records[0] ?? null;
  const supervisor = input.held === null ? readSupervisor(relayHome, job.id) : null;
  const running = input.held !== null || (supervisor !== null && newest !== null && newest.end_reason === null);
  if (newest !== null && running && newest.account === to.id) {
    throw new CommandError(ExitCode.Usage, [`${accountLabel(to)} is already working on this job.`]);
  }
  if (newest === null && input.command === "switch") {
    throw new CommandError(ExitCode.NotPossibleHere, [`No agent has worked on this job yet. Start one with relay run ${to.id}.`]);
  }
  if (newest !== null && !running && newest.end_reason === null && workerProcessRuns(newest)) {
    const name = handoffEnv.registry.get(newest.provider).displayName;
    throw new CommandError(ExitCode.CannotStop, [
      `${name} (process ${newest.pid}) is still running, but the relay run that started it is gone. Stop it yourself, then try again.`,
    ]);
  }
  // 6. The next agent's program and account.
  const toAdapter = handoffEnv.registry.get(to.provider);
  await checkAgentReady(handoffEnv, toAdapter, to);
  // 7. Mode and permission. The first handoff of a job records the mode and level of its worker.
  const settings = readHandoffSettings(relayHome, job.id) ?? initialSettings(job.id, newest);
  const next = nextStart(settings, { startMode: input.startMode, permission: input.permission, outgoingLevel: newest?.permission ?? null });
  if (next.mode === "interactive" && !input.asker.terminal && input.held === null && supervisor === null) {
    throw new CommandError(ExitCode.NeedsPerson, [`This switch needs a terminal. Run relay ${input.command} ${to.id} in the project.`]);
  }
  // 8. The git trust check, before the agent is stopped, so a planted command never runs.
  const opened = await openJob(repo, relayHome, input.command);
  // 9. A change of the checks needs a terminal.
  if (input.newChecks !== null && !input.asker.terminal && input.asker.preset === undefined) {
    throw new CommandError(ExitCode.NeedsPerson, ["Changing the checks needs a terminal. Run the command in your terminal."]);
  }
  // 10. The allow list, the second account of a provider, and work code going to a personal account.
  const outgoingAccount = newest === null ? null : config.accounts.find((account) => account.id === newest.account) ?? null;
  const allow = await checkAllowList({
    asker: input.asker, config, configContext: { relayHome, homedir: handoffEnv.homedir, uid: handoffEnv.uid },
    repo, from: outgoingAccount, fromRunning: running, to, command: input.command,
  });
  // 11. Files that instruct agents, compared with the working tree.
  let instructionFiles: Preflight["instructionFiles"] = null;
  const start = await startCheckpointCommit(repo, job.id, newest);
  if (newest !== null && start !== null) {
    const { tree } = await buildSnapshotTree(repo, {
      jobId: job.id, relayHome, maxFileBytes: config.checkpoint.maxFileSizeMb * 1024 * 1024, approved: opened.state.approved_paths,
    });
    const paths = await changedInstructionFiles(repo, start, tree);
    if (paths.length > 0) {
      const how = await confirmInstructionFiles({
        asker: input.asker, from: newest.provider, to, startCheckpoint: start, paths, worktreeRoot: repo.worktreeRoot,
        refusal: [running && outgoingAccount !== null ? `Nothing changed. ${accountLabel(outgoingAccount)} is still working.` : "Nothing changed."],
      });
      instructionFiles = { paths, how, at: new Date() };
    }
  }
  const askForNotes = input.noSummary ? "flag" : config.handoff.askForSummary ? true : "config";
  return {
    repo, job, state: opened.state, to, toAdapter, settings,
    outgoing: newest === null ? null : { record: newest, account: outgoingAccount, held: input.held },
    supervisor: running && input.held === null ? supervisor : null,
    next, askForNotes, newChecks: input.newChecks, allowed: allow.allowed, confirmations: allow.confirmations, instructionFiles,
  };
}

function initialSettings(jobId: string, worker: WorkerRecord | null): HandoffSettings {
  const mode = worker?.mode ?? "interactive";
  return {
    schema_version: 1, job_id: jobId, mode, permission: mode === "headless" ? worker?.permission ?? "read-only" : null, checks: [], next_handoff: 1,
  };
}

// The commit of the checkpoint that was latest when the worker started.
export async function startCheckpointCommit(repo: Repository, jobId: string, worker: WorkerRecord | null): Promise<string | null> {
  const number = worker?.start_checkpoint;
  if (number === undefined || number === null) return null;
  const result = await git(repo, ["rev-parse", "-q", "--verify", `${jobPrefix(jobId)}checkpoints/${number}^{commit}`]);
  return result.code === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
}

// Whether the worker's agent process still runs: its process ID is alive and the process started
// within a few seconds of the time relay recorded for the worker.
function workerProcessRuns(record: WorkerRecord): boolean {
  if (record.pid === null) return false;
  const started = processStartTime(record.pid);
  if (started === null) return false;
  return Math.abs(Date.parse(`${started} GMT`) - Date.parse(record.started_at)) < 5000;
}
