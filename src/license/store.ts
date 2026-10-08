// The saved license key, RELAY_HOME/license.key: one line, mode 0600, written through a temporary
// file and a rename, and read with the same owner and permission checks as config.toml
// (add-lifetime-license, design decision 10).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readPrivateFile } from "../core/relay-home";

const MAX_BYTES = 4096;

export function licenseFile(relayHome: string): string {
  return join(relayHome, "license.key");
}

// The saved key without its line ending, or null when no key is saved. Throws a SettingsError
// when the file belongs to another user, others can write it, or it is too large.
export function readLicense(relayHome: string, uid: number): string | null {
  const text = readPrivateFile(licenseFile(relayHome), uid, MAX_BYTES);
  return text === null ? null : text.trim();
}

// A failed write or rename leaves the old file as it was. `rename` is a parameter for tests.
export function writeLicense(relayHome: string, key: string, rename: typeof renameSync = renameSync): void {
  const temporary = join(relayHome, `tmp-license-${randomBytes(6).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    // The umask can remove bits from the mode given to open, never add them; this sets it exactly.
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(`${key}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    rename(temporary, licenseFile(relayHome));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Returns false when no key was saved.
export function removeLicense(relayHome: string): boolean {
  try {
    rmSync(licenseFile(relayHome));
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
