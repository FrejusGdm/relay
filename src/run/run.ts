// relay run (the agent-runs spec; add-provider-adapters, design decision 15; and what
// add-relay-switch adds, the run-continuation spec): the checks before an agent starts, the
// worker lock, the worker record, the job events, the progress output and the exit code. Inside a
// job, relay run gives a new job the start prompt, continues a job that had earlier work through a
// handoff, takes switch requests from relay switch in another terminal, and saves a checkpoint when
// the agent exits. The agent is always started through its adapter, which builds its command line.
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readAvailability } from "../accounts/availability";
import { buildAgentEnv } from "../accounts/environment";
import { readAccountRecord, updateAccountRecord } from "../accounts/record";
import { findAccount, isProvider } from "../accounts/registry";
import { deleteOldWorkerLogs } from "../adapters/process";
import { createAdapterRegistry, type AdapterRegistry } from "../adapters/registry";
import { ensureDaemon } from "../client/ensure-daemon";
import { tomlString } from "../adapters/text";
import type {
  Availability, FailureReason, Mode, PermissionLevel, ProviderAdapter, StopResult, WorkerEvent, WorkerHandle,
} from "../adapters/types";
import { isSessionId, textForAgent } from "../adapters/worker";
import { saveCheckpoint } from "../checkpoint/save";
import { buildSnapshotTree } from "../checkpoint/snapshot";
import { ACCOUNT_WORD } from "../cli/commands/policy";
import type { CommandContext } from "../cli/commands/registry";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { appendTable, editConfig } from "../core/config/edit";
import { validateConfig } from "../core/config/validate";
import { parseToml } from "../platform/toml";
import type { Account } from "../core/config/types";
import { onInterrupt } from "../core/cleanup";
import { printable, quote } from "../core/quote";
import { openRepository, type Repository } from "../git/repo";
import { git } from "../git/run";
import { accountLabel, displayName } from "../handoff/account";
import { checkAllowList } from "../handoff/allow-list";
import type { Asker } from "../handoff/ask";
import { markHandoff, newestHandoff, type HandoffRecord } from "../handoff/handoff-record";
import { recoverSwitch } from "../handoff/journal";
import { preflight, type HandoffEnv, type HeldWorker, type Preflight } from "../handoff/preflight";
import { instructionFileNames, startPrompt } from "../handoff/render-prompt";
import { readHandoffSettings, writeHandoffSettings, type HandoffSettings } from "../handoff/settings";
import { performHandoff, type HandoffResult, type StartOutcome, type StartPlan } from "../handoff/switch";
import { appendEvent, readEvents, type JobRef } from "../job/events";
import { takeJobLock, takeWorkerLock, type WorkerLock } from "../job/lock";
import { readState, writeState } from "../job/state";
import { now } from "../platform/clock";
import { redact } from "../secrets/redact";
import {
  listenForRequests, readSupervisor, removeOldRequests, requestPrinter, supervisorFields, takeSwitchRequest, writeSwitchReply,
  type SwitchRequest,
} from "./control";
import { relayInstructions } from "./instructions";
import { findJobContext } from "./job-context";
import { failureLine, jsonLine, limitLine, progressLines, sessionLine } from "./progress";
import { checkAgentReady } from "./ready";
import {
  newWorkerId, readAllWorkerRecords, readWorkerRecords, workerRecordPath, writeWorkerRecord, type EndReason, type WorkerRecord,
} from "./worker-record";

export interface RunOptions {
  account?: string;
  headless: boolean;
  prompt?: string;
  promptFile?: string;
  resume?: string;
  permission?: string;
  model?: string;
  json: boolean;
  // add-relay-switch: the job's checks (null when not given), --yes and --no-summary.
  checks: string[] | null;
  yes: boolean;
  noSummary: boolean;
}

const PERMISSIONS = ["read-only", "edit-in-workspace", "full-access"];
// How long a turn may take to end after Ctrl+C before relay stops the agent, as the adapters wait.
const INTERRUPT_WAIT_MS = 10_000;
// How long a headless agent started by a handoff has to report its session.
const HEADLESS_START_MS = 60_000;
// Leaves the alternate screen, shows the cursor and resets styles, in case the agent did not.
const RESTORE_TERMINAL = "\x1b[?1049l\x1b[?25h\x1b[0m";
const CHECK_LIMIT = 500;

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line]);
}

export function checksLine(checks: string[]): string {
  return checks.length === 0 ? "relay will run no checks at handoffs." : `relay will run these checks at every handoff: ${checks.join("; ")}`;
}

