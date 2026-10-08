// Building the index from the files (design.md decision 11): config.toml's accounts, phase 3's
// availability.json files, each listed project's .relay/state.json and events.jsonl, and the
// checkpoint refs in git, which are the source of truth for checkpoints. Everything a project
// needs is read first; the rows are then written in one transaction.
import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { listCheckpoints, type CheckpointInfo } from "../checkpoint/list";
import type { Account } from "../core/config/types";
import { openRepository } from "../git/repo";
import type { RelayEvent } from "../job/events";
import { readState, StateFileError } from "../job/state";
import { applyAvailability, applyEvent } from "./apply-event";

const MAX_SMALL_FILE = 1024 * 1024;
// An event type is written into the event stream's "event:" line, so a type that could hold a
// line break or another field is refused, and the line is treated as not an event.
const EVENT_TYPE = /^[a-z_]{1,64}$/;

export interface EventRead {
  events: RelayEvent[];
  // Byte positions of lines that are not events, for the log.
  invalid: number[];
  // Where the next read starts: the end of the last complete line.
  offset: number;
  device: number;
  inode: number;
  size: number;
}

interface ProjectRead {
  root: string;
  job: {
    id: string;
    title: string;
    state: string;
    updatedAt: string;
    events: EventRead;
    checkpoint: CheckpointInfo | null;
  } | null;
}

// Fills an empty index. Returns the number of projects whose job was indexed.
export async function buildIndex(db: Database, relayHome: string, accounts: Account[], roots: string[]): Promise<number> {
  syncTargets(db, relayHome, accounts);
  let indexed = 0;
  for (const root of roots) {
    if (await indexProject(db, relayHome, root)) indexed++;
  }
  return indexed;
}

// Writes config.toml's accounts to the targets table, with the availability from phase 3's
// availability.json when it is newer than what the index holds. Accounts that left config.toml
// stay, marked as not configured, because events may still name them.
export function syncTargets(db: Database, relayHome: string, accounts: Account[]): void {
  db.transaction(() => {
    db.prepare("UPDATE targets SET configured = 0").run();
    for (const account of accounts) {
      db.prepare(
        `INSERT INTO targets (id, provider, account, profile_dir, configured) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET profile_dir = excluded.profile_dir, configured = 1`,
      ).run(account.id, account.provider, account.name, account.profileDir);
      const record = readAvailabilityFile(relayHome, account.provider, account.name);
      if (record !== null) applyAvailability(db, account.id, record);
      else db.prepare("INSERT OR IGNORE INTO availability (target_id, status) VALUES (?, 'unknown')").run(account.id);
    }
  })();
}

