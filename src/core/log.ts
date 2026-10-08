import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { LOG_LEVELS, type LogLevel } from "./config/types";
import { printable } from "./quote";

// No nested objects, so a caller cannot pass process.env or a settings table by mistake.
export type LogValue = string | number | boolean | null | string[];
export type LogFields = Record<string, LogValue>;

export interface Logger {
  readonly file: string;
  readonly writing: boolean;   // false after the first failure
  setLevel(level: LogLevel): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

interface LogOptions {
  relayHome: string;
  file: string;                 // "cli.log", "hook.log", later "daemon.log"
  level: LogLevel;
  version: string;
  invocation: string;           // 8 hexadecimal characters, shared by every entry of one run
  maxBytes?: number;
  keep?: number;
  onFailure: (file: string, reason: string) => void;
  now?: () => Date;
}

// Writes one JSON object per line to <relay folder>/logs/<file> (design decision 8). A logger
// never throws: the first error calls onFailure and turns the logger off for the rest of the run.
export function openLog(opts: LogOptions): Logger {
  const dir = join(opts.relayHome, "logs");
  const file = join(dir, opts.file);
  const maxBytes = opts.maxBytes ?? 10_485_760;
  const keep = opts.keep ?? 5;
  const now = opts.now ?? (() => new Date());
  let level = opts.level;
  let off = false;

  const fail = (error: unknown) => {
    off = true;
    opts.onFailure(file, reasonOf(error));
  };

  try {
    mkdirSync(dir, { mode: 0o700 });
    // The umask can remove bits from the mode given to mkdir.
    chmodSync(dir, 0o700);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail(error);
  }
  if (!off) {
    try {
      checkFolder(dir);
    } catch (error) {
      fail(error);
    }
  }

  const write = (entryLevel: LogLevel, msg: string, fields: LogFields = {}) => {
    if (off || LOG_LEVELS.indexOf(entryLevel) < LOG_LEVELS.indexOf(level)) return;
    const entry: Record<string, LogValue> = {
      ts: now().toISOString(),
      level: entryLevel,
      msg,
      pid: process.pid,
      invocation: opts.invocation,
      version: opts.version,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (!Object.hasOwn(entry, key)) entry[key] = value;
    }
    // JSON.stringify leaves C1 controls and format characters as they are; printable() writes
    // them as \u escapes, which keeps the line valid JSON and safe to show in a terminal.
    const line = `${printable(JSON.stringify(entry))}\n`;
    try {
      const size = existingSize(file);
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(file, keep);
      append(file, line);
    } catch (error) {
      fail(error);
    }
  };

  return {
    file,
    get writing() {
      return !off;
    },
    setLevel: (next) => (level = next),
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

// The logs folder must be a real folder, not a symbolic link, that the current user owns and that
// only this user can use.
function checkFolder(dir: string): void {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink()) throw new Error("the logs folder is a symbolic link");
  if (!stats.isDirectory()) throw new Error("logs is not a folder");
  if (stats.uid !== process.getuid!()) throw new Error("the logs folder belongs to another user");
  const mode = stats.mode & 0o777;
  if (mode !== 0o700) throw new Error(`the logs folder has mode 0${mode.toString(8)}, not 0700`);
}

// Checks an existing log file before it can be rotated, so that an archive never keeps a loose
// mode: a regular file the current user owns, set to 0600. Returns 0 when there is no file.
function existingSize(file: string): number {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (!stats) return 0;
  checkLogFile(stats);
  if ((stats.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
  return stats.size;
}

function checkLogFile(stats: Stats): void {
  if (!stats.isFile()) throw new Error("it is not a regular file");
  if (stats.uid !== process.getuid!()) throw new Error("it belongs to another user");
}

// O_NOFOLLOW refuses a symbolic link, and O_NONBLOCK makes a named pipe without a reader fail at
// once instead of blocking relay. The checks then run on the open descriptor, so the file cannot
// be swapped between the check and the write. fchmod sets 0600 whatever the umask was.
function append(file: string, line: string): void {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(file, flags, 0o600);
  try {
    const stats = fstatSync(fd);
    checkLogFile(stats);
    if ((stats.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    const bytes = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
  } finally {
    closeSync(fd);
  }
}

// <file>.<keep> is deleted, <file>.<n> becomes <file>.<n+1>, and <file> becomes <file>.1. Another
// relay process may have moved a file first; that is not an error, and the entry is still written.
function rotate(file: string, keep: number): void {
  rmSync(`${file}.${keep}`, { force: true });
  for (let n = keep - 1; n >= 1; n--) renameIfPresent(`${file}.${n}`, `${file}.${n + 1}`);
  renameIfPresent(file, `${file}.1`);
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

// "EACCES: permission denied, open '<path>'" becomes "EACCES: permission denied", and
// "ENOSPC: no space left on device, write" becomes "ENOSPC: no space left on device", because the
// warning already names the file.
export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/, \w+( '.*')?$/s, "").replace(/\.$/, "");
}