// What relay prints on standard error for a switch that stopped: "relay: " before each line, except
// the hint line that ends a message, which tells the person what to run or change.
export function stderrText(lines: string[]): string {
  const hint = /^(?:Run "relay|Fix the output of the check|Remove the secret from|Rename the file whose name)/;
  return lines.map((line) => `${hint.test(line) || line.startsWith("relay: ") ? "" : "relay: "}${line}\n`).join("");
}

// The --check values: one line of at most 500 characters each, and "" alone clears the list.
export function parseChecks(values: string[] | undefined): string[] | null {
  if (values === undefined || values.length === 0) return null;
  for (const value of values) {
    if (value.length > CHECK_LIMIT || /[\r\n]/.test(value)) throw usage("relay: A check must be one line of at most 500 characters.");
  }
  return values.filter((value) => value.trim() !== "");
}

export async function runAgent(ctx: CommandContext, options: RunOptions): Promise<number> {
  const prompt = readPrompt(ctx, options);
  if (options.permission !== undefined && !PERMISSIONS.includes(options.permission)) {
    throw usage("relay: --permission must be read-only, edit-in-workspace or full-access.");
  }
  if (options.json && !options.headless) throw usage("relay: --json works only with --headless.");
  // The interactive command lines of the adapter specs take no model and no permission option;
  // the program's own settings and questions apply in the terminal.
  if (!options.headless && options.model !== undefined) throw usage("relay: --model works only with --headless.");
  if (!options.headless && options.permission !== undefined && options.permission !== "full-access") {
    throw usage("relay: --permission works only with --headless. An agent in your terminal asks you itself.");
  }
  if (options.headless && prompt === undefined) throw usage("A headless run needs --prompt or --prompt-file.");

  const { job, state } = await findJobContext(ctx.cwd, ctx.relayHome);
  const repo = await openRepository(job.worktreeRoot);
  // With --json, lines that are not worker events go to standard error, so that standard output
  // holds only one JSON object per line.
  const say = (line: string) => (options.json ? ctx.io.err(`${line}\n`) : ctx.io.out(`${line}\n`));
  const recovered = await recoverSwitch(repo, job);
  if (recovered !== null) say(recovered);
  const account = resolveAccount(ctx, options.account);
  const registry = createAdapterRegistry({}, ctx.env);
  const adapter = registry.get(account.provider);
  const running = readSupervisor(ctx.relayHome, job.id);
  if (running !== null) {
    const [provider, name] = running.account.split(":") as [Account["provider"], string];
    throw new CommandError(ExitCode.Busy, [
      `relay: ${isProvider(provider) ? accountLabel({ provider, name }) : printable(running.account)} is working on this job. To hand it over, run relay switch ${account.id}.`,
    ]);
  }
  if (options.checks !== null && !ctx.io.isTerminal) {
    throw new CommandError(ExitCode.NeedsPerson, ["relay: Changing the checks needs a terminal. Run the command in your terminal."]);
  }
  const { version } = await checkAgentReady(ctx, adapter, account);
  if (options.permission === "full-access") {
    throw new CommandError(ExitCode.Refused, ["relay does not start agents with full access in this version."]);
  }
  const records = readWorkerRecords(ctx.relayHome, job.id);
  const firstRun = allowOnProject(ctx, account, job.worktreeRoot, say);
  if (readAccountRecord(ctx.relayHome, account).policy_checked_on_seen !== adapter.policy.checkedOn) {
    say(`The ${adapter.displayName} policy notes changed since you last saw them. Read them with relay policy show ${account.provider}.`);
    updateAccountRecord(ctx.relayHome, account, { policy_checked_on_seen: adapter.policy.checkedOn, policy_seen_at: now().toISOString() });
  }
  const mode: Mode = options.headless ? "headless" : "interactive";
  const permission: PermissionLevel = options.permission === "read-only" ? "read-only" : "edit-in-workspace";
  const asker: Asker = {
    terminal: ctx.io.isTerminal, yes: options.yes, say,
    ask: async (question) => {
      ctx.io.out(`${question} `);
      return ctx.io.readLine();
    },
  };

  if (options.checks !== null) say(checksLine(options.checks));
  // The agent's hooks need a receiver (add-daemon-api-and-status, design decision 6).
  await ensureDaemon({ relayHome: ctx.relayHome, env: ctx.env, err: ctx.io.err });
  const supervisor = new JobSupervisor(ctx, job, registry, say, options.json);
  try {
    // A job with earlier work continues through a handoff, unless the person resumes a session.
    if (records.length > 0 && options.resume === undefined) {
      const reused = await reusePrepared(ctx, repo, job, account, say);
      const first = reused !== null
        ? await supervisor.startPrepared(reused, account, adapter)
        : (await supervisor.handoff(await preflight(handoffEnv(ctx, registry), {
          cwd: ctx.cwd, arg: account.id, command: "run", startMode: mode, permission: options.headless ? permission : undefined,
          noSummary: options.noSummary, newChecks: options.checks, asker, held: null,
        }), asker)).worker;
      if (first !== null) return await supervisor.supervise(first);
      return supervisor.exitCode;
    }
    if (!firstRun) await checkAllowList({
      asker, config: ctx.config, configContext: { relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!() }, repo,
      from: records[0] === undefined ? null : findAccount(ctx.config, records[0].account) ?? null, fromRunning: false, to: account, command: "run",
    }).then(async (result) => {
      if (result.allowed !== null) await appendEvent(job, "provider_allowed", { ...result.allowed });
    });
    const settings = updateChecks(ctx, job.id, mode, permission, options.checks);
    const resume = resolveResume(ctx.relayHome, job, adapter, account, options.resume);
    const firstPrompt = options.resume !== undefined ? prompt : startPrompt({
      jobId: job.id, title: state.title, files: instructionFileNames(job.worktreeRoot), checks: settings.checks.map((check) => check.command),
      ...(prompt === undefined ? {} : { request: prompt }),
    });
    const worker = await supervisor.begin({
      account, adapter, mode, permission, instructions: relayInstructions(job.id, job.worktreeRoot), prompt: firstPrompt, resume,
      model: options.model, providerVersion: version, startCheckpoint: readState(join(job.worktreeRoot, ".relay")).latest_checkpoint?.number ?? null,
      fromHandoff: null, startCheck: false,
    });
    return await supervisor.supervise(worker);
  } finally {
    supervisor.close();
  }
}

// What a job supervisor needs of the command that runs it. The daemon gives its own
// (add-daemon-api-and-status, design decision 17).
export type SupervisorContext = Pick<CommandContext, "relayHome" | "homedir" | "env" | "config" | "io">;

export function handoffEnv(ctx: SupervisorContext, registry: AdapterRegistry): HandoffEnv {
  return { relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!(), env: ctx.env, config: ctx.config, registry };
}

function readPrompt(ctx: CommandContext, options: RunOptions): string | undefined {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw usage("relay: give --prompt or --prompt-file, not both.");
  }
  let prompt = options.prompt;
  if (options.promptFile !== undefined) {
    try {
      prompt = readFileSync(resolve(ctx.cwd, options.promptFile), "utf8");
    } catch (error) {
      throw usage(`relay: cannot read ${quote(options.promptFile)} (${(error as { code?: string }).code ?? "unknown error"}).`);
    }
  }
  if (prompt !== undefined) {
    try {
      textForAgent(prompt);
    } catch (error) {
      throw usage((error as Error).message);
    }
  }
  return prompt;
}

