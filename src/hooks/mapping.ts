// What the daemon does with a hook event (design.md decision 18): it finds the worker, the job and
// the account the event belongs to, records a SessionStart's session ID for the worker, and turns
// the events in the availability table into availability readings. relay status uses
// availabilityFromHook for hook events spooled while the daemon was down.
//
// Every value comes from an agent's process, so nothing is used without a check: the line was
// checked with parseSpoolLine, a worker, job or account is used only when the index knows it, a
// session ID only when it is a UUID, and cwd and the profile folder are only compared with known
// folders, never opened.
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { recordReading } from "../accounts/availability";
import { DEFAULT_FOLDERS } from "../accounts/profile";
import { isSessionId } from "../adapters/worker";
import type { EventStream } from "../api/sse";
import type { AccountId } from "../core/config/types";
import type { Logger } from "../core/log";
import { appendEvent, type JobRef } from "../job/events";
import { applyAvailability } from "../state/apply-event";
import type { AvailabilityStatus } from "../state/availability";
import { getAccount } from "../state/queries";
import type { SpoolLine } from "./fields";

export interface HookAvailability {
  status: AvailabilityStatus;
  reason: string;
}

const CLAUDE_STOP_FAILURES: Record<string, HookAvailability> = {
  rate_limit: { status: "rate_limited", reason: "Claude Code reported a rate limit" },
  billing_error: { status: "unavailable", reason: "Claude Code reported a billing problem" },
  authentication_failed: { status: "unavailable", reason: "Claude Code is signed out of this account" },
  oauth_org_not_allowed: { status: "unavailable", reason: "This organization does not allow this login" },
  account_on_hold: { status: "unavailable", reason: "Claude Code reported that the account is on hold" },
};

// The new availability, or null when the event changes none (for example overloaded or
// server_error, which are outages of the service, not of the account).
export function availabilityFromHook(provider: string, event: string, fields: Record<string, unknown>): HookAvailability | null {
  if (provider === "claude" && event === "StopFailure") {
    return typeof fields.error === "string" ? (CLAUDE_STOP_FAILURES[fields.error] ?? null) : null;
  }
  if ((provider === "claude" || provider === "codex") && event === "Stop") {
    return { status: "available", reason: "The last turn finished normally" };
  }
  if (provider === "claude" && event === "Notification" && fields.notification_type === "quota_auto_resume_fired") {
    return { status: "available", reason: "Claude Code continued after its reset." };
  }
  return null;
}

interface WorkerRow {
  id: string;
  job_id: string;
  target_id: string;
  provider_session_id: string | null;
}

interface JobRow {
  id: string;
  project_root: string;
}

interface TargetRow {
  id: AccountId;
  provider: SpoolLine["provider"];
  account: string;
}

const WORKER_SELECT = "SELECT id, job_id, target_id, provider_session_id FROM workers";
const NEWEST = "ORDER BY started_at DESC, id DESC LIMIT 1";

// The worker: by relay_worker; else the newest worker of relay_job on relay_target; else the
// newest worker whose provider session ID is the event's session_id. A worker on another
// provider's account is not the event's worker.
export function findWorker(db: Database, line: SpoolLine): WorkerRow | null {
  const sessionId = line.fields.session_id;
  const found =
    (line.relay_worker === null ? null : db.query<WorkerRow, [string]>(`${WORKER_SELECT} WHERE id = ?`).get(line.relay_worker)) ??
    (line.relay_job === null || line.relay_target === null
      ? null
      : db.query<WorkerRow, [string, string]>(`${WORKER_SELECT} WHERE job_id = ? AND target_id = ? ${NEWEST}`).get(line.relay_job, line.relay_target)) ??
    (typeof sessionId !== "string" || sessionId === ""
      ? null
      : db.query<WorkerRow, [string]>(`${WORKER_SELECT} WHERE provider_session_id = ? ${NEWEST}`).get(sessionId));
  return found !== null && found.target_id.startsWith(`${line.provider}:`) ? found : null;
}

// The job: the worker's; else relay_job; else the job of the indexed project whose root holds cwd
// (the deepest one). Projects whose folder is missing are skipped.
export function findJob(db: Database, line: SpoolLine, worker: WorkerRow | null): JobRow | null {
  const select = "SELECT j.id, j.project_root FROM jobs j JOIN projects p ON p.root_path = j.project_root WHERE p.missing = 0";
  const byId = (id: string) => db.query<JobRow, [string]>(`${select} AND j.id = ?`).get(id);
  if (worker !== null) return byId(worker.job_id);
  if (line.relay_job !== null) return byId(line.relay_job);
  const cwd = line.fields.cwd;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const folder = resolve(cwd);
  const inside = db
    .query<JobRow, []>(select)
    .all()
    .filter((job) => folder === job.project_root || folder.startsWith(job.project_root.endsWith("/") ? job.project_root : `${job.project_root}/`));
  return inside.sort((a, b) => b.project_root.length - a.project_root.length)[0] ?? null;
}

