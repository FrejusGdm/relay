// Account profile folders (add-provider-adapters, design decision 10; the provider-accounts spec,
// "Profile folders").
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Account } from "../core/config/types";
import { resolveHomedir } from "../core/paths";
import { printable } from "../core/quote";

const DEFAULT_FOLDERS = { claude: ".claude", codex: ".codex" } as const;

// True when the account uses the provider's own folder, ~/.claude or ~/.codex. relay then leaves
// the profile variable unset (design decision 6).
export function usesProviderDefaultFolder(account: Account, home = resolveHomedir(process.env)): boolean {
  return account.profileDir === resolve(home, DEFAULT_FOLDERS[account.provider]);
}

// A profile folder that relay cannot use. The command prints `message` and exits with code 78.
export class ProfileError extends Error {}

// The path as the person would type it, with the home folder written as ~.
export function displayPath(path: string, home = resolveHomedir(process.env)): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// Checks that the profile folder is a real folder the current user owns and that no one else can
// change. A missing folder passes. relay never changes the mode of a folder it did not create.
export function checkProfileFolder(dir: string, uid: number, home = resolveHomedir(process.env)): void {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return;
  const shown = printable(displayPath(dir, home));
  if (stats.isSymbolicLink()) throw new ProfileError(`${shown} is a symbolic link. relay only uses a real folder as a profile folder.`);
  if (!stats.isDirectory()) throw new ProfileError(`${shown} is not a folder.`);
  if (stats.uid !== uid) throw new ProfileError(`${shown} belongs to another user. relay only uses a profile folder you own.`);
  if ((stats.mode & 0o022) !== 0) throw new ProfileError(`Other users can change ${shown}. Run chmod 700 on it, then try again.`);
}

// Creates the profile folder with mode 0700 when it is missing, and for a folder under
// RELAY_HOME/profiles/ also that parent with mode 0700, then checks it. Returns whether relay
// created the folder.
export function ensureProfileFolder(dir: string, relayHome: string, uid: number, home = resolveHomedir(process.env)): boolean {
  const profiles = join(relayHome, "profiles");
  if (dirname(dir) === profiles) {
    makePrivateFolder(profiles);
    checkProfileFolder(profiles, uid, home);
  }
  checkProfileFolder(dir, uid, home);
  const created = makePrivateFolder(dir);
  checkProfileFolder(dir, uid, home);
  return created;
}

// mkdir's mode is reduced by the umask, so 0700 is set again, but only on a folder this call made.
function makePrivateFolder(path: string): boolean {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  }
  chmodSync(path, 0o700);
  return true;
}