// "claude:work"; a provider alone, which means its only account, or defaults.account when that
// belongs to the provider (as for relay switch); or nothing, which means defaults.account.
function resolveAccount(ctx: CommandContext, given: string | undefined): Account {
  const { config } = ctx;
  const name = given ?? config.defaults.account;
  if (name === null) {
    throw usage("Name an account, for example relay run claude:personal, or set defaults.account in config.toml.");
  }
  if (isProvider(name)) {
    const accounts = config.accounts.filter((entry) => entry.provider === name);
    const preferred = accounts.find((entry) => entry.id === config.defaults.account);
    if (accounts.length === 1) return accounts[0]!;
    if (preferred !== undefined) return preferred;
    if (accounts.length === 0) {
      throw new CommandError(ExitCode.NoSuchAccount, [
        `You have no ${ACCOUNT_WORD[name]} account. Add one with relay account add ${name} <name>.`,
      ]);
    }
    throw usage(
      `relay: You have ${accounts.length === 2 ? "two" : accounts.length} ${ACCOUNT_WORD[name]} accounts: ` +
        `${accounts.map((entry) => entry.id).join(", ")}. Name one, for example relay run ${accounts[0]!.id}.`,
    );
  }
  const found = findAccount(config, name);
  if (found === undefined) {
    throw new CommandError(ExitCode.NoSuchAccount, [`${printable(name)} is not one of your accounts. See relay account list.`]);
  }
  return found;
}

// The first relay run in a project adds an entry that allows only its account, and asks nothing
// (the provider-allow-list spec, "relay run asks instead of refusing"). Returns whether it did.
// The entry is looked for again in the file as it is while relay holds the config lock, so that two
// first runs at the same time add one entry, not two.
export function allowOnProject(ctx: CommandContext, account: Account, root: string, say: (line: string) => void): boolean {
  if (ctx.config.projects.some((entry) => entry.path === root)) return false;
  const where = { relayHome: ctx.relayHome, homedir: ctx.homedir };
  let added = false;
  const config = editConfig(
    { ...where, uid: process.getuid!() },
    (text) => {
      added = !validateConfig(parseToml(text), where).config.projects.some((entry) => entry.path === root);
      return added ? appendTable(text, `[[projects]]\npath = ${tomlString(root)}\nallow = ["${account.id}"]`) : text;
    },
    (result) => result.projects.some((entry) => entry.path === root),
  );
  if (added) say(`Allowed ${account.id} on this project.`);
  else ctx.config = config;
  return added;
}

// handoff-settings.json: the first run of a job records its mode and permission level, which no
// later handoff may raise, and --check replaces the job's checks.
function updateChecks(ctx: CommandContext, jobId: string, mode: Mode, permission: PermissionLevel, checks: string[] | null): HandoffSettings {
  const settings = readHandoffSettings(ctx.relayHome, jobId)
    ?? { schema_version: 1, job_id: jobId, mode, permission: mode === "headless" ? permission : null, checks: [], next_handoff: 1 };
  if (checks !== null) {
    settings.checks = checks.map((command) => ({ command, timeout_seconds: ctx.config.handoff.checkTimeoutSeconds, added_at: now().toISOString() }));
  }
  writeHandoffSettings(ctx.relayHome, settings);
  return settings;
}

// The newest handoff, when it is prepared or failed to start, targets this account, and the
// working tree still matches its checkpoint, apart from state.json and events.jsonl.
async function reusePrepared(
  ctx: CommandContext, repo: Repository, job: JobRef, account: Account, say: (line: string) => void,
): Promise<HandoffRecord | null> {
  const handoff = newestHandoff(ctx.relayHome, job.id);
  if (handoff === null || handoff.to_account !== account.id || (handoff.outcome !== "prepared" && handoff.outcome !== "start_failed")) return null;
  const state = readState(join(job.worktreeRoot, ".relay"));
  const { tree } = await buildSnapshotTree(repo, {
    jobId: job.id, relayHome: ctx.relayHome, maxFileBytes: ctx.config.checkpoint.maxFileSizeMb * 1024 * 1024, approved: state.approved_paths,
  });
  const result = await git(repo, ["diff-tree", "-r", "--name-only", "-z", handoff.checkpoint.tree, tree]);
  if (result.code !== 0) return null;
  const changed = Buffer.from(result.stdout).toString("utf8").split("\0")
    .filter((path) => path !== "" && path !== ".relay/state.json" && path !== ".relay/events.jsonl" && path !== ".relay/checkpoint.md" && path !== ".relay/verify.md");
  if (changed.length > 0) return null;
  say(`Using the prepared handoff ${handoff.number}`);
  return handoff;
}

// The provider session to resume, or undefined for a new session.
// `last` takes only a session that the program confirmed: one reported by its output or by a hook,
// or one in which a turn completed. A session ID relay chose for a run that never started is not
// one.
function resolveResume(
  relayHome: string, job: JobRef, adapter: ProviderAdapter, account: Account, resume: string | undefined,
): string | undefined {
  if (resume === undefined) return undefined;
  if (resume === "last") {
    const confirmed = new Set<string>();
    for (const event of readEvents(job)) {
      const { worker_id: worker, provider_session_id: session, source } = event.data;
      if (event.type === "worker_session_identified" && (source === "stream" || source === "hook")) confirmed.add(`${worker} ${session}`);
      if (event.type === "turn_completed") confirmed.add(`${worker}`);
    }
    const last = readWorkerRecords(relayHome, job.id).find((entry) => entry.account === account.id
      && typeof entry.provider_session_id === "string"
      && (confirmed.has(`${entry.worker_id} ${entry.provider_session_id}`) || confirmed.has(entry.worker_id)));
    if (last === undefined) throw usage(`This job has no earlier ${adapter.displayName} session on ${account.id} to resume.`);
    return last.provider_session_id!;
  }
  if (!isSessionId(resume)) throw usage("relay: --resume needs a session ID, which is a UUID, or last.");
  // A session is checked against the workers of every job, so that it cannot move to another
  // account through another job.
  const owner = readAllWorkerRecords(relayHome).find((entry) => entry.provider_session_id === resume);
  if (owner !== undefined && owner.account !== account.id) {
    throw new CommandError(ExitCode.Refused, [
      `Session ${printable(resume)} was started on ${owner.account}. relay resumes a session only on the account that started it.`,
    ]);
  }
  return resume;
}

