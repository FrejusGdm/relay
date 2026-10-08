// relay run (the agent-runs spec; add-provider-adapters, design decision 15): the checks before an
// agent starts, the worker lock, the worker record, the job events, the progress output and the
// exit code. The agent is always started through its adapter, which builds its command line.
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readAvailability } from "../accounts/availability";
import { buildAgentEnv } from "../accounts/environment";
import { checkProfileFolder } from "../accounts/profile";
import { authFact, readAccountRecord, updateAccountRecord } from "../accounts/record";
import { findAccount, isProvider } from "../accounts/registry";
import { deleteOldWorkerLogs } from "../adapters/process";
import { createAdapterRegistry } from "../adapters/registry";
import { tomlString } from "../adapters/text";
import type {
  Availability, FailureReason, Mode, PermissionLevel, ProviderAdapter, StopResult, WorkerEvent, WorkerHandle,
} from "../adapters/types";
import { textForAgent } from "../adapters/worker";
import { ACCOUNT_WORD } from "../cli/commands/policy";
import type { CommandContext } from "../cli/commands/registry";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { appendTable, editConfig } from "../core/config/edit";
import type { Account } from "../core/config/types";
import { onInterrupt } from "../core/cleanup";
import { printable, quote } from "../core/quote";
import { appendEvent, type JobRef } from "../job/events";
import { takeWorkerLock } from "../job/lock";
import { now } from "../platform/clock";
import { redact } from "../secrets/redact";
import { relayInstructions } from "./instructions";
import { findJobContext } from "./job-context";
import { failureLine, jsonLine, limitLine, progressLines, sessionLine } from "./progress";
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
}

const PERMISSIONS = ["read-only", "edit-in-workspace", "full-access"];
// How long a turn may take to end after Ctrl+C before relay stops the agent, as the adapters wait.
const INTERRUPT_WAIT_MS = 10_000;
// Leaves the alternate screen, shows the cursor and resets styles, in case the agent did not.
const RESTORE_TERMINAL = "\x1b[?1049l\x1b[?25h\x1b[0m";

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line]);
}

