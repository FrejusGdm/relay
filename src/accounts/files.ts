// Private files of one account under RELAY_HOME/accounts/<provider>-<name>/ (folders 0700, files
// 0600, each file replaced through a temporary file and a rename).
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "../core/config/types";

export function accountFolder(relayHome: string, account: Pick<Account, "provider" | "name">): string {
  return join(relayHome, "accounts", `${account.provider}-${account.name}`);
}

// The parsed JSON file, or null when it is missing, not a regular file or not valid JSON.
export function readJsonFile(path: string): unknown {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  const folder = join(path, "..");
  for (const dir of [join(folder, ".."), folder]) {
    if (lstatSync(dir, { throwIfNoEntry: false }) !== undefined) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}