interface WorkerPlan {
  account: Account;
  adapter: ProviderAdapter;
  mode: Mode;
  permission: PermissionLevel;
  instructions: string;
  prompt: string | undefined;
  resume?: string;
  model?: string;
  providerVersion: string | null;
  startCheckpoint: number | null;
  fromHandoff: number | null;
  // A worker started by a handoff must keep running for handoff.start_check_seconds (interactive)
  // or report its session within 60 seconds (headless) to count as started.
  startCheck: boolean;
}

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";
type ExitStatus = { code: number | null; signal: string | null };
type LastTurn = { completed: true } | { completed: false; reason: FailureReason; retryAt?: Date };

interface Ended {
  switched: boolean;
  startFailed: boolean;
  interrupted: boolean;
  terminated: boolean;
  permission: string | null;
  lastTurn: LastTurn | null;
  status: ExitStatus;
}

// One run of one agent under this relay process.
interface Worker {
  plan: WorkerPlan;
  record: WorkerRecord;
  logPath: string;
  started: Promise<StartOutcome>;
  ended: Promise<Ended>;
  held: HeldWorker;
  // Whether a switch stopped the agent.
  isSwitched(): boolean;
  // Stops the agent as SIGTERM to relay would.
  terminate(): void;
}

// The relay process that supervises the job's agents, one after another: it holds the worker lock,
// takes switch requests, and when an agent exits saves a checkpoint and gives the exit code. In the
// daemon, `signals` is false: the daemon keeps its own signal handlers and stops agents itself.
export class JobSupervisor {
  exitCode: number = ExitCode.Ok;
  private lock: WorkerLock | null = null;
  private forgetLock: (() => void) | null = null;
  private stopListening: (() => void) | null = null;
  private switching: Promise<Worker | null> | null = null;
  private current: Worker | null = null;
  constructor(
    private readonly ctx: SupervisorContext,
    private readonly job: JobRef,
    private readonly registry: AdapterRegistry,
    private readonly say: (line: string) => void,
    private readonly json: boolean,
    private readonly signals = true,
  ) {}

  // The worker whose agent runs now, or null.
  runningRecord(): WorkerRecord | null {
    const record = this.current?.record;
    return record !== undefined && record.ended_at === null ? record : null;
  }

  // Takes no more switch requests and waits for the one being served. A request that is not taken
  // is refused by relay switch after 5 seconds, with nothing changed.
  async stopTakingRequests(): Promise<void> {
    this.stopListening?.();
    this.stopListening = null;
    await this.switching?.catch(() => null);
  }

  // Stops the running agent as SIGTERM would and waits until relay has recorded its end.
  async stopRunning(): Promise<void> {
    const worker = this.current;
    if (worker === null) return;
    worker.terminate();
    await worker.ended.catch(() => {});
  }

  close(): void {
    this.stopListening?.();
    this.stopListening = null;
    this.lock?.();
    this.forgetLock?.();
    this.lock = null;
  }

  // Takes the worker lock before the first agent starts, with the fields relay switch reads, and
  // starts listening for switch requests.
  private takeLock(account: Account, workerId: string, mode: Mode): void {
    if (this.lock !== null) {
      this.lock.update({ account: account.id, worker_id: workerId, mode });
      return;
    }
    this.lock = takeWorkerLock(this.ctx.relayHome, this.job.id, account.id, supervisorFields(workerId, mode));
    this.forgetLock = onInterrupt(() => this.lock?.());
    removeOldRequests(this.ctx.relayHome, this.job.id);
    this.stopListening = listenForRequests(() => this.takeRequest());
  }

  // A handoff run by this process, before any agent of it runs (relay run on a job with earlier
  // work, and relay switch without a relay run). Returns the next worker, or null when the handoff
  // was only prepared.
  async handoff(pre: Preflight, asker: Asker): Promise<{ worker: Worker | null; result: HandoffResult }> {
    let next: Worker | null = null;
    let result: HandoffResult;
    try {
      result = await performHandoff({
        pre, env: handoffEnv(this.ctx, this.registry), asker, progress: this.say, restoreTerminal: () => {}, signals: this.signals,
        start: async (plan) => {
          next = await this.begin(this.planFrom(plan));
          return next.started;
        },
      });
    } catch (error) {
      if (error instanceof CommandError && error.code === ExitCode.StartFailed && next !== null) await (next as Worker).ended;
      throw error;
    }
    return { worker: next, result };
  }

  // Starts the agent of a handoff that relay switch --no-start prepared, or whose start failed.
  async startPrepared(handoff: HandoffRecord, account: Account, adapter: ProviderAdapter): Promise<Worker> {
    const folder = join(this.ctx.relayHome, "jobs", this.job.id, "handoffs", String(handoff.number));
    const read = (name: string) => readFileSync(join(folder, name), "utf8");
    this.say(`Starting ${accountLabel(account)}`);
    if (handoff.start.mode === "interactive") this.say(`Continuing on ${displayName(account.provider)}.`);
    const worker = await this.begin(this.planFrom({
      account, adapter, mode: handoff.start.mode, permission: handoff.start.permission, instructions: read("instructions.md"),
      prompt: read("prompt.md"), fromHandoff: handoff.number, startCheckpoint: handoff.checkpoint.number,
    }));
    const started = await worker.started;
    const relayDir = join(this.job.worktreeRoot, ".relay");
    if (started.ok) {
      markHandoff(this.ctx.relayHome, this.job.id, handoff.number, "started", { to_worker_id: started.workerId });
      if (handoff.start.mode === "headless") this.say(`Continuing on ${displayName(account.provider)}.`);
      const state = readState(relayDir);
      if (state.last_handoff !== null && state.last_handoff !== undefined) {
        writeState(relayDir, { ...state, last_handoff: { ...(state.last_handoff as Record<string, unknown>), outcome: "started" } });
      }
      return worker;
    }
    await worker.ended;
    markHandoff(this.ctx.relayHome, this.job.id, handoff.number, "start_failed", { start_error: started.reason });
    const back = handoff.from_account !== null && handoff.from_account !== account.id ? `, or "relay run ${handoff.from_account}" to go back` : "";
    throw new CommandError(ExitCode.StartFailed, [
      `${accountLabel(account)} did not start: ${started.reason}.`,
      `Your work is saved in checkpoint ${handoff.checkpoint.commit.slice(0, 6)}, and the handoff is ready.`,
      `Run "relay run ${account.id}" to try again${back}.`,
    ]);
  }