export async function runAgent(ctx: CommandContext, options: RunOptions): Promise<number> {
  const prompt = readPrompt(ctx, options);
  if (options.permission !== undefined && !PERMISSIONS.includes(options.permission)) {
    throw usage("relay: --permission must be read-only, edit-in-workspace or full-access.");
  }
  if (options.json && !options.headless) throw usage("relay: --json works only with --headless.");
  if (options.headless && prompt === undefined) throw usage("A headless run needs --prompt or --prompt-file.");

  const { job, state } = await findJobContext(ctx.cwd, ctx.relayHome);
  const account = resolveAccount(ctx, options.account);
  const adapter = createAdapterRegistry({}, ctx.env).get(account.provider);
  const detection = await adapter.detect();
  if (!detection.installed) {
    throw new CommandError(ExitCode.ProviderMissing, [`${adapter.displayName} is not installed. Install it, then try again.`]);
  }
  if (detection.tooOld !== undefined) {
    throw new CommandError(ExitCode.ProviderMissing, [
      `relay needs ${adapter.displayName} ${detection.tooOld.oldest} or newer. You have ${detection.version}. ` +
        `Update ${adapter.displayName}, then try again.`,
    ]);
  }
  checkProfileFolder(account.profileDir, process.getuid!(), ctx.homedir);
  await checkSignIn(ctx, adapter, account);
  if (options.permission === "full-access") {
    throw new CommandError(ExitCode.Refused, ["relay does not start agents with full access in this version."]);
  }
  // With --json, lines that are not worker events go to standard error, so that standard output
  // holds only one JSON object per line.
  const say = (line: string) => (options.json ? ctx.io.err(`${line}\n`) : ctx.io.out(`${line}\n`));
  allowOnProject(ctx, account, job.worktreeRoot, say);
  if (readAccountRecord(ctx.relayHome, account).policy_checked_on_seen !== adapter.policy.checkedOn) {
    say(`The ${adapter.displayName} policy notes changed since you last saw them. Read them with relay policy show ${account.provider}.`);
    updateAccountRecord(ctx.relayHome, account, { policy_checked_on_seen: adapter.policy.checkedOn, policy_seen_at: now().toISOString() });
  }

  const release = takeWorkerLock(ctx.relayHome, job.id, account.id);
  const forget = onInterrupt(release);
  try {
    const resume = resolveResume(ctx.relayHome, job.id, adapter, account, options.resume);
    return await supervise(ctx, {
      job, adapter, account, prompt, resume, model: options.model, json: options.json,
      permission: options.permission === "read-only" ? "read-only" : "edit-in-workspace",
      mode: options.headless ? "headless" : "interactive", providerVersion: detection.version ?? null,
      startCheckpoint: state.latest_checkpoint?.number ?? null,
    });
  } finally {
    release();
    forget();
  }
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

async function checkSignIn(ctx: CommandContext, adapter: ProviderAdapter, account: Account): Promise<void> {
  if (account.credentialEnv.length > 0) {
    const missing = account.credentialEnv.find((name) => !ctx.env[name]);
    if (missing !== undefined) throw new CommandError(ExitCode.NotSignedIn, [`${account.id} needs $${missing}, which is not set.`]);
    return;
  }
  const status = await adapter.authStatus(account, buildAgentEnv(account, ctx.env));
  updateAccountRecord(ctx.relayHome, account, { last_auth: authFact(status) });
  if (!status.signedIn) {
    throw new CommandError(ExitCode.NotSignedIn, [`${account.id} is not signed in. Run relay account login ${account.id}.`]);
  }
}

// The project's allow list (the agent-runs spec, "The project allow list"): the first run adds an
// entry that allows only its account; a later run on another account is refused.
function allowOnProject(ctx: CommandContext, account: Account, root: string, say: (line: string) => void): void {
  const project = ctx.config.projects.find((entry) => entry.path === root);
  if (project === undefined) {
    editConfig(
      { relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!() },
      (text) => appendTable(text, `[[projects]]\npath = ${tomlString(root)}\nallow = ["${account.id}"]`),
      (result) => result.projects.some((entry) => entry.path === root && entry.allow.includes(account.id)),
    );
    say(`Allowed ${account.id} on this project.`);
    return;
  }
  if (project.allow.includes(account.id)) return;
  throw new CommandError(ExitCode.Refused, [
    `This project allows only ${project.allow.length === 0 ? "no account" : project.allow.join(", ")}. ` +
      `To hand the job to ${account.id}, use relay switch, which asks before your code goes to another company.`,
  ]);
}

// The provider session to resume, or undefined for a new session.
function resolveResume(
  relayHome: string, jobId: string, adapter: ProviderAdapter, account: Account, resume: string | undefined,
): string | undefined {
  if (resume === undefined) return undefined;
  if (resume === "last") {
    const last = readWorkerRecords(relayHome, jobId)
      .find((entry) => entry.account === account.id && typeof entry.provider_session_id === "string");
    if (last === undefined) throw usage(`This job has no earlier ${adapter.displayName} session on ${account.id} to resume.`);
    return last.provider_session_id!;
  }
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

interface Supervision {
  job: JobRef;
  adapter: ProviderAdapter;
  account: Account;
  prompt: string | undefined;
  resume: string | undefined;
  permission: PermissionLevel;
  model: string | undefined;
  json: boolean;
  mode: Mode;
  providerVersion: string | null;
  startCheckpoint: number | null;
}

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";
type ExitStatus = { code: number | null; signal: string | null };
type LastTurn = { completed: true } | { completed: false; reason: FailureReason; retryAt?: Date };

async function supervise(ctx: CommandContext, run: Supervision): Promise<number> {
  const { job, adapter, account } = run;
  const headless = run.mode === "headless";
  let handle: WorkerHandle | undefined;
  let stopping: Promise<StopResult> | undefined;
  // A headless turn starts with the agent, because the prompt is its first message.
  let turnOpen = headless;
  let interrupted = false;
  let terminated = false;
  let permission: string | null = null;
  const stop = (timeoutMs?: number) => {
    if (handle === undefined || (stopping !== undefined && timeoutMs === undefined)) return;
    stopping = handle.stop(timeoutMs === undefined ? {} : { timeoutMs });
  };
  // Ctrl+C reaches relay only in a headless run: the first interrupts the turn, which ends the run,
  // and the second stops the agent at once. SIGTERM and SIGHUP stop the agent; a second signal
  // stops it at once.
  // Once the agent has exited, the outcome is fixed and later signals change nothing.
  let signals = 0;
  let exited = false;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const onSignal = (signal: Signal) => {
    if ((signal === "SIGINT" && !headless) || exited) return;
    if (signal === "SIGINT") interrupted = true;
    else terminated = true;
    if (++signals > 1) stop(0);
    else if (signal === "SIGINT" && turnOpen && handle !== undefined) {
      void handle.interrupt().catch(() => stop());
      // A turn that does not end after the interrupt is stopped like any other.
      interruptTimer = setTimeout(() => stop(), INTERRUPT_WAIT_MS);
    } else stop();
  };
  const restoreSignals = takeSignals(onSignal);
  try {
    const workerId = newUnusedWorkerId(ctx.relayHome, job.id);
    deleteOldWorkerLogs(ctx.relayHome);
    const logPath = join(ctx.relayHome, "logs", "workers", `${job.id}-${workerId}.log`);
    const startedAt = now();
    handle = await adapter.start(account, {
      jobId: job.id, workerId, cwd: job.worktreeRoot, mode: run.mode,
      instructions: relayInstructions(job.id, job.worktreeRoot),
      ...(run.prompt === undefined ? {} : { prompt: run.prompt }),
      ...(run.resume === undefined ? {} : { resumeSessionId: run.resume }),
      permission: run.permission,
      ...(run.model === undefined ? {} : { model: run.model }),
      env: buildAgentEnv(account, ctx.env, { jobId: job.id, workerId }), logPath,
    });
    if (interrupted || terminated) stop();
    const record: WorkerRecord = {
      worker_id: workerId, job_id: job.id, account: account.id, provider: account.provider, mode: run.mode,
      transport: handle.transport, provider_version: run.providerVersion, provider_session_id: handle.presetSessionId ?? run.resume ?? null,
      pid: handle.pid, cwd: job.worktreeRoot, permission: headless ? run.permission : null, argv: handle.argv,
      resumed_from: run.resume ?? null, started_at: startedAt.toISOString(), ended_at: null, exit_code: null,
      signal: null, end_reason: null, log_path: headless ? logPath : null,
    };
    writeWorkerRecord(ctx.relayHome, record);
    await appendEvent(job, "worker_started", {
      worker_id: workerId, target: account.id, provider: account.provider, mode: run.mode, transport: handle.transport,
      provider_version: run.providerVersion, permission: record.permission, pid: handle.pid,
      provider_session_id: record.provider_session_id, argv: handle.argv, resumed_from: record.resumed_from,
      from_handoff: null, start_checkpoint: run.startCheckpoint,
    });

    const facts = new Facts(ctx, run, record);
    const print = (line: string) => {
      if (headless && !run.json) ctx.io.out(`${line}\n`);
    };
    let sessionShown = false;
    let lastTurn: LastTurn | null = null;
    let status: ExitStatus | undefined;
    // In a terminal run, a status-line reading changes availability.json without a worker event.
    const watch = headless ? undefined : setInterval(() => void facts.queue(() => facts.availability()), 1000);
    try {
      for await (const event of handle.events()) {
        if (run.json) ctx.io.out(`${jsonLine(workerId, event)}\n`);
        if (event.kind === "exited") {
          status = { code: event.code, signal: event.signal };
          break;
        }
        if (event.kind === "session_started" && !sessionShown) {
          sessionShown = true;
          print(sessionLine(adapter.displayName, account.id, event.providerSessionId));
        }
        for (const line of progressLines(event, adapter.displayName, facts.relativePaths(event))) print(line);
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
    const stopped = stopping === undefined ? null : await stopping;
    if (!headless) restoreTerminal(ctx);
    await facts.queue(() => facts.availability());
    const endReason: EndReason = interrupted ? "interrupted" : stopped !== null ? "relay_stopped" : "exited";
    const ended = now();
    await facts.queue(() => facts.finish(endReason, status!, stopped, ended, startedAt));
    return outcome(ctx, run, { workerId, logPath, interrupted, terminated, permission, lastTurn, status, sessionId: facts.sessionId() });
  } catch (error) {
    // The worker lock is released after this, so an agent that is still running is stopped first.
    if (handle !== undefined) await handle.stop({ timeoutMs: INTERRUPT_WAIT_MS }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(interruptTimer);
    restoreSignals();
  }
}

interface Outcome {
  workerId: string;
  logPath: string;
  interrupted: boolean;
  terminated: boolean;
  permission: string | null;
  lastTurn: LastTurn | null;
  status: ExitStatus;
  sessionId: string | null;
}

// The closing lines and the exit code (the agent-runs spec, "Headless exit codes" and
// "Interactive runs").
function outcome(ctx: CommandContext, run: Supervision, result: Outcome): number {
  const { adapter, account } = run;
  const err = (line: string) => ctx.io.err(`${line}\n`);
  const { lastTurn, status } = result;
  const limit = lastTurn !== null && !lastTurn.completed && (lastTurn.reason === "usage_limit" || lastTurn.reason === "rate_limit")
    ? { reason: lastTurn.reason, retryAt: lastTurn.retryAt } : null;
  if (result.interrupted) {
    err(result.sessionId === null ? "Interrupted." : `Interrupted. Resume with relay run ${account.id} --resume ${printable(result.sessionId)}`);
    return ExitCode.Interrupted;
  }
  if (result.terminated) return ExitCode.Terminated;
  if (run.mode === "interactive") ctx.io.out(`Recorded worker ${result.workerId} (${account.id}).\n`);
  if (limit !== null) {
    err(limitLine(adapter.displayName, limit.reason, limit.retryAt));
    return ExitCode.LimitReached;
  }
  if (run.mode === "interactive") return status.code ?? signalExitCode(status.signal);
  if (result.permission !== null) {
    err(`${result.permission} relay does not answer permission requests; run relay run ${account.id} in your terminal to answer it yourself.`);
    return ExitCode.AgentFailed;
  }
  if (lastTurn !== null && !lastTurn.completed && lastTurn.reason !== "crashed") {
    err(failureLine(adapter.displayName, lastTurn.reason, result.logPath));
    return ExitCode.AgentFailed;
  }
  if (lastTurn?.completed !== true || status.code !== 0) {
    err(failureLine(adapter.displayName, "crashed", result.logPath));
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
  return () => {
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
function restoreTerminal(ctx: CommandContext): void {
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
  private lastAvailability: string;

  constructor(private readonly ctx: CommandContext, private readonly run: Supervision, private readonly record: WorkerRecord) {
    this.lastAvailability = availabilityKey(readAvailability(ctx.relayHome, run.account));
  }

  queue(write: () => Promise<void>): Promise<void> {
    const next = this.chain.then(write);
    this.chain = next.catch(() => {});
    return next;
  }

  sessionId(): string | null {
    return this.record.provider_session_id;
  }

  // The files a completed file change touched, relative to the worktree root when they are in it.
  relativePaths(event: WorkerEvent): string[] {
    if (event.kind !== "tool" || event.status !== "completed" || event.paths === undefined) return [];
    const root = this.run.job.worktreeRoot;
    return event.paths.map((path) => {
      const inside = relative(root, resolve(root, path));
      return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
    });
  }

  async write(event: WorkerEvent): Promise<void> {
    const { job } = this.run;
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
        const paths = this.relativePaths(event);
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
    const reading = readAvailability(this.ctx.relayHome, this.run.account);
    const key = availabilityKey(reading);
    if (key === this.lastAvailability) return;
    this.lastAvailability = key;
    await appendEvent(this.run.job, "availability", {
      worker_id: this.record.worker_id, target: this.run.account.id, status: reading.state, reason: reading.detail ?? null,
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
    await appendEvent(this.run.job, "worker_ended", {
      worker_id: this.record.worker_id, exit_code: status.code, signal: status.signal, end_reason: endReason,
      stop_how: stopped?.how ?? null, seconds: Math.round((ended.getTime() - started.getTime()) / 1000),
    });
  }
}

function availabilityKey(reading: Availability): string {
  return JSON.stringify([reading.state, reading.retryAt?.toISOString() ?? null,
    reading.windows.map((window) => [window.name, window.usedPercent ?? null, window.resetsAt?.toISOString() ?? null])]);
}
