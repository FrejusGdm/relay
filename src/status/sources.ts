// Where relay status gets its data (design.md decision 20, "Getting the data"). With the daemon,
// the API answers are used as they are. Without it, relay builds the same index in memory from
// this project's files, then adds the newest availability per account from a read-only copy of
// relay.db and from hook events spooled while the daemon was down. Nothing is written.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { usesProviderDefaultFolder } from "../accounts/profile";
import type { Account } from "../core/config/types";
import { availabilityFromHook } from "../hooks/mapping";
import { readSpoolFile } from "../hooks/spool";
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
  homedir: string,
): Promise<Omit<StatusData, "daemon" | "savedState"> | null> {
  const db = openMemoryDatabase();
  try {
    syncTargets(db, relayHome, accounts);
    await indexProject(db, relayHome, root);
    addSavedAvailability(db, relayHome);
    addSpooledHooks(db, relayHome, accounts, homedir);
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
function addSpooledHooks(db: Database, relayHome: string, accounts: Account[], homedir: string): void {
  const dir = join(relayHome, "spool");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name === "hooks.jsonl" || /^hooks\.\d+\.draining$/.test(name));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const text = readSpoolFile(path, SPOOL_MAX_BYTES);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const entry = parse(line);
      if (entry === null) continue;
      const target = accountOf(entry, accounts, homedir);
      const change = availabilityFromHook(entry.provider, entry.event, entry.fields);
      if (target === null || change === null) continue;
      applyAvailability(db, target, { ...change, retry_at: null, measured_at: entry.received_at, source: "hook", windows: [] });
    }
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

// The profile "default" is the provider's own folder, ~/.claude or ~/.codex, as in the daemon
// (src/hooks/mapping.ts), not relay's default profile folder.
function accountOf(entry: SpoolEntry, accounts: Account[], homedir: string): string | null {
  if (entry.relay_target !== null) return TARGET.test(entry.relay_target) ? entry.relay_target : null;
  const match = accounts.find(
    (account) =>
      account.provider === entry.provider &&
      (entry.profile === "default" ? usesProviderDefaultFolder(account, homedir) : account.profileDir === entry.profile),
  );
  return match?.id ?? null;
}