  private planFrom(plan: StartPlan): WorkerPlan {
    return {
      account: plan.account, adapter: plan.adapter, mode: plan.mode, permission: plan.permission ?? "edit-in-workspace",
      instructions: plan.instructions, prompt: plan.prompt, providerVersion: null, startCheckpoint: plan.startCheckpoint,
      fromHandoff: plan.fromHandoff, startCheck: true,
    };
  }

  // Supervises workers until the last one ends, then saves a checkpoint and returns the exit code.
  async supervise(first: Worker): Promise<number> {
    let worker = first;
    for (;;) {
      const ended = await worker.ended;
      if (ended.switched) {
        const next = await this.switching;
        this.switching = null;
        if (next === null) return this.exitCode;
        worker = next;
        continue;
      }
      return await this.finish(worker, ended);
    }
  }

  // Starts an agent through its adapter and watches its events until it exits.
  async begin(plan: WorkerPlan): Promise<Worker> {
    const { ctx, job } = this;
    const { account, adapter } = plan;
    const headless = plan.mode === "headless";
    const workerId = newUnusedWorkerId(ctx.relayHome, job.id);
    this.takeLock(account, workerId, plan.mode);
    deleteOldWorkerLogs(ctx.relayHome);
    const logPath = join(ctx.relayHome, "logs", "workers", `${job.id}-${workerId}.log`);
    const startedAt = now();
    // Read before the start, so that a reading the agent records while it starts is reported.
    const baseline = availabilityKey(readAvailability(ctx.relayHome, account));
    let handle: WorkerHandle;
    try {
      handle = await adapter.start(account, {
        jobId: job.id, workerId, cwd: job.worktreeRoot, mode: plan.mode, instructions: plan.instructions,
        ...(plan.prompt === undefined ? {} : { prompt: plan.prompt }),
        ...(plan.resume === undefined ? {} : { resumeSessionId: plan.resume }),
        permission: plan.permission,
        ...(plan.model === undefined ? {} : { model: plan.model }),
        env: buildAgentEnv(account, ctx.env, { jobId: job.id, workerId }), logPath,
      });
    } catch (error) {
      if (!plan.startCheck) throw error;
      const reason = printable((error as Error).message.replace(/\.$/, ""));
      const record = this.newRecord(plan, workerId, startedAt, null);
      const status = { code: null, signal: null };
      return {
        plan, record, logPath, started: Promise.resolve({ ok: false, reason }),
        ended: Promise.resolve({ switched: false, startFailed: true, interrupted: false, terminated: false, permission: null, lastTurn: null, status }),
        held: { record, stop: async () => ({ how: "already_exited", exitCode: null, alive: false }), lastFailure: () => null },
        isSwitched: () => false, terminate: () => {},
      };
    }
    const record = this.newRecord(plan, workerId, startedAt, handle);
    try {
      writeWorkerRecord(ctx.relayHome, record);
      await appendEvent(job, "worker_started", {
        worker_id: workerId, target: account.id, provider: account.provider, mode: plan.mode, transport: handle.transport,
        provider_version: plan.providerVersion, permission: record.permission, pid: handle.pid,
        provider_session_id: record.provider_session_id, argv: handle.argv, resumed_from: record.resumed_from,
        from_handoff: plan.fromHandoff, start_checkpoint: plan.startCheckpoint,
      });
    } catch (error) {
      // The agent started, so it is stopped, and the record says it ended, as far as the disk allows.
      await handle.stop({ timeoutMs: INTERRUPT_WAIT_MS }).catch(() => {});
      try {
        const status = await handle.wait();
        writeWorkerRecord(ctx.relayHome, { ...record, ended_at: now().toISOString(), end_reason: "relay_stopped", exit_code: status.code, signal: status.signal });
      } catch {
        // The error being reported matters more than the record.
      }
      throw error;
    }
    this.setCurrentWorker({ id: workerId, account: account.id, mode: plan.mode, started_at: record.started_at, from_handoff: plan.fromHandoff });

    let stopping: Promise<StopResult> | undefined;
    let switched = false;
    // A headless turn starts with the agent, because the prompt is its first message.
    let turnOpen = headless;
    let interrupted = false;
    let terminated = false;
    let permission: string | null = null;
    let lastTurn: LastTurn | null = null;
    const stop = (timeoutMs?: number) => {
      if (stopping !== undefined && timeoutMs === undefined) return;
      stopping = handle.stop(timeoutMs === undefined ? {} : { timeoutMs });
    };
    // Ctrl+C reaches relay only in a headless run: the first interrupts the turn, which ends the run,
    // and the second stops the agent at once. SIGTERM and SIGHUP stop the agent; a second signal
    // stops it at once. Once the agent has exited, the outcome is fixed and later signals change
    // nothing.
    let signals = 0;
    let exited = false;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    const onSignal = (signal: Signal) => {
      if ((signal === "SIGINT" && !headless) || exited || switched) return;
      if (signal === "SIGINT") interrupted = true;
      else terminated = true;
      if (++signals > 1) stop(0);
      else if (signal === "SIGINT" && turnOpen) {
        void handle.interrupt().catch(() => stop());
        // A turn that does not end after the interrupt is stopped like any other.
        interruptTimer = setTimeout(() => stop(), INTERRUPT_WAIT_MS);
      } else stop();
    };
    const restoreSignals = this.signals ? takeSignals(onSignal) : () => {};

    let resolveStarted!: (outcome: StartOutcome) => void;
    const started = new Promise<StartOutcome>((done) => { resolveStarted = done; });
    let startSettled = !plan.startCheck;
    const settleStart = (outcome: StartOutcome) => {
      if (startSettled) return;
      startSettled = true;
      resolveStarted(outcome);
    };
    if (!plan.startCheck) resolveStarted({ ok: true, workerId });
    const startTimer = plan.startCheck && !headless
      ? setTimeout(() => settleStart({ ok: true, workerId }), ctx.config.handoff.startCheckSeconds * 1000)
      : plan.startCheck ? setTimeout(() => {
        settleStart({ ok: false, reason: `${adapter.displayName} did not report a session within 60 seconds` });
        stop();
      }, HEADLESS_START_MS) : undefined;

    const facts = new Facts(ctx, job, account, record, baseline);
    const print = (line: string) => {
      if (headless && !this.json) ctx.io.out(`${line}\n`);
    };
    const watched = (async (): Promise<Ended> => {
      let sessionShown = false;
      let status: ExitStatus | undefined;
      // In a terminal run, a status-line reading changes availability.json without a worker event.
      const watch = headless ? undefined : setInterval(() => void facts.queue(() => facts.availability()).catch(() => {}), 1000);
      try {
        for await (const event of handle.events()) {
          if (this.json) ctx.io.out(`${jsonLine(workerId, event)}\n`);
          if (event.kind === "exited") {
            status = { code: event.code, signal: event.signal };
            break;
          }
          if (event.kind === "session_started") {
            if (headless) settleStart({ ok: true, workerId });
            if (!sessionShown) {
              sessionShown = true;
              print(sessionLine(adapter.displayName, account.id, event.providerSessionId));
            }
          }
          for (const line of progressLines(event, adapter.displayName, facts.relativePaths(event, job.worktreeRoot))) print(line);
          await facts.queue(() => facts.write(event));
          if (event.kind === "turn_completed" || event.kind === "turn_failed") {
            lastTurn = event.kind === "turn_completed" ? { completed: true }
              : { completed: false, reason: event.reason, ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }) };
            turnOpen = false;
            if (interrupted || terminated) stop();
          }
          if (event.kind === "approval_needed" && headless) {
            // relay never answers a permission request, so the agent would otherwise wait for ever.
            permission ??= `${adapter.displayName} asked for permission to ${printable(redact(event.summary, 200))}.`;
            stop();
          }
          if (event.kind === "permission_denied") permission ??= `${adapter.displayName} was not allowed to use ${printable(event.tool)}.`;
        }
      } finally {
        if (watch !== undefined) clearInterval(watch);
      }
      status ??= await handle.wait();
      exited = true;
      clearTimeout(startTimer);
      clearTimeout(interruptTimer);
      restoreSignals();
      const stopped = stopping === undefined ? null : await stopping;
      if (!headless && !switched) restoreTerminal(ctx);
      await facts.queue(() => facts.availability());
      const seconds = Math.round((now().getTime() - startedAt.getTime()) / 1000);
      const startFailed = !startSettled && status.code !== 0;
      if (startFailed) {
        settleStart({ ok: false, reason: `${printable(account.provider)} exited with code ${status.code ?? status.signal} after ${seconds} ${seconds === 1 ? "second" : "seconds"}` });
        if (!headless) restoreTerminal(ctx);
      }
      settleStart({ ok: true, workerId });
      const endReason: EndReason = switched ? "stopped_by_switch" : startFailed ? "start_failed" : interrupted ? "interrupted"
        : stopped !== null ? "relay_stopped" : "exited";
      await facts.queue(() => facts.finish(endReason, status!, stopped, now(), startedAt));
      if (this.current?.record.worker_id === workerId) this.setCurrentWorker(null);
      return { switched, startFailed, interrupted, terminated, permission, lastTurn, status };
    })();
    // An error while relay watches the agent stops it and writes the end of the worker record, as far
    // as the disk allows, before the error is reported.
    const ended = watched.catch(async (error: unknown) => {
      restoreSignals();
      clearTimeout(startTimer);
      settleStart({ ok: false, reason: printable((error as Error).message) });
      await handle.stop({ timeoutMs: INTERRUPT_WAIT_MS }).catch(() => {});
      if (record.ended_at === null) {
        try {
          const status = await handle.wait();
          writeWorkerRecord(ctx.relayHome, { ...record, ended_at: now().toISOString(), end_reason: "relay_stopped", exit_code: status.code, signal: status.signal });
        } catch {
          // The error being reported matters more than the record.
        }
      }
      throw error;
    });

    const held: HeldWorker = {
      record,
      lastFailure: () => (lastTurn !== null && !lastTurn.completed ? lastTurn.reason : null),
      stop: async (timeoutMs) => {
        switched = true;
        stop(timeoutMs);
        // The adapter sends SIGKILL at the time limit; a process that outlives that did not stop.
        const done = await Promise.race([ended.then(() => true), Bun.sleep(timeoutMs + 10_000).then(() => false)]);
        if (!done) return { how: "killed", exitCode: null, alive: true };
        const result = await stopping!;
        return { how: result.how, exitCode: result.exitCode, alive: false };
      },
    };
    const worker: Worker = { plan, record, logPath, started, ended, held, isSwitched: () => switched, terminate: () => onSignal("SIGTERM") };
    this.current = worker;
    return worker;
  }

  private newRecord(plan: WorkerPlan, workerId: string, startedAt: Date, handle: WorkerHandle | null): WorkerRecord {
    const headless = plan.mode === "headless";
    return {
      worker_id: workerId, job_id: this.job.id, account: plan.account.id, provider: plan.account.provider, mode: plan.mode,
      transport: handle?.transport ?? (plan.account.provider === "claude" ? (headless ? "claude-print" : "claude-interactive") : (headless ? "codex-app-server" : "codex-interactive")),
      provider_version: plan.providerVersion, provider_session_id: handle?.presetSessionId ?? plan.resume ?? null,
      pid: handle?.pid ?? null, cwd: this.job.worktreeRoot, permission: headless ? plan.permission : null, argv: handle?.argv ?? [],
      resumed_from: plan.resume ?? null, started_at: startedAt.toISOString(), ended_at: null, exit_code: null,
      signal: null, end_reason: null, log_path: headless ? join(this.ctx.relayHome, "logs", "workers", `${this.job.id}-${workerId}.log`) : null,
      last_failure: null, from_handoff: plan.fromHandoff, start_checkpoint: plan.startCheckpoint,
    };
  }

  // state.json's current_worker, a readable copy of what relay holds under RELAY_HOME. It is
  // written under the job lock; when another relay command holds the lock, the copy waits.
  private setCurrentWorker(value: Record<string, unknown> | null): void {
    const relayDir = join(this.job.worktreeRoot, ".relay");
    let release: () => void;
    try {
      release = takeJobLock(this.ctx.relayHome, this.job.id, "run");
    } catch {
      return;
    }
    try {
      const state = readState(relayDir);
      writeState(relayDir, { ...state, current_worker: value, updated_at: now().toISOString() });
    } catch {
      // A damaged state.json is reported by the next command that needs it.
    } finally {
      release();
    }
  }

  // Takes a switch request from relay switch in another terminal, while an agent runs. The
  // switch runs here, where the agent runs; its lines go to this terminal and to relay switch.
  private takeRequest(): void {
    const worker = this.current;
    if (this.switching !== null || worker === null) return;
    const taken = takeSwitchRequest(this.ctx.relayHome, this.job.id);
    if (taken === null) return;
    const print = requestPrinter(this.ctx.relayHome, this.job.id, taken.id);
    const say = (line: string) => {
      print(line);
      this.ctx.io.out(`${line}\n`);
    };
    let resolveNext!: (next: Worker | null) => void;
    this.switching = new Promise((done) => { resolveNext = done; });
    void this.serveRequest(worker, taken.request, say).then(
      ({ worker: next, result }) => {
        writeSwitchReply(this.ctx.relayHome, this.job.id, taken.id, { exit_code: ExitCode.Ok, errors: [], result });
        resolveNext(next);
      },
      (error: unknown) => {
        const code = error instanceof CommandError ? error.code : ExitCode.Internal;
        const errors = error instanceof CommandError ? error.lines : [`relay could not finish the switch: ${printable((error as Error).message)}`];
        writeSwitchReply(this.ctx.relayHome, this.job.id, taken.id, { exit_code: code, errors, result: null });
        if (!worker.isSwitched()) {
          // Refused before the agent was stopped: it keeps working under this relay run.
          this.switching = null;
          return;
        }
        this.exitCode = code;
        this.ctx.io.err(stderrText(errors));
        resolveNext(null);
      },
    );
  }

  private async serveRequest(worker: Worker, request: SwitchRequest, print: (line: string) => void): Promise<{ worker: Worker | null; result: Record<string, unknown> }> {
    const env = handoffEnv(this.ctx, this.registry);
    const asker: Asker = { terminal: false, yes: false, say: print, ask: async () => null,
      preset: request.answers === undefined ? undefined : { ...request.answers, recorded: true } };
    const pre = await preflight(env, {
      cwd: this.job.worktreeRoot, arg: request.to, command: "switch", startMode: request.no_start ? "none" : worker.plan.mode,
      noSummary: request.ask_for_notes === "flag", newChecks: request.new_checks, asker, held: worker.held,
    });
    let next: Worker | null = null;
    const result = await performHandoff({
      pre, env, asker, progress: print, signals: this.signals,
      restoreTerminal: () => {
        if (worker.plan.mode === "interactive") restoreTerminal(this.ctx);
      },
      start: async (plan) => {
        next = await this.begin(this.planFrom(plan));
        return next.started;
      },
    });
    return { worker: next, result: switchJson(result) };
  }

  // After the last agent ends: the closing lines, a checkpoint of kind auto, and the exit code.
  private async finish(worker: Worker, ended: Ended): Promise<number> {
    const code = outcome(this.ctx, worker, ended, this.say);
    const { account } = worker.plan;
    const label = accountLabel(account);
    const how = ended.status.code !== null ? `exit code ${ended.status.code}` : `signal ${ended.status.signal}`;
    this.say(`${label} stopped (${how})`);
    try {
      const saved = await saveCheckpoint(await openRepository(this.job.worktreeRoot), {
        relayHome: this.ctx.relayHome, command: "run", kind: "auto", maxFileSizeMb: this.ctx.config.checkpoint.maxFileSizeMb, env: this.ctx.env,
      });
      if (saved.saved) this.say(`Saved checkpoint ${saved.commit.slice(0, 6)}`);
      else {
        const latest = readState(join(this.job.worktreeRoot, ".relay")).latest_checkpoint;
        this.say(latest === null ? "No changes to save" : `No changes since checkpoint ${latest.commit.slice(0, 6)}`);
      }
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      this.ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return error.code;
    }
    return code;
  }
}

