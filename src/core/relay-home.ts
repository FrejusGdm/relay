import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { SettingsError } from "../cli/errors";
import { printable } from "./quote";

const GROUP_OR_OTHER_WRITE = 0o022;
const OWNER_ALL = 0o700;

// Creates the relay folder with mode 0700 when it is missing, then checks that it is a folder the
// current user owns, can read, write and open, and that no one else can write. A symbolic link
// at the path is followed only when the current user owns the link. uid is a parameter so that
// tests can simulate another owner without root.
export function ensureRelayHome(path: string, uid: number): void {
  const shown = printable(path);
  const link = attempt(path, () => lstatSync(path, { throwIfNoEntry: false }));
  if (link === undefined) attempt(path, () => createFolder(path, uid));
  else if (link.isSymbolicLink() && link.uid !== uid) throw belongsToAnotherUser(path, "folder");
  const stats = attempt(path, () => statSync(path));
  if (!stats.isDirectory()) throw new SettingsError([`relay: ${shown} is not a folder.`]);
  checkOwner(path, stats, uid, "folder", "700");
  if ((stats.mode & OWNER_ALL) !== OWNER_ALL) {
    throw new SettingsError([`relay: you cannot read, write and open ${shown}. Run "chmod 700 ${shown}" and try again.`]);
  }
}

// mkdir's mode is reduced by the umask, so relay sets 0700 afterwards, but only on the folder this
// call created. When another process created the path first, it is checked like any other.
function createFolder(path: string, uid: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  const created = lstatSync(path);
  if (created.isDirectory() && created.uid === uid) chmodSync(path, 0o700);
}

// Reads a settings file through one open descriptor, so the file that is checked is the file that
// is read. Returns null when nothing exists at the path. A symbolic link is followed, and the file
// it leads to must be a regular file the current user owns, that no one else can write, and no
// larger than maxBytes.
export function readPrivateFile(path: string, uid: number, maxBytes: number): string | null {
  if (attempt(path, () => lstatSync(path, { throwIfNoEntry: false })) === undefined) return null;
  // O_NONBLOCK stops open from waiting for a writer when the path is a named pipe.
  const fd = attempt(path, () => openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
  try {
    const stats = attempt(path, () => fstatSync(fd));
    if (!stats.isFile()) throw new SettingsError([`relay: ${printable(path)} is not a regular file.`]);
    checkOwner(path, stats, uid, "file", "600");
    const tooLarge = new SettingsError([
      `relay: ${printable(path)} is larger than ${formatSize(maxBytes)}, the most relay reads.`,
    ]);
    if (stats.size > maxBytes) throw tooLarge;
    // The file can grow after fstat, so reading stops one byte past the limit.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = attempt(path, () => readSync(fd, buffer, length, buffer.length - length, null));
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes) throw tooLarge;
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

function checkOwner(path: string, stats: Stats, uid: number, what: "folder" | "file", mode: string): void {
  if (stats.uid !== uid) throw belongsToAnotherUser(path, what);
  if ((stats.mode & GROUP_OR_OTHER_WRITE) !== 0) {
    const shown = printable(path);
    throw new SettingsError([`relay: other users can change ${shown}. Run "chmod ${mode} ${shown}" and try again.`]);
  }
}

function belongsToAnotherUser(path: string, what: "folder" | "file"): SettingsError {
  return new SettingsError([`relay: ${printable(path)} belongs to another user. relay only uses a ${what} you own.`]);
}

// Runs one file-system call and turns its error into a plain sentence. The system's own message is
// not repeated.
function attempt<T>(path: string, call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError([`relay: cannot use ${printable(path)}: ${reasonFor(errorCode(error))}.`]);
  }
}

function reasonFor(code: string | undefined): string {
  switch (code) {
    case "ENOENT":
      return "it, or the file it links to, does not exist";
    case "EACCES":
    case "EPERM":
      return "you do not have permission";
    case "ENOTDIR":
      return "part of the path is not a folder";
    case "ELOOP":
      return "it leads through too many symbolic links";
    default:
      return `the system reported ${code && /^E[A-Z]+$/.test(code) ? code : "an unknown error"}`;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function formatSize(bytes: number): string {
  const mb = 1_048_576;
  return bytes % mb === 0 ? `${bytes / mb} MB` : `${bytes} bytes`;
}
