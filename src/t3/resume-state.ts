// What relay remembers about T3 Code threads for resume at reset (add-resume-at-reset, design
// decision 11): RELAY_HOME/t3/resume-at-reset.json, mode 0600, changed only while relay holds
// locks/t3-resume.lock, and the log of every action, RELAY_HOME/t3/events.jsonl. Neither holds a
// message text, a thread title or a token: only IDs, accounts and times.
import { appendFileSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { readPrivateFile } from "../core/relay-home";
import { printable } from "../core/quote";
import { makePrivateFolder, writePrivateFile } from "../handoff/files";
import { lock } from "../platform/file-lock";
import { now } from "../platform/clock";
import { clockText } from "../run/progress";

export interface T3ThreadState {
  account: string;
  // The run that stopped at the limit and that relay waits to continue.
  run_id: string;
  state: "waiting" | "sent" | "gave_up";
  reset_at: string | null;
  source: string | null;
  next_check_at: string | null;
  waiting_since: string;
  // Sends in a row whose next run stopped at a limit again, and whether the last send counts.
  sends_in_a_row: number;
  counted: boolean;
  // The run relay's message started, once sent.
  sent_run_id: string | null;
  sent_at: string | null;
}

export interface T3ResumeState {
  v: 1;
  threads: Record<string, T3ThreadState>;
  // The newest run of each thread that relay read and found not to be a limit stop, so it is read
  // once.
  classified: Record<string, string>;
}

export interface T3Wait {
  threadId: string;
  account: string;
  state: T3ThreadState["state"];
  reset_at: string | null;
  next_check_at: string | null;
}

const MAX_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 10_000;

export function t3StatePath(relayHome: string): string {
  return join(relayHome, "t3", "resume-at-reset.json");
}

export function readT3State(relayHome: string): T3ResumeState {
  const empty: T3ResumeState = { v: 1, threads: {}, classified: {} };
  let text: string | null;
  try {
    text = readPrivateFile(t3StatePath(relayHome), process.getuid!(), MAX_BYTES);
  } catch {
    return empty;
  }
  if (text === null) return empty;
  try {
    const value = JSON.parse(text) as Partial<T3ResumeState>;
    if (value.v !== 1 || typeof value.threads !== "object" || value.threads === null || typeof value.classified !== "object" || value.classified === null) return empty;
    const threads: Record<string, T3ThreadState> = {};
    for (const [id, entry] of Object.entries(value.threads)) if (isThreadState(entry)) threads[id] = entry;
    const classified: Record<string, string> = {};
    for (const [id, run] of Object.entries(value.classified)) if (typeof run === "string") classified[id] = run;
    return { v: 1, threads, classified };
  } catch {
    return empty;
  }
}

export function writeT3State(relayHome: string, state: T3ResumeState): void {
  writePrivateFile(t3StatePath(relayHome), `${JSON.stringify(state, null, 2)}\n`);
}

export async function withT3Lock<T>(relayHome: string, action: () => Promise<T> | T): Promise<T> {
  const folder = join(relayHome, "locks");
  makePrivateFolder(folder);
  const handle = await lock(join(folder, "t3-resume.lock"), LOCK_WAIT_MS);
  try {
    return await action();
  } finally {
    handle.release();
  }
}

// One action, as one JSON line in RELAY_HOME/t3/events.jsonl.
export function recordT3Event(relayHome: string, type: string, data: Record<string, string | number | boolean | null>): void {
  const folder = join(relayHome, "t3");
  makePrivateFolder(folder);
  const path = join(folder, "events.jsonl");
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) throw new Error(`${path} is not a regular file.`);
  appendFileSync(path, `${JSON.stringify({ ts: now().toISOString(), type, ...data })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The threads relay waits for, for relay status.
export function readT3Waits(relayHome: string): T3Wait[] {
  return Object.entries(readT3State(relayHome).threads)
    .filter(([, entry]) => entry.state === "waiting")
    .map(([threadId, entry]) => ({ threadId, account: entry.account, state: entry.state, reset_at: entry.reset_at, next_check_at: entry.next_check_at }));
}

export function t3WaitLine(wait: T3Wait): string {
  const head = `T3 thread ${printable(wait.threadId)} on ${printable(wait.account)}`;
  if (wait.reset_at !== null) return `${head}: waiting for the limit to reset at ${clockText(new Date(wait.reset_at))}, then continuing.`;
  const next = wait.next_check_at === null ? "" : ` relay checks again at ${clockText(new Date(wait.next_check_at))}.`;
  return `${head}: waiting for the limit to reset.${next}`;
}

function isThreadState(value: unknown): value is T3ThreadState {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const time = (field: unknown) => field === null || (typeof field === "string" && !Number.isNaN(Date.parse(field)));
  return typeof entry.account === "string" && typeof entry.run_id === "string"
    && (entry.state === "waiting" || entry.state === "sent" || entry.state === "gave_up")
    && time(entry.reset_at) && (entry.source === null || typeof entry.source === "string") && time(entry.next_check_at)
    && typeof entry.waiting_since === "string" && Number.isSafeInteger(entry.sends_in_a_row) && typeof entry.counted === "boolean"
    && (entry.sent_run_id === null || typeof entry.sent_run_id === "string") && time(entry.sent_at);
}