// The --json result of a switch (add-relay-switch, design decision 24).
export function switchJson(result: HandoffResult): Record<string, unknown> {
  return {
    handoff_id: result.number, checkpoint_sha: result.checkpoint.commit, prompt_path: result.promptPath, to_worker_id: result.toWorkerId,
    outcome: result.outcome, notes_source: result.notesSource, mismatches: result.mismatches.length,
  };
}

// The closing lines and the exit code (the agent-runs spec, "Headless exit codes" and
// "Interactive runs").
function outcome(ctx: SupervisorContext, worker: Worker, result: Ended, say: (line: string) => void): number {
  const { adapter, account } = worker.plan;
  const err = (line: string) => ctx.io.err(`${line}\n`);
  const { lastTurn, status } = result;
  const limit = lastTurn !== null && !lastTurn.completed && (lastTurn.reason === "usage_limit" || lastTurn.reason === "rate_limit")
    ? { reason: lastTurn.reason, retryAt: lastTurn.retryAt } : null;
  if (result.interrupted) {
    const sessionId = worker.record.provider_session_id;
    err(sessionId === null ? "Interrupted." : `Interrupted. Resume with relay run ${account.id} --resume ${printable(sessionId)}`);
    return ExitCode.Interrupted;
  }
  if (result.terminated) return ExitCode.Terminated;
  if (worker.plan.mode === "interactive") say(`Recorded worker ${worker.record.worker_id} (${account.id}).`);
  if (limit !== null) {
    err(limitLine(adapter.displayName, limit.reason, limit.retryAt));
    return ExitCode.LimitReached;
  }
  if (worker.plan.mode === "interactive") return status.code ?? signalExitCode(status.signal);
  if (result.permission !== null) {
    err(`${result.permission} relay does not answer permission requests; run relay run ${account.id} in your terminal to answer it yourself.`);
    return ExitCode.AgentFailed;
  }
  if (lastTurn !== null && !lastTurn.completed && lastTurn.reason !== "crashed") {
    err(failureLine(adapter.displayName, lastTurn.reason, worker.logPath));
    return ExitCode.AgentFailed;
  }
  if (lastTurn?.completed !== true || status.code !== 0) {
    err(failureLine(adapter.displayName, "crashed", worker.logPath));
    return ExitCode.AgentFailed;
  }
  return ExitCode.Ok;
}

