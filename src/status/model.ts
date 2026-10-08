// What relay status shows (design.md decision 20): the job, one row per account in the order the
// lanes need, each row's role and activity, and the closing sentence. The text and JSON renderers
// both start from this view, so they always agree.
import { PROVIDER_NAMES, type AccountView, type JobView, type WorkerView } from "../state/queries";

export interface StatusData {
  job: JobView;
  workers: WorkerView[];      // newest first
  accounts: AccountView[];
  daemon: "running" | "not_running";
  // Built from the files because the daemon did not answer or has not indexed the project yet.
  savedState: boolean;
}

export type Role = "previous" | "current" | "other";
export type Activity = "running" | "stopped" | "idle";

export interface StatusRow {
  account: AccountView;
  role: Role;
  activity: Activity;
}

export interface StatusView {
  job: JobView;
  rows: StatusRow[];
  closing: string;
  daemon: "running" | "not_running";
  savedState: boolean;
}

export function buildView(data: StatusData): StatusView {
  const { job } = data;
  const current = job.current_worker !== null && job.current_worker.state !== "ended" ? job.current_worker : null;
  // The newest ended worker, when it ran on another account than the current one.
  const lastEnded = current === null ? undefined : data.workers.find((worker) => worker.state === "ended");
  const previous = lastEnded === undefined || lastEnded.target === current?.target ? null : lastEnded;
  const byTarget = new Map(data.accounts.map((account) => [account.target, account]));
  const account = (target: string) => byTarget.get(target) ?? unmeasured(target);

  const rows: StatusRow[] = [];
  if (previous !== null) rows.push({ account: account(previous.target), role: "previous", activity: "idle" });
  if (current !== null) rows.push({ account: account(current.target), role: "current", activity: activityOf(current) });
  const shown = new Set(rows.map((row) => row.account.target));
  for (const other of [...data.accounts].sort((a, b) => a.target.localeCompare(b.target))) {
    if (other.configured && !shown.has(other.target)) rows.push({ account: other, role: "other", activity: "idle" });
  }

  return { job, rows, closing: closingSentence(current), daemon: data.daemon, savedState: data.savedState };
}

function activityOf(worker: WorkerView): Activity {
  if (worker.state === "running" || worker.state === "starting") return "running";
  return worker.state === "stopped" ? "stopped" : "idle";
}

function closingSentence(current: WorkerView | null): string {
  if (current === null || activityOf(current) !== "running") return "No agent is working on this job.";
  const provider = current.target.split(":")[0]!;
  const name = PROVIDER_NAMES[provider] ?? provider;
  return current.from_handoff ? `Continuing on ${name}.` : `${name} is working on this job.`;
}

// An account that a worker names but the index does not list.
function unmeasured(target: string): AccountView {
  const [provider = target, name = ""] = target.split(":");
  return {
    target,
    provider,
    provider_name: PROVIDER_NAMES[provider] ?? provider,
    account: name,
    configured: false,
    availability: { status: "unknown", reason: null, retry_at: null, measured_at: null, source: null },
    usage: [],
  };
}
