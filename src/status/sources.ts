// Where relay status gets its data (design.md decision 20, "Getting the data"). With the daemon,
// the API answers are used as they are. Without it, relay builds the same index in memory from
// this project's files, then adds the newest availability per account from a read-only copy of
// relay.db and from hook events spooled while the daemon was down. Nothing is written.
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "../core/config/types";
import { availabilityFromHook } from "../hooks/mapping";
import { applyAvailability } from "../state/apply-event";
import { databasePath, openMemoryDatabase } from "../state/db";
import { indexProject, syncTargets } from "../state/index-builder";
import { getJob, listAccounts, listWorkers, type UsageItem } from "../state/queries";
import type { StatusData } from "./model";

const SPOOL_MAX_BYTES = 10 * 1024 * 1024;
const TARGET = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$/;

export async function fromFiles(
  relayHome: string,
  root: string,
  jobId: string,
  accounts: Account[],
): Promise<Omit<StatusData, "daemon" | "savedState"> | null> {
  const db = openMemoryDatabase();
  try {
    syncTargets(db, relayHome, accounts);
    await indexProject(db, relayHome, root);
    addSavedAvailability(db, relayHome);
    addSpooledHooks(db, relayHome, accounts);
    const job = getJob(db, jobId);
    if (job === null) return null;
    return { job, workers: listWorkers(db, jobId), accounts: listAccounts(db) };
  } finally {
    db.close();
  }
}

// relay.db as the daemon left it, opened read-only. A failure to open or read it is ignored.
function addSavedAvailability(db: Database, relayHome: string): void {
  let saved: Database;
  try {
    saved = new Database(databasePath(relayHome), { readonly: true, strict: true });
  } catch {
    return;
  }
  try {
    const rows = saved
      .query<
        { target_id: string; status: string; reason: string | null; retry_at: string | null; measured_at: string | null; source: string | null; usage_json: string },
        []
      >("SELECT * FROM availability")
      .all();
    for (const row of rows) {
      const usage = JSON.parse(row.usage_json) as UsageItem[];
      applyAvailability(db, row.target_id, {
        ...row,
        windows: usage.map((item) => ({ ...item, name: item.window })),
      });
    }
  } catch {
    // An old or damaged file adds nothing.
  } finally {
    saved.close();
  }
}

// spool/hooks.jsonl and leftover spool/hooks.<pid>.draining files (the spool line of
// add-provider-adapters design decision 14). The account is relay_target, else the configured
// account whose profile folder the hook names.
function addSpooledHooks(db: Database, relayHome: string, accounts: Account[]): void {
  const dir = join(relayHome, "spool");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name === "hooks.jsonl" || /^hooks\.\d+\.draining$/.test(name));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const text = readSpoolFile(path);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const entry = parse(line);
      if (entry === null) continue;
      const target = accountOf(entry, accounts);
      const change = availabilityFromHook(entry.provider, entry.event, entry.fields);
      if (target === null || change === null) continue;
      applyAvailability(db, target, { ...change, retry_at: null, measured_at: entry.received_at, source: "hook", windows: [] });
    }
  }
}

// A spool file's text, or null when it is not a regular file (a named pipe would block the read),
// is a symbolic link, is larger than 10 MB or cannot be read.
function readSpoolFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > SPOOL_MAX_BYTES) return null;
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.toString("utf8", 0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

interface SpoolEntry {
  received_at: string;
  provider: string;
  event: string;
  relay_target: string | null;
  profile: string | null;
  fields: Record<string, unknown>;
}

function parse(line: string): SpoolEntry | null {
  if (line.trim() === "") return null;
  try {
    const value = JSON.parse(line) as Partial<SpoolEntry>;
    if (typeof value.received_at !== "string" || typeof value.provider !== "string" || typeof value.event !== "string") return null;
    return {
      received_at: value.received_at,
      provider: value.provider,
      event: value.event,
      relay_target: typeof value.relay_target === "string" ? value.relay_target : null,
      profile: typeof value.profile === "string" ? value.profile : null,
      fields: typeof value.fields === "object" && value.fields !== null ? value.fields : {},
    };
  } catch {
    return null;
  }
}

function accountOf(entry: SpoolEntry, accounts: Account[]): string | null {
  if (entry.relay_target !== null) return TARGET.test(entry.relay_target) ? entry.relay_target : null;
  const match = accounts.find(
    (account) =>
      account.provider === entry.provider &&
      (entry.profile === "default" ? account.profileDirIsDefault : account.profileDir === entry.profile),
  );
  return match?.id ?? null;
}
