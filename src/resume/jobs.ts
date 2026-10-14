// The daemon's side of resume at reset for relay jobs (add-resume-at-reset, design decisions 1 to 5
// and 7): it looks at every job's wait every few seconds, checks accounts whose reset time is
// unknown, resumes the same session on the same account when the time comes, and decides what
// happens when the resumed agent ends. relay run uses waitAfterStop to start a wait.
import type { AdapterRegistry } from "../adapters/registry";
import type { ProviderAdapter, ReadingSource } from "../adapters/types";
import { findAccount } from "../accounts/registry";
import { ProjectMissing } from "../api/engine-errors";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Account, RelayConfig } from "../core/config/types";
import type { Logger } from "../core/log";
import { appendEvent, readEvents, type JobRef } from "../job/events";
import { now } from "../platform/clock";
import type { LastEnd } from "../run/run";
import { readSupervisor } from "../run/control";
import { readWorkerRecords } from "../run/worker-record";
import { afterReset, checkAccount, findResetTime, isUsageLimit, nextUnknownCheck, type ResetTime, type Timing } from "./timing";
import { endWait, jobRefOf, listWaits, readWait, withWaitLock, writeWait, type WaitRecord, type WaitStop } from "./wait";

export interface Started {
  workerId: string;
  // Resolves when the resumed agent has ended and relay has recorded it; null when supervising it
  // failed.
  done: Promise<LastEnd | null>;
}

export interface JobResumerOptions {
  relayHome: string;
  env: Record<string, string | undefined>;
  log: Pick<Logger, "info" | "warn" | "error">;
  timing: Timing;
  random?: () => number;
  config: () => RelayConfig;
  registry: () => AdapterRegistry;
  // Starts the resumed agent under a job supervisor (src/daemon/engines.ts).
  start: (wait: WaitRecord, account: Account) => Promise<Started>;
}