// The account: relay_target; else the worker's; else the account whose profile folder is the
// event's ("default" is the provider's own folder, ~/.claude or ~/.codex). Only accounts in
// config.toml count, so an agent cannot add an account by naming one.
export function findAccount(db: Database, line: SpoolLine, worker: WorkerRow | null, homedir: string): TargetRow | null {
  const configured = (id: string) =>
    db
      .query<TargetRow, [string, string]>("SELECT id, provider, account FROM targets WHERE id = ? AND provider = ? AND configured = 1")
      .get(id, line.provider);
  if (line.relay_target !== null) return configured(line.relay_target);
  if (worker !== null) return configured(worker.target_id);
  const folder = line.profile === "default" ? resolve(homedir, DEFAULT_FOLDERS[line.provider]) : line.profile;
  return db
    .query<TargetRow, [string, string]>(
      "SELECT id, provider, account FROM targets WHERE provider = ? AND profile_dir = ? AND configured = 1 ORDER BY id LIMIT 1",
    )
    .get(line.provider, folder);
}

export interface HookContext {
  db: Database;
  relayHome: string;
  homedir: string;
  stream: EventStream;
  log: Logger;
  // Reads the events.jsonl lines the index does not have yet, so a worker that has just started
  // is found, and the lines this module appends reach the index and the event stream at once.
  catchUp: () => Promise<void>;
}

// Records one hook event (design.md decision 18, steps 1 to 4). With a job, the events go to the
// job's events.jsonl, which the index follows; without one, the availability goes to the index and
// the event stream directly. The account's availability.json is updated either way, as phase 3
// does.
export async function applyHook(ctx: HookContext, line: SpoolLine): Promise<void> {
  const { db, stream } = ctx;
  await ctx.catchUp();
  const worker = findWorker(db, line);
  const job = findJob(db, line, worker);
  const account = findAccount(db, line, worker, ctx.homedir);
  const ref: JobRef | null = job === null ? null : { id: job.id, worktreeRoot: job.project_root, relayHome: ctx.relayHome };

  if (ref !== null) {
    // received_at and relay_worker let interactive workers read the event as the spool line it was
    // (src/hooks/feed.ts); worker_id is the worker the daemon attributed it to.
    await appendEvent(ref, "hook", {
      provider: line.provider,
      event: line.event,
      received_at: line.received_at,
      relay_worker: line.relay_worker,
      worker_id: worker?.id ?? null,
      ...line.fields,
    });
  } else {
    db.transaction(() => stream.record({ jobId: null, type: "hook", data: { job_id: null, provider: line.provider, event: line.event } }))();
    stream.publish();
  }

  const sessionId = line.fields.session_id;
  if (line.event === "SessionStart" && ref !== null && worker !== null && !worker.provider_session_id && isSessionId(sessionId)) {
    await appendEvent(ref, "worker_session_identified", { worker_id: worker.id, provider_session_id: sessionId });
  }

  const change = availabilityFromHook(line.provider, line.event, line.fields);
  if (change !== null && account !== null) {
    const reading = {
      worker_id: worker?.id ?? null,
      target: account.id,
      status: change.status,
      reason: change.reason,
      retry_at: null,
      measured_at: line.received_at,
      source: "hook",
      windows: [],
    };
    if (ref !== null) {
      await appendEvent(ref, "availability", reading);
    } else {
      db.transaction(() => {
        if (applyAvailability(db, account.id, reading)) stream.record({ jobId: null, type: "availability", data: getAccount(db, account.id) });
      })();
      stream.publish();
    }
    recordReading(
      ctx.relayHome,
      { id: account.id, provider: account.provider, name: account.account },
      { state: change.status, windows: [], observedAt: new Date(line.received_at), source: "hook", detail: change.reason },
    );
  }
  if (ref !== null) await ctx.catchUp();
  ctx.log.debug("hook_applied", {
    provider: line.provider,
    event: line.event,
    job: job?.id ?? null,
    worker: worker?.id ?? null,
    target: account?.id ?? null,
    availability: account === null ? null : (change?.status ?? null),
  });
}

// Hook events waiting for applyHook, processed one at a time in the order they arrived. The
// daemon answers 202 once an event is in the queue, so a hook never waits for a file lock. A hook
// whose answer came too late also spools its line, so a line the queue already took is not taken
// again.
const REMEMBERED = 2000;

export class HookQueue {
  private readonly waiting: SpoolLine[] = [];
  private readonly taken = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly ctx: HookContext,
    private readonly limit = 1000,
  ) {}

  // Adds an event. False when the queue is full; relay hook then writes the event to the spool.
  offer(line: SpoolLine): boolean {
    const key = JSON.stringify(line);
    if (this.taken.has(key)) return true;
    if (this.waiting.length >= this.limit) return false;
    this.taken.add(key);
    if (this.taken.size > REMEMBERED) this.taken.delete(this.taken.values().next().value!);
    this.waiting.push(line);
    this.run();
    return true;
  }

  // Resolves when every event offered so far has been processed.
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  private run(): void {
    if (this.running !== null) return;
    this.running = (async () => {
      for (let line = this.waiting.shift(); line !== undefined; line = this.waiting.shift()) {
        try {
          await applyHook(this.ctx, line);
        } catch (error) {
          this.ctx.log.error("hook_failed", {
            provider: line.provider,
            event: line.event,
            error_name: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    })().finally(() => {
      this.running = null;
      if (this.waiting.length > 0) this.run();
    });
  }
}
