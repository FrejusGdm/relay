// The private record of each handoff, RELAY_HOME/jobs/<job>/handoffs/<n>/ (add-relay-switch, design
// decision 21): handoff.json, and the copies of what the next agent received, prompt.md and
// instructions.md, with the cleaned notes in notes.md. Folders have mode 0700 and files 0600.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobFolder, writePrivateFile } from "./files";

type HandoffOutcome = "started" | "prepared" | "start_failed";

export interface HandoffRecord {
  number: number;
  created_at: string;
  from_account: string | null;
  to_account: string;
  checkpoint: { number: number; commit: string; reused: boolean; tree: string };
  handoff_ref: string;
  handoff_commit: string;
  prompt_path: string;
  notes_source: "agent" | "relay";
  notes_reason: string | null;
  claims_count: number;
  mismatches: { claim: string; found: string }[];
  checks: { command: string; outcome: string }[];
  confirmations: { question: string; how: string }[];
  instruction_files_changed: string[];
  to_worker_id: string | null;
  outcome: HandoffOutcome;
  start_error: string | null;
  // The mode and level the next agent starts with.
  start: { mode: "interactive" | "headless"; permission: "read-only" | "edit-in-workspace" | null };
}

export function handoffFolder(relayHome: string, jobId: string, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`relay refused the handoff number ${number}.`);
  return join(jobFolder(relayHome, jobId), "handoffs", String(number));
}

export function writeHandoffFile(relayHome: string, jobId: string, number: number, name: string, text: string): string {
  const path = join(handoffFolder(relayHome, jobId, number), name);
  writePrivateFile(path, text);
  return path;
}

export function writeHandoffRecord(relayHome: string, jobId: string, record: HandoffRecord): void {
  writeHandoffFile(relayHome, jobId, record.number, "handoff.json", `${JSON.stringify(record, null, 2)}\n`);
}

export function readHandoffRecord(relayHome: string, jobId: string, number: number): HandoffRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(handoffFolder(relayHome, jobId, number), "handoff.json"), "utf8")) as HandoffRecord;
    return value?.number === number && typeof value.to_account === "string" ? value : null;
  } catch {
    return null;
  }
}

// The newest handoff of the job that has a record, or null.
export function newestHandoff(relayHome: string, jobId: string): HandoffRecord | null {
  let names: string[];
  try {
    names = readdirSync(join(jobFolder(relayHome, jobId), "handoffs"));
  } catch {
    return null;
  }
  const numbers = names.filter((name) => /^[1-9][0-9]*$/.test(name)).map(Number).sort((a, b) => b - a);
  for (const number of numbers) {
    const record = readHandoffRecord(relayHome, jobId, number);
    if (record !== null) return record;
  }
  return null;
}

export function markHandoff(relayHome: string, jobId: string, number: number, outcome: HandoffOutcome, changes: Partial<HandoffRecord> = {}): void {
  const record = readHandoffRecord(relayHome, jobId, number);
  if (record !== null) writeHandoffRecord(relayHome, jobId, { ...record, ...changes, outcome });
}
