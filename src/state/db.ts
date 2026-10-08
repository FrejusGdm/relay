// Opening relay.db, the daemon's live-state index (design.md decisions 10 and 11). The database is
// a cache: when it is missing, damaged or of another schema version, a new one is created and the
// caller rebuilds it from the files. Each new database gets a new stream_epoch, so a client can
// tell a rebuilt event stream from a daemon restart that kept its history.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../core/version";
import schema from "./schema.sql" with { type: "text" };

export const SCHEMA_VERSION = 1;

export interface OpenedDatabase {
  db: Database;
  // Why the database is new and must be filled from the files, or null when it was kept.
  rebuilt: "missing" | "damaged" | "old_schema" | null;
  // The name a damaged file was moved to.
  brokenFile: string | null;
}

export function databasePath(relayHome: string): string {
  return join(relayHome, "relay.db");
}

const SIDE_FILES = ["-wal", "-shm"];

export function openDatabase(relayHome: string, now: () => Date = () => new Date()): OpenedDatabase {
  const path = databasePath(relayHome);
  if (!existsSync(path)) {
    // A write-ahead log left by an older database must not be applied to the new one.
    for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
    return { db: create(path), rebuilt: "missing", brokenFile: null };
  }

  let db: Database | null = null;
  try {
    db = new Database(path, { strict: true });
    const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") throw new Error("integrity check failed");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    if (version !== SCHEMA_VERSION) {
      db.close();
      for (const suffix of ["", ...SIDE_FILES]) rmSync(`${path}${suffix}`, { force: true });
      return { db: create(path), rebuilt: "old_schema", brokenFile: null };
    }
    configure(db);
    return { db, rebuilt: null, brokenFile: null };
  } catch {
    db?.close();
    const brokenFile = `${path}.broken-${now().toISOString().replace(/[-:.]/g, "")}`;
    renameSync(path, brokenFile);
    for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
    return { db: create(path), rebuilt: "damaged", brokenFile };
  }
}

function create(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  configure(db);
  db.exec(schema);
  const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("built_at", new Date().toISOString());
  insert.run("daemon_version", VERSION);
  insert.run("stream_epoch", Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex"));
  return db;
}

function configure(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 2000");
}

export function streamEpoch(db: Database): string {
  return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'stream_epoch'").get()?.value ?? "";
}
