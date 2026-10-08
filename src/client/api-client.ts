// The command-line tool's side of the local API. This is the only file that calls fetch, and it
// always passes the unix option, so relay never opens a network connection (build-and-ci spec,
// "No network use and no telemetry"; test/build/no-network.test.ts). Every request goes through
// request(), which checks the runtime directory and the socket first, so no caller can skip the
// checks.
import { lstatSync } from "node:fs";
import { printable } from "../core/quote";
import { runtimeDirIsPrivate, socketPath } from "../daemon/paths";
import type { AccountView, JobView, WorkerView } from "../state/queries";

export interface DaemonVersion {
  daemon_version: string;
  pid: number;
  started_at: string;
}

// A runtime directory or socket that another user could have placed. The message is written to
// standard error as it is.
export class UntrustedRuntime extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedRuntime";
  }
}

// Throws UntrustedRuntime when the runtime directory exists and is not private, because another
// user could then have placed the lock, the pid file or the socket in it.
export function checkRuntimeDir(runDir: string): void {
  if (runtimeDirIsPrivate(runDir)) return;
  const shown = printable(runDir);
  throw new UntrustedRuntime(`relay will not use ${shown}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${shown}`);
}

// GET /v1/version. Returns null when nothing answers within timeoutMs, or the answer is not a
// v1 version object. Throws UntrustedRuntime as request() does.
export async function getVersion(runDir: string, timeoutMs: number): Promise<DaemonVersion | null> {
  const response = await request(runDir, "/v1/version", timeoutMs);
  try {
    if (response?.status !== 200) return null;
    const body = (await response.json()) as Partial<DaemonVersion> & { api?: unknown };
    if (
      body?.api !== "v1" ||
      typeof body.daemon_version !== "string" ||
      !Number.isInteger(body.pid) ||
      body.pid! <= 0 ||
      typeof body.started_at !== "string"
    ) {
      return null;
    }
    return { daemon_version: body.daemon_version, pid: body.pid!, started_at: body.started_at };
  } catch {
    return null;
  }
}

// GET /v1/jobs: the project root of each indexed job, or null without an answer. Throws
// UntrustedRuntime as request() does.
export async function getJobRoots(runDir: string, timeoutMs: number): Promise<string[] | null> {
  const response = await request(runDir, "/v1/jobs", timeoutMs);
  try {
    if (response?.status !== 200) return null;
    const body = (await response.json()) as { jobs?: { project_root?: unknown }[] } | null;
    if (!Array.isArray(body?.jobs)) return null;
    return body.jobs.flatMap((job) => (typeof job?.project_root === "string" ? [job.project_root] : []));
  } catch {
    return null;
  }
}

// What relay status needs from the daemon: the job, its workers and the accounts, each asked with
// its own time limit. Returns null when the daemon does not answer, and { job: null } when it
// answers but has not indexed the job yet. Throws UntrustedRuntime as request() does.
export async function getStatusSources(
  runDir: string,
  jobId: string,
  timeoutMs: number,
): Promise<{ job: JobView | null; workers: WorkerView[]; accounts: AccountView[] } | null> {
  const job = await request(runDir, `/v1/jobs/${jobId}`, timeoutMs);
  if (job === null) return null;
  if (job.status === 404) return { job: null, workers: [], accounts: [] };
  const workers = await request(runDir, `/v1/jobs/${jobId}/workers`, timeoutMs);
  const accounts = await request(runDir, "/v1/accounts", timeoutMs);
  if (job.status !== 200 || workers?.status !== 200 || accounts?.status !== 200) return null;
  try {
    return {
      job: ((await job.json()) as { job: JobView }).job,
      workers: ((await workers.json()) as { workers: WorkerView[] }).workers,
      accounts: ((await accounts.json()) as { accounts: AccountView[] }).accounts,
    };
  } catch {
    return null;
  }
}

// POST /v1/hooks/<provider>/<event> with a spool line as the body (design.md decision 18, step 5).
// True only when the daemon accepted the event with 202 within timeoutMs. Throws UntrustedRuntime
// as request() does.
export async function postHook(runDir: string, provider: string, event: string, body: string, options: { timeoutMs: number }): Promise<boolean> {
  const response = await request(runDir, `/v1/hooks/${provider}/${event}`, options.timeoutMs, { method: "POST", body });
  await response?.body?.cancel().catch(() => {});
  return response?.status === 202;
}

// The only connection to the daemon. Before it connects, it checks that the runtime directory is
// private and that the socket is a socket owned by this user, not a symbolic link, and throws
// UntrustedRuntime otherwise. Returns null when there is no socket or nothing answers in time.
async function request(
  runDir: string,
  path: string,
  timeoutMs: number,
  init: { method: "POST"; body: string } | null = null,
): Promise<Response | null> {
  checkRuntimeDir(runDir);
  const socket = socketPath(runDir);
  const stats = lstatSync(socket, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isSocket() || stats.uid !== process.getuid!()) {
    throw new UntrustedRuntime(`relay will not use ${printable(socket)}: it is not a socket owned by you.`);
  }
  try {
    const body = init === null ? {} : { ...init, headers: { "Content-Type": "application/json" } };
    return await fetch(`http://relay${path}`, { unix: socket, signal: AbortSignal.timeout(timeoutMs), ...body });
  } catch {
    return null;
  }
}
