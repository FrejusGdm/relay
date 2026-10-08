// The hook spool, RELAY_HOME/spool/hooks.jsonl (add-provider-adapters, design decision 14). relay
// hook appends one line per event with one write call; readers trim it, because no daemon empties
// it in this version.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, chmodSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { now } from "../platform/clock";
import type { SpoolLine } from "./fields";

const APPEND_LIMIT = 10 * 1024 * 1024;
const TRIM_SIZE = 5 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function spoolPath(relayHome: string): string {
  return join(relayHome, "spool", "hooks.jsonl");
}

// Appends the line unless the spool is larger than 10 MB. Returns whether it was written.
export function appendSpoolLine(relayHome: string, line: SpoolLine): boolean {
  const folder = join(relayHome, "spool");
  if (lstatSync(folder, { throwIfNoEntry: false }) === undefined) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
  }
  const file = spoolPath(relayHome);
  const size = lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size > APPEND_LIMIT) return false;
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Every valid line, oldest first. A line that is not a spool line is skipped.
export function readSpool(relayHome: string): SpoolLine[] {
  let text: string;
  try {
    const file = spoolPath(relayHome);
    if (!lstatSync(file).isFile()) return [];
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: SpoolLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    try {
      const value = JSON.parse(raw) as SpoolLine;
      if (value?.v === 1 && typeof value.received_at === "string" && typeof value.event === "string"
        && typeof value.fields === "object" && value.fields !== null) lines.push(value);
    } catch {
      // A line cut by a full disk or a concurrent trim.
    }
  }
  return lines;
}

// When the spool is larger than 5 MB, keeps only the lines of the last 7 days. A hook that appends
// during the rename can lose that one line; the daemon of a later version replaces this.
export function trimSpool(relayHome: string): void {
  const file = spoolPath(relayHome);
  const size = lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size <= TRIM_SIZE) return;
  const oldest = now().getTime() - KEEP_MS;
  const kept = readSpool(relayHome).filter((line) => Date.parse(line.received_at) >= oldest);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, kept.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
  renameSync(temporary, file);
}
