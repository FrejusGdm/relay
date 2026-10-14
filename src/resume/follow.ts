// What relay run does once the daemon owns the job's wait (add-resume-at-reset, design decision 6):
// it reads the job's event log every half second and prints what happens, until the wait ends, and
// then exits with the wait's exit code. Ctrl+C cancels the wait; SIGHUP and SIGTERM end only relay
// run, and the daemon goes on. Event data can be written by an agent, so every value is checked and
// made printable, and the wait counts as ended only when its file is gone.
import { displayName } from "../handoff/account";
import type { FailureReason } from "../adapters/types";
import { ensureDaemon } from "../client/ensure-daemon";
import { ExitCode } from "../cli/exit-codes";
import { printable } from "../core/quote";
import { readEvents, type JobRef, type RelayEvent } from "../job/events";
import { clockText, failureLine, limitLine } from "../run/progress";
import { redact } from "../secrets/redact";
import type { SupervisorContext } from "../run/run";
import { endWait, readWait, withWaitLock, type WaitRecord } from "./wait";

const POLL_MS = 500;
const DAEMON_CHECK_MS = 60_000;

export function cancelHint(jobId: string): string {
  return `You can close this terminal. To cancel, run relay resume-at-reset off --job ${jobId}`;
}

// The line for a wait, as relay run and relay status print it.
export function waitingLine(wait: Pick<WaitRecord, "account" | "stop" | "next_check_at">): string {
  const reset = wait.stop?.reset_at ?? null;
  if (reset !== null) return `Waiting for ${wait.account}'s limit to reset at ${clockText(new Date(reset))}, then continuing.`;
  const next = wait.next_check_at === null ? "" : ` relay checks again at ${clockText(new Date(wait.next_check_at))}.`;
  return `Waiting for ${wait.account}'s limit to reset.${next}`;
}

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

