// .relay/events.jsonl (the job-files spec, "events.jsonl format"). This module is the only code
// that writes the file: every event in the program goes through appendEvent, which holds the
// events lock while it reads the last id and writes one complete line. A last line without a
// newline is a write that was interrupted: readers ignore it unless it is a whole event, and the
// next append starts on a new line. Events never hold environment values, command output or
// secrets.
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { withEventsLock } from "./lock";

export interface JobRef {
  id: string;
  worktreeRoot: string;
  relayHome: string;
}

export interface RelayEvent {
  v: 1;
  id: number;
  ts: string;
  job: string;
  type: string;
  actor: "relay";
  data: Record<string, unknown>;
}

// How much of the end of the file is read to find the last complete line.
const TAIL_BYTES = 64 * 1024;

function eventsPath(job: JobRef): string {
  return join(job.worktreeRoot, ".relay", "events.jsonl");
}

// relay init creates the empty file in the .relay folder it just made.
export function createEventLog(job: JobRef): void {
  closeSync(openSync(eventsPath(job), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644));
}

export async function appendEvent(job: JobRef, type: string, data: Record<string, unknown>): Promise<RelayEvent> {
  return await withEventsLock(job.relayHome, job.id, () => {
    const fd = openLog(job, constants.O_RDWR | constants.O_APPEND);
    try {
      const { lastId, endsWithNewline } = readTail(fd, eventsPath(job));
      const event: RelayEvent = { v: 1, id: lastId + 1, ts: new Date().toISOString(), job: job.id, type, actor: "relay", data };
      const bytes = Buffer.from(`${endsWithNewline ? "" : "\n"}${JSON.stringify(event)}\n`, "utf8");
      // One write call, so another reader sees the whole line or none of it.
      const written = writeSync(fd, bytes);
      if (written !== bytes.length) throw new Error(`relay wrote only part of an event to ${eventsPath(job)}.`);
      return event;
    } finally {
      closeSync(fd);
    }
  });
}

// Every event, in file order, also a last one whose newline was never written. A line that is not
// an event is what remains of an interrupted write, and is skipped.
export function readEvents(job: JobRef): RelayEvent[] {
  const fd = openLog(job, constants.O_RDONLY);
  try {
    return readRange(fd, 0, fstatSync(fd).size).split("\n").flatMap((line) => toEvent(line) ?? []);
  } finally {
    closeSync(fd);
  }
}

// Opens the log without following a symbolic link, and checks that it is a regular file.
function openLog(job: JobRef, flags: number): number {
  const path = eventsPath(job);
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`${path} is not a regular file.`);
  }
  return fd;
}

// The id of the last event (0 when there is none), and whether the file ends with a newline (an
// empty file counts as ending with one). Blank lines are skipped. A last line without a newline
// counts when it is a whole event: the write was stopped just before its newline, and the event
// keeps its id. Otherwise it is part of an event and is ignored.
function readTail(fd: number, path: string): { lastId: number; endsWithNewline: boolean } {
  const size = fstatSync(fd).size;
  if (size === 0) return { lastId: 0, endsWithNewline: true };
  let start = Math.max(0, size - TAIL_BYTES);
  let text = readRange(fd, start, size);
  const endsWithNewline = text.endsWith("\n");
  for (;;) {
    const pieces = text.split("\n");
    // When the read starts in the middle of the file, the first piece may be cut, so it does not
    // count; when it is the only piece, more of the file is read.
    const first = start > 0 ? 1 : 0;
    for (let i = pieces.length - 1; i >= first; i--) {
      const piece = pieces[i]!;
      if (piece.trim() === "") continue;
      const event = toEvent(piece);
      if (event !== undefined) return { lastId: event.id, endsWithNewline };
      if (i === pieces.length - 1) continue;
      throw new Error(`relay cannot read ${path}: its last complete line is not an event.`);
    }
    if (start === 0) return { lastId: 0, endsWithNewline };
    start = Math.max(0, start - TAIL_BYTES);
    text = readRange(fd, start, size);
  }
}

function readRange(fd: number, start: number, end: number): string {
  const buffer = Buffer.alloc(end - start);
  let length = 0;
  while (length < buffer.length) {
    const read = readSync(fd, buffer, length, buffer.length - length, start + length);
    if (read === 0) break;
    length += read;
  }
  return buffer.toString("utf8", 0, length);
}

function toEvent(line: string): RelayEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const id = (event as { id?: unknown } | null)?.id;
  return typeof event === "object" && event !== null && Number.isSafeInteger(id) ? (event as RelayEvent) : undefined;
}