// (Re)indexes one project: its old rows are replaced. Returns false when the project has no
// readable job, in which case it is marked missing and rows it already had are kept, so a job
// whose folder disappears while the daemon runs stays in the index, shown as missing.
export async function indexProject(db: Database, relayHome: string, root: string): Promise<boolean> {
  const read = await readProject(relayHome, root);
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (root_path, missing, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (root_path) DO UPDATE SET missing = excluded.missing, last_seen_at = excluded.last_seen_at`,
    ).run(root, read.job === null ? 1 : 0, now);
    const job = read.job;
    if (job === null) return;
    db.prepare("DELETE FROM jobs WHERE project_root = ?").run(root);
    // A job copied to another folder keeps its ID; the project read last wins.
    db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    db.prepare("INSERT INTO jobs (id, project_root, title, state, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      job.id,
      root,
      job.title,
      job.state,
      job.updatedAt,
    );
    for (const event of job.events.events) applyEvent(db, job.id, event);
    setCheckpoint(db, job.id, job.checkpoint);
    db.prepare(
      "INSERT OR REPLACE INTO event_cursors (job_id, path, device, inode, offset, last_event_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(job.id, eventsFile(root), job.events.device, job.events.inode, job.events.offset, job.events.events.at(-1)?.id ?? 0);
  })();
  return read.job !== null;
}

// The newest checkpoint from git replaces what the events said.
export function setCheckpoint(db: Database, jobId: string, checkpoint: CheckpointInfo | null): void {
  if (checkpoint === null) return;
  db.prepare(
    `UPDATE jobs SET last_checkpoint_number = ?, last_checkpoint_commit = ?, last_checkpoint_at = ?,
       last_checkpoint_kind = ?, last_checkpoint_message = ? WHERE id = ?`,
  ).run(checkpoint.number, checkpoint.commit, checkpoint.createdAt.toISOString(), checkpoint.kind, checkpoint.message, jobId);
}

export async function newestCheckpoint(root: string, jobId: string): Promise<CheckpointInfo | null> {
  try {
    return (await listCheckpoints(await openRepository(root), jobId))[0] ?? null;
  } catch {
    return null;
  }
}

export function eventsFile(root: string): string {
  return join(root, ".relay", "events.jsonl");
}

async function readProject(relayHome: string, root: string): Promise<ProjectRead> {
  const relayDir = join(root, ".relay");
  let state;
  try {
    state = readState(relayDir);
  } catch (error) {
    if (error instanceof StateFileError) return { root, job: null };
    throw error;
  }
  let events: EventRead;
  try {
    events = readEventsFrom(eventsFile(root), 0);
  } catch {
    return { root, job: null };
  }
  return {
    root,
    job: {
      id: state.job_id,
      title: state.title || taskHeading(relayDir) || "Untitled job",
      state: state.status,
      updatedAt: state.updated_at,
      events,
      checkpoint: await newestCheckpoint(root, state.job_id),
    },
  };
}

function taskHeading(relayDir: string): string | null {
  try {
    const text = readFileSync(join(relayDir, "task.md"), "utf8").slice(0, MAX_SMALL_FILE);
    return /^# (.+)$/m.exec(text)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// Reads complete lines from `offset` to the end of the file. An incomplete last line is left for
// the next read. A symbolic link or anything but a regular file is refused.
export function readEventsFrom(path: string, offset: number): EventRead {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`${path} is not a regular file.`);
    const base = { device: stats.dev, inode: stats.ino, size: stats.size };
    if (stats.size <= offset) return { events: [], invalid: [], offset, ...base };
    const buffer = Buffer.alloc(stats.size - offset);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, offset + length);
      if (read === 0) break;
      length += read;
    }
    const end = buffer.subarray(0, length).lastIndexOf(0x0a) + 1;
    const events: RelayEvent[] = [];
    const invalid: number[] = [];
    let position = 0;
    for (const line of buffer.toString("utf8", 0, end).split("\n").slice(0, -1)) {
      const bytes = Buffer.byteLength(line) + 1;
      if (line.trim() !== "") {
        const event = parseEvent(line);
        if (event === null) invalid.push(offset + position);
        else events.push(event);
      }
      position += bytes;
    }
    return { events, invalid, offset: offset + end, ...base };
  } finally {
    closeSync(fd);
  }
}

function parseEvent(line: string): RelayEvent | null {
  try {
    const value = JSON.parse(line) as Partial<RelayEvent> | null;
    if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.id)) return null;
    if (typeof value.type !== "string" || !EVENT_TYPE.test(value.type)) return null;
    return {
      ...value,
      ts: typeof value.ts === "string" ? value.ts : new Date(0).toISOString(),
      data: typeof value.data === "object" && value.data !== null ? value.data : {},
    } as RelayEvent;
  } catch {
    return null;
  }
}

// Phase 3's availability.json, in the form of an availability event's data. null when the file is
// missing, too large or not the expected JSON.
function readAvailabilityFile(relayHome: string, provider: string, name: string): Record<string, unknown> | null {
  try {
    const path = join(relayHome, "accounts", `${provider}-${name}`, "availability.json");
    const text = readFileSync(path, "utf8");
    if (text.length > MAX_SMALL_FILE) return null;
    const record = JSON.parse(text) as Record<string, unknown>;
    return {
      status: record.state,
      reason: record.detail ?? null,
      retry_at: record.retry_at ?? null,
      measured_at: record.observed_at ?? null,
      source: record.source ?? null,
      windows: record.windows ?? [],
    };
  } catch {
    return null;
  }
}