export class JobResumer {
  private readonly running = new Map<string, Promise<void>>();
  // Resumes between the decision and the moment the agent is registered with the daemon's workers.
  private readonly starting = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: JobResumerOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.options.timing.tickMs);
    void this.tick();
  }

  // Takes no new resumes, and waits until every resume being started is either registered with the
  // daemon's HeadlessWorkers (which then stop it) or put back to waiting. finished() then waits
  // until the waits of the stopped agents are recorded.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.sweeping;
    while (this.starting.size > 0) await Promise.allSettled([...this.starting]);
  }

  async finished(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  // One look at every wait. A look that is still going makes this one do nothing.
  async tick(): Promise<void> {
    if (this.sweeping !== null || this.stopped) return this.sweeping ?? undefined;
    this.sweeping = this.sweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweep(): Promise<void> {
    for (const wait of listWaits(this.options.relayHome)) {
      if (this.stopped) return;
      try {
        await this.consider(wait);
      } catch (error) {
        this.options.log.error("resume_at_reset_failed", { job: wait.job_id, error_name: error instanceof Error ? error.name : typeof error });
      }
    }
  }

  private async consider(wait: WaitRecord): Promise<void> {
    const { relayHome } = this.options;
    if (this.running.has(wait.job_id)) return;
    if (wait.state === "watching") {
      // relay run holds the job while its first agent runs; a wait whose relay run died without
      // a limit stop is ended.
      if (wait.owner_pid !== null && alive(wait.owner_pid)) return;
      await withWaitLock(relayHome, wait.job_id, async () => {
        const current = readWait(relayHome, wait.job_id);
        if (current?.state === "watching" && !(current.owner_pid !== null && alive(current.owner_pid))) {
          await endWait(relayHome, current, "stopped", "run_ended", ExitCode.Failed);
        }
      });
      return;
    }
    // Another relay process holds the job's agent: relay run still finishing, or the person
    // started an agent. The next look decides.
    if (readSupervisor(relayHome, wait.job_id) !== null) return;
    if (wait.state === "resuming") {
      // A daemon that ended without recording the resumed agent's end: the same session is resumed
      // again, and that resume does not count.
      await withWaitLock(relayHome, wait.job_id, () => {
        const current = readWait(relayHome, wait.job_id);
        if (current?.state !== "resuming" || current.stop === null) return;
        writeWait(relayHome, {
          ...current, state: "waiting", next_check_at: now().toISOString(), worker_id: null, counted: false,
          stop: { ...current.stop, worker_id: resumedWorker(relayHome, current) ?? current.stop.worker_id },
        });
        this.options.log.warn("resume_at_reset_recovered", { job: current.job_id });
      });
      return;
    }
    if (wait.next_check_at === null || Date.parse(wait.next_check_at) > now().getTime()) return;
    // The resume runs on its own, so a long resumed agent never holds up other jobs or the daemon's
    // shutdown; `running` keeps a second look from starting it twice.
    const resume = this.resume(wait.job_id)
      .catch((error: unknown) => this.options.log.error("resume_at_reset_failed", { job: wait.job_id, error_name: error instanceof Error ? error.name : typeof error }))
      .finally(() => this.running.delete(wait.job_id));
    this.running.set(wait.job_id, resume);
  }

  // Decides under the lock whether to resume now, starts the agent, and waits for its end.
  private async resume(jobId: string): Promise<void> {
    const begun = this.begin(jobId);
    this.starting.add(begun);
    let started: { started: Started; wait: WaitRecord } | null;
    try {
      started = await begun;
    } finally {
      this.starting.delete(begun);
    }
    if (started === null) return;
    const last = await started.started.done.catch(() => null);
    await this.afterResume(jobId, last, started.started.workerId);
  }

  private async begin(jobId: string): Promise<{ started: Started; wait: WaitRecord } | null> {
    const { relayHome, timing } = this.options;
    const decided = await withWaitLock(relayHome, jobId, async (): Promise<{ wait: WaitRecord; account: Account } | null> => {
      const wait = readWait(relayHome, jobId);
      if (wait?.state !== "waiting" || wait.stop === null || wait.next_check_at === null || Date.parse(wait.next_check_at) > now().getTime()) return null;
      if (this.stopped || readSupervisor(relayHome, jobId) !== null) return null;
      // The job moved on when another agent ran in it after the one that stopped.
      if (readWorkerRecords(relayHome, jobId)[0]?.worker_id !== wait.stop.worker_id) {
        await endWait(relayHome, wait, "cancelled", "job_moved_on", ExitCode.LimitReached);
        return null;
      }
      const account = findAccount(this.options.config(), wait.account);
      if (account === undefined) {
        await endWait(relayHome, wait, "stopped", "account_removed", ExitCode.NoSuchAccount);
        return null;
      }
      if (wait.stop.reset_at === null) {
        if (wait.waiting_since !== null && now().getTime() - Date.parse(wait.waiting_since) >= timing.maxUnknownMs) {
          await endWait(relayHome, wait, "gave_up", "no_reset_time", ExitCode.LimitReached);
          return null;
        }
        const adapter = this.options.registry().get(account.provider);
        const result = await checkAccount({ account, adapter, relayHome, env: this.options.env, stoppedAt: new Date(wait.stop.at) });
        if (result.kind !== "resuming") {
          const next = result.kind === "reset_known" ? afterReset(result.reset.at, timing, this.options.random) : nextUnknownCheck(now(), timing, this.options.random);
          const updated: WaitRecord = {
            ...wait, next_check_at: next.toISOString(),
            stop: result.kind === "reset_known" ? { ...wait.stop, reset_at: result.reset.at.toISOString(), source: result.reset.source } : wait.stop,
          };
          writeWait(relayHome, updated);
          await appendEvent(jobRefOf(relayHome, wait), "resume_at_reset_checked", {
            target: wait.account, result: result.kind, reset_at: updated.stop!.reset_at, next_check_at: updated.next_check_at,
          });
          return null;
        }
        await appendEvent(jobRefOf(relayHome, wait), "resume_at_reset_checked", {
          target: wait.account, result: "resuming", reset_at: null, next_check_at: null,
        });
      }
      const updated: WaitRecord = { ...wait, state: "resuming", resumes: wait.resumes + 1, counted: wait.stop.reset_at !== null, worker_id: null };
      writeWait(relayHome, updated);
      return { wait: updated, account };
    });
    if (decided === null) return null;
    // The daemon began to stop while relay checked the account: the next daemon resumes instead.
    if (this.stopped) {
      await withWaitLock(relayHome, jobId, () => {
        const wait = readWait(relayHome, jobId);
        if (wait?.state === "resuming") writeWait(relayHome, { ...wait, state: "waiting", resumes: wait.resumes - 1, counted: false });
      });
      return null;
    }

    let started: Started;
    try {
      started = await this.options.start(decided.wait, decided.account);
    } catch (error) {
      await this.startFailed(decided.wait, error);
      return null;
    }
    await withWaitLock(relayHome, jobId, async () => {
      const wait = readWait(relayHome, jobId);
      if (wait !== null) writeWait(relayHome, { ...wait, worker_id: started.workerId });
      await appendEvent(jobRefOf(relayHome, decided.wait), "resume_at_reset_resumed", {
        worker_id: started.workerId, target: decided.wait.account, provider_session_id: decided.wait.session_id,
        resume: decided.wait.resumes, counted: decided.wait.counted,
      });
    });
    this.options.log.info("resume_at_reset_resumed", { job: jobId, worker: started.workerId, target: decided.wait.account });
    return { started, wait: decided.wait };
  }

  // The job's folder is gone, or another agent took the job between the decision and the start, or
  // the program could not start.
  private async startFailed(wait: WaitRecord, error: unknown): Promise<void> {
    const { relayHome } = this.options;
    await withWaitLock(relayHome, wait.job_id, async () => {
      const current = readWait(relayHome, wait.job_id);
      if (current === null) return;
      if (error instanceof ProjectMissing || (error instanceof CommandError && error.code === ExitCode.Busy)) {
        await endWait(relayHome, current, "cancelled", "job_moved_on", ExitCode.LimitReached);
      } else {
        await endWait(relayHome, current, "stopped", "start_failed", error instanceof CommandError ? error.code : ExitCode.AgentFailed);
      }
    });
    this.options.log.warn("resume_at_reset_not_started", { job: wait.job_id, error_name: error instanceof Error ? error.name : typeof error });
  }

  private async afterResume(jobId: string, last: LastEnd | null, workerId: string): Promise<void> {
    const { relayHome, timing } = this.options;
    await withWaitLock(relayHome, jobId, async () => {
      const wait = readWait(relayHome, jobId);
      // relay resume-at-reset off ended the wait while the agent ran.
      if (wait === null) return;
      if (last === null) {
        await endWait(relayHome, wait, "stopped", "relay_error", ExitCode.Internal);
        return;
      }
      // The daemon stopped the agent because it is stopping: the next daemon resumes the same session
      // again, and expects the agent it stopped to be the job's newest worker.
      if (last.terminated) {
        writeWait(relayHome, {
          ...wait, state: "waiting", next_check_at: now().toISOString(), worker_id: null, counted: false,
          stop: wait.stop === null ? null : { ...wait.stop, worker_id: workerId },
        });
        return;
      }
      const turn = last.lastTurn;
      if (turn?.completed === true && last.code === ExitCode.Ok) {
        await endWait(relayHome, wait, "finished", "completed", ExitCode.Ok);
        return;
      }
      if (turn !== null && !turn.completed && turn.reason === "credits_required") {
        await endWait(relayHome, wait, "stopped", "credits_required", ExitCode.LimitReached);
        return;
      }
      if (turn === null || turn.completed || !isUsageLimit(turn.reason)) {
        const reason = turn === null || turn.completed ? "exited" : turn.reason;
        await endWait(relayHome, wait, "stopped", reason, last.code === ExitCode.Ok ? ExitCode.AgentFailed : last.code);
        return;
      }
      const inARow = wait.resumes_in_a_row + (wait.counted ? 1 : 0);
      if (inARow >= wait.max_resumes) {
        await endWait(relayHome, { ...wait, resumes_in_a_row: inARow }, "gave_up", "limit_again", ExitCode.LimitReached);
        return;
      }
      const account = findAccount(this.options.config(), wait.account);
      if (account === undefined) {
        await endWait(relayHome, wait, "stopped", "account_removed", ExitCode.NoSuchAccount);
        return;
      }
      const next = await waitAfterStop({
        relayHome, env: this.options.env, timing, random: this.options.random, wait: { ...wait, resumes_in_a_row: inARow },
        last, adapter: this.options.registry().get(account.provider),
      });
      writeWait(relayHome, next);
      await recordWaiting(relayHome, next);
      this.options.log.info("resume_at_reset_waiting", { job: jobId, worker: workerId, reset_at: next.stop?.reset_at ?? null });
    });
  }
}

// The wait after a stop at a usage limit: the stop with its reset time, and the next check.
export async function waitAfterStop(options: {
  relayHome: string; env: Record<string, string | undefined>; timing: Timing; random?: (() => number) | undefined;
  wait: WaitRecord; last: LastEnd; adapter: ProviderAdapter;
}): Promise<WaitRecord> {
  const { relayHome, wait, last, timing } = options;
  const job = jobRefOf(relayHome, wait);
  const turn = last.lastTurn !== null && !last.lastTurn.completed ? last.lastTurn : null;
  const stopReset: ResetTime | null = turn?.retryAt === undefined ? null : { at: turn.retryAt, source: failureSource(job, last.workerId) };
  const reset = await findResetTime({
    stopReset, stoppedAt: last.endedAt, account: last.account, adapter: options.adapter, relayHome, env: options.env,
  });
  const stop: WaitStop = {
    worker_id: last.workerId, at: last.endedAt.toISOString(), reason: turn?.reason ?? "usage_limit",
    reset_at: reset?.at.toISOString() ?? null, source: reset?.source ?? null,
  };
  const next = reset !== null ? afterReset(reset.at, timing, options.random) : nextUnknownCheck(now(), timing, options.random);
  return {
    ...wait, state: "waiting", account: last.account.id, provider: last.account.provider, session_id: last.sessionId ?? wait.session_id,
    permission: last.permission, model: last.model, stop, next_check_at: next.toISOString(), worker_id: null, counted: false,
    waiting_since: wait.waiting_since ?? now().toISOString(), owner_pid: null,
  };
}

// Returns the event's id, from which a waiting relay run follows the job.
export async function recordWaiting(relayHome: string, wait: WaitRecord): Promise<number> {
  const event = await appendEvent(jobRefOf(relayHome, wait), "resume_at_reset_waiting", {
    worker_id: wait.stop?.worker_id ?? null, target: wait.account, provider_session_id: wait.session_id,
    reason: wait.stop?.reason ?? null, reset_at: wait.stop?.reset_at ?? null, source: wait.stop?.source ?? null,
    next_check_at: wait.next_check_at, resumes_in_a_row: wait.resumes_in_a_row,
  });
  return event.id;
}

// The source of the stop's reading, from the worker's turn_failed event.
function failureSource(job: JobRef, workerId: string): ReadingSource {
  let source: ReadingSource = "stream_event";
  try {
    for (const event of readEvents(job)) {
      if (event.type === "turn_failed" && event.data.worker_id === workerId && typeof event.data.source === "string") {
        source = event.data.source as ReadingSource;
      }
    }
  } catch {
    // The event log is unreadable; the stop keeps the usual source.
  }
  return source;
}

// The worker a daemon that ended without recording it had resumed: the wait's own record, or the
// job's newest worker when it resumed the wait's session on the wait's account.
function resumedWorker(relayHome: string, wait: WaitRecord): string | null {
  if (wait.worker_id !== null) return wait.worker_id;
  const newest = readWorkerRecords(relayHome, wait.job_id)[0];
  return newest !== undefined && newest.account === wait.account && wait.session_id !== null && newest.resumed_from === wait.session_id
    ? newest.worker_id : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