// Replaces relay's own handlers for SIGINT, SIGTERM and SIGHUP while the agent runs, and returns
// the function that puts them back.
function takeSignals(handler: (signal: Signal) => void): () => void {
  const saved = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((name) => {
    const listeners = process.rawListeners(name);
    process.removeAllListeners(name);
    const own = () => handler(name);
    process.on(name, own);
    return { name, listeners, own };
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { name, listeners, own } of saved) {
      process.removeListener(name, own);
      for (const listener of listeners) process.on(name, listener as () => void);
    }
  };
}

function newUnusedWorkerId(relayHome: string, jobId: string): string {
  for (;;) {
    const id = newWorkerId();
    if (!existsSync(workerRecordPath(relayHome, jobId, id))) return id;
  }
}

// After an interactive agent, relay puts the terminal back in its usual state before printing,
// in case the agent ended without doing so.
function restoreTerminal(ctx: SupervisorContext): void {
  if (!ctx.io.isTerminal) return;
  ctx.io.out(RESTORE_TERMINAL);
  try {
    Bun.spawnSync(["stty", "sane"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
  } catch {
    // Without stty, the escape sequences above are all relay can do.
  }
}

// The shell's exit code for a process ended by a signal: 128 plus the signal number.
function signalExitCode(signal: string | null): number {
  const number = signal === null ? undefined : osConstants.signals[signal as keyof typeof osConstants.signals];
  return number === undefined ? ExitCode.Failed : 128 + number;
}

// The facts relay writes while the worker runs: job events, the worker record and availability
// events. Writes happen one after another, so the events keep their order.
class Facts {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: SupervisorContext,
    private readonly job: JobRef,
    private readonly account: Account,
    private readonly record: WorkerRecord,
    private lastAvailability: string,
  ) {}

  queue(write: () => Promise<void>): Promise<void> {
    const next = this.chain.then(write);
    this.chain = next.catch(() => {});
    return next;
  }

  // The files a completed file change touched, relative to the worktree root when they are in it.
  relativePaths(event: WorkerEvent, root: string): string[] {
    if (event.kind !== "tool" || event.status !== "completed" || event.paths === undefined) return [];
    return event.paths.map((path) => {
      const inside = relative(root, resolve(root, path));
      return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
    });
  }

  async write(event: WorkerEvent): Promise<void> {
    const { job } = this;
    const worker_id = this.record.worker_id;
    switch (event.kind) {
      case "session_started":
        if (this.record.provider_session_id !== event.providerSessionId) {
          this.record.provider_session_id = event.providerSessionId;
          writeWorkerRecord(this.ctx.relayHome, this.record);
        }
        await appendEvent(job, "worker_session_identified", {
          worker_id, provider_session_id: event.providerSessionId, model: event.model ?? null, source: event.source,
        });
        return;
      case "tool": {
        if (event.status === "started") return;
        if (event.command !== undefined) {
          await appendEvent(job, "command_ran", {
            worker_id, command: redact(event.command), exit_code: event.exitCode ?? null, status: event.status,
          });
        }
        const paths = this.relativePaths(event, job.worktreeRoot);
        if (paths.length > 0) await appendEvent(job, "file_changed", { worker_id, paths });
        return;
      }
      case "turn_completed":
        await appendEvent(job, "turn_completed", {
          worker_id, duration_ms: event.durationMs ?? null,
          usage: {
            input_tokens: event.usage?.inputTokens ?? null, cached_input_tokens: event.usage?.cachedInputTokens ?? null,
            output_tokens: event.usage?.outputTokens ?? null, reasoning_output_tokens: event.usage?.reasoningOutputTokens ?? null,
          },
          cost_usd_estimate: event.costUsdEstimate ?? null,
        });
        return this.availability();
      case "turn_failed":
        // relay's own record keeps the reason, written when the worker ends, so a handoff never
        // takes it from the event log.
        this.record.last_failure = event.reason;
        await appendEvent(job, "turn_failed", {
          worker_id, reason: event.reason, retry_at: event.retryAt?.toISOString() ?? null, source: event.source,
        });
        return this.availability();
      case "approval_needed":
        await appendEvent(job, "approval_requested", { worker_id, summary: redact(event.summary, 200) });
        return;
      case "permission_denied":
        await appendEvent(job, "permission_denied", { worker_id, tool: event.tool });
        return;
      default:
    }
  }

  // Appends an availability event when the account's state or windows changed since the last
  // reading this run saw. The adapter records each reading in availability.json as it arrives;
  // relay run reports the change when a turn ends, when the worker ends, and every second while an
  // agent runs in the terminal.
  async availability(): Promise<void> {
    const reading = readAvailability(this.ctx.relayHome, this.account);
    const key = availabilityKey(reading);
    if (key === this.lastAvailability) return;
    this.lastAvailability = key;
    await appendEvent(this.job, "availability", {
      worker_id: this.record.worker_id, target: this.account.id, status: reading.state, reason: reading.detail ?? null,
      retry_at: reading.retryAt?.toISOString() ?? null, measured_at: reading.observedAt.toISOString(), source: reading.source,
      windows: reading.windows.map((window) => ({
        name: window.name, window_minutes: window.windowMinutes ?? null, used_percent: window.usedPercent ?? null,
        resets_at: window.resetsAt?.toISOString() ?? null,
      })),
    });
  }

  async finish(endReason: EndReason, status: ExitStatus, stopped: StopResult | null, ended: Date, started: Date): Promise<void> {
    Object.assign(this.record, { ended_at: ended.toISOString(), exit_code: status.code, signal: status.signal, end_reason: endReason });
    writeWorkerRecord(this.ctx.relayHome, this.record);
    await appendEvent(this.job, "worker_ended", {
      worker_id: this.record.worker_id, exit_code: status.code, signal: status.signal, end_reason: endReason,
      stop_how: stopped?.how ?? null, seconds: Math.round((ended.getTime() - started.getTime()) / 1000),
    });
  }
}

function availabilityKey(reading: Availability): string {
  return JSON.stringify([reading.state, reading.retryAt?.toISOString() ?? null,
    reading.windows.map((window) => [window.name, window.usedPercent ?? null, window.resetsAt?.toISOString() ?? null])]);
}
