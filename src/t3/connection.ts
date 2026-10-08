import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRelayHome, readPrivateFile } from "../core/relay-home";
import type { SecretStore } from "./secrets";

export interface ConnectionRecord {
  v: 1;
  url: string;
  connected_at: string;
  expires_at: string;
  server_version: string | null;
}

export function readConnection(relayHome: string): ConnectionRecord | null {
  const text = readPrivateFile(join(relayHome, "t3", "connection.json"), process.getuid!(), 16_384);
  if (text === null) return null;
  try {
    const record: unknown = JSON.parse(text);
    if (!validRecord(record)) throw new Error();
    return record;
  } catch {
    throw new Error("relay could not read the T3 Code connection record. Run relay t3 connect again.");
  }
}

export function writeConnection(relayHome: string, record: ConnectionRecord): void {
  if (!validRecord(record)) throw new Error("relay could not save the T3 Code connection record.");
  ensureRelayHome(relayHome, process.getuid!());
  const dir = join(relayHome, "t3");
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.uid !== process.getuid!()) {
    throw new Error("relay needs a T3 connection folder you own.");
  }
  chmodSync(dir, 0o700);
  const temp = join(dir, `.connection-${crypto.randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    // Select fields explicitly, even when a caller passes an object with extra properties.
    const { v, url, connected_at, expires_at, server_version } = record;
    writeFileSync(fd, `${JSON.stringify({ v, url, connected_at, expires_at, server_version })}\n`);
    renameSync(temp, join(dir, "connection.json"));
  } finally {
    closeSync(fd);
    rmSync(temp, { force: true });
  }
}

export function removeConnection(relayHome: string): void {
  rmSync(join(relayHome, "t3", "connection.json"), { force: true });
}

export function connectionState(record: ConnectionRecord | null, now: Date): "connected" | "expiring" | "expired" | "none" {
  if (!record) return "none";
  const left = Date.parse(record.expires_at) - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return "expired";
  return left <= 3 * 86_400_000 ? "expiring" : "connected";
}

export function tokenGetter(store: SecretStore, url: string): () => Promise<string | null> {
  return () => store.get(url);
}

function validRecord(value: unknown): value is ConnectionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ConnectionRecord>;
  return record.v === 1 && typeof record.url === "string"
    && typeof record.connected_at === "string" && Number.isFinite(Date.parse(record.connected_at))
    && typeof record.expires_at === "string" && Number.isFinite(Date.parse(record.expires_at))
    && (record.server_version === null || typeof record.server_version === "string");
}