// `after` is the id of the waiting event relay run wrote itself: every later event belongs to this
// wait, also one the daemon wrote before relay run began to follow.
export async function followWait(
  ctx: SupervisorContext, job: JobRef, wait: WaitRecord, json: boolean, say: (line: string) => void, after: number,
): Promise<number> {
  const err = (line: string) => ctx.io.err(`${line}\n`);
  const provider = displayName(wait.provider);
  let lastId = after;
  const workers = new Set<string>();
  let ended: Ended | null = null;
  let daemonCheckedAt = Date.now();
  let signal: Signal | null = null;
  let wake: (() => void) | null = null;
  const restore = takeSignals((name) => {
    signal ??= name;
    wake?.();
  });

  const show = (event: RelayEvent) => {
    const data = event.data;
    const text = (value: unknown) => (typeof value === "string" ? printable(value) : "");
    const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);
    if (event.type === "resume_at_reset_ended") {
      const exitCode = Number.isInteger(data.exit_code) && (data.exit_code as number) >= 0 && (data.exit_code as number) <= 255 ? data.exit_code as number : ExitCode.LimitReached;
      const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? value as number : 0);
      ended = { outcome: text(data.outcome), reason: text(data.reason), exitCode, resumes: count(data.resumes), inARow: count(data.resumes_in_a_row) };
    }
    if (json) {
      if (event.type.startsWith("resume_at_reset_") || workers.has(String(data.worker_id))) ctx.io.out(`${JSON.stringify({ type: event.type, data })}\n`);
      if (event.type === "resume_at_reset_resumed" && typeof data.worker_id === "string") workers.add(data.worker_id);
      return;
    }
    switch (event.type) {
      case "resume_at_reset_waiting": {
        const reset = time(data.reset_at);
        const next = time(data.next_check_at);
        say(waitingLine({ account: text(data.target), stop: reset === null ? null : { reset_at: reset.toISOString() } as WaitRecord["stop"], next_check_at: next?.toISOString() ?? null }));
        return;
      }
      case "resume_at_reset_checked": {
        const next = time(data.next_check_at);
        const reset = time(data.reset_at);
        if (data.result === "reset_known" && reset !== null) say(`${text(data.target)}'s limit resets at ${clockText(reset)}. relay continues then.`);
        else if (data.result === "still_limited" && next !== null) say(`${text(data.target)} is still at its limit. relay checks again at ${clockText(next)}.`);
        else if (data.result === "resuming") say(`No reset time is known for ${text(data.target)}. relay tries to continue now.`);
        return;
      }
      case "resume_at_reset_resumed":
        if (typeof data.worker_id === "string") workers.add(data.worker_id);
        say(`Continuing session ${text(data.provider_session_id).slice(0, 8)} on ${text(data.target)} (resume ${Number(data.resume) || 1}).`);
        return;
      default:
    }
    if (!workers.has(String(data.worker_id))) return;
    if (event.type === "command_ran" && typeof data.command === "string") {
      const command = printable(redact(data.command));
      say(Number.isInteger(data.exit_code) ? `  ran ${command} · exit ${data.exit_code}` : `  ran ${command}`);
    } else if (event.type === "file_changed" && Array.isArray(data.paths)) {
      for (const path of data.paths) if (typeof path === "string") say(`  changed ${printable(path)}`);
    } else if (event.type === "turn_completed") {
      say(typeof data.duration_ms === "number" ? `Turn finished · ${Math.round(data.duration_ms / 1000)} s` : "Turn finished");
    } else if (event.type === "turn_failed" && typeof data.reason === "string") {
      const reason = data.reason as FailureReason;
      const retry = time(data.retry_at) ?? undefined;
      say(reason === "usage_limit" || reason === "rate_limit" || reason === "credits_required" ? limitLine(provider, reason, retry) : failureLine(provider, reason, null));
    }
  };

  const drain = () => {
    let events: RelayEvent[];
    try {
      events = readEvents(job);
    } catch {
      return;
    }
    for (const event of events) {
      if (event.id <= lastId) continue;
      lastId = event.id;
      show(event);
    }
  };

  try {
    for (;;) {
      drain();
      if (readWait(ctx.relayHome, job.id) === null) {
        drain();
        break;
      }
      if (signal === "SIGINT") {
        const cancelled = await cancelWait(ctx.relayHome, job.id);
        drain();
        err(cancelled === "resuming"
          ? "Cancelled. The agent relay already resumed finishes its turn; relay does not resume this job again."
          : "Cancelled. relay will not resume this job.");
        return ExitCode.Interrupted;
      }
      if (signal !== null) return ExitCode.Terminated;
      if (Date.now() - daemonCheckedAt >= DAEMON_CHECK_MS) {
        daemonCheckedAt = Date.now();
        await ensureDaemon({ relayHome: ctx.relayHome, env: ctx.env, err: ctx.io.err }).catch(() => false);
      }
      await new Promise<void>((done) => {
        const timer = setTimeout(done, POLL_MS);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      wake = null;
    }
  } finally {
    restore();
  }
  const result = ended as Ended | null;
  if (result === null) {
    err("The wait ended without a record of why. See relay status.");
    return ExitCode.LimitReached;
  }
  if (!json) endLine(result, err, say);
  return result.exitCode;
}

interface Ended { outcome: string; reason: string; exitCode: number; resumes: number; inARow: number }

function endLine(result: Ended, err: (line: string) => void, say: (line: string) => void): void {
  const plural = (count: number) => `${count} ${count === 1 ? "resume" : "resumes"}`;
  if (result.outcome === "finished") say(`The task ended normally after ${plural(result.resumes)}.`);
  else if (result.outcome === "gave_up" && result.reason === "limit_again") err(`relay stopped after ${plural(result.inARow)} in a row that hit the limit again.`);
  else if (result.outcome === "gave_up") err("relay stopped: no reset time became known in 7 days.");
  else if (result.reason === "credits_required") err("relay does not wait when the account needs usage credits.");
  else if (result.reason === "person") err("Cancelled.");
  else if (result.reason === "job_moved_on") err("Another agent continued this job, so relay did not resume it.");
  else if (result.outcome === "stopped") err(`relay stopped resuming this job (${result.reason}).`);
}

// Ends the job's wait as cancelled by the person. Returns the state it had, or null without one.
export async function cancelWait(relayHome: string, jobId: string): Promise<WaitRecord["state"] | null> {
  return await withWaitLock(relayHome, jobId, async () => {
    const wait = readWait(relayHome, jobId);
    if (wait === null) return null;
    await endWait(relayHome, wait, "cancelled", "person", ExitCode.LimitReached);
    return wait.state;
  });
}

// Replaces relay's own handlers for SIGINT, SIGTERM and SIGHUP while relay run follows the wait.
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
