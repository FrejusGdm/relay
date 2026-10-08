// Keeps .relay/ out of the person's commits (the job-files spec): relay init adds the line
// /.relay/ to info/exclude in the common git folder, which applies to every worktree. relay never
// edits a tracked .gitignore file.
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { printable } from "../core/quote";
import type { Repository } from "../git/repo";

const LINE = "/.relay/";
const COMMENT = "# relay: job files stay local";
const MAX_BYTES = 10 * 1024 * 1024;

function refuse(path: string, reason: string): CommandError {
  return new CommandError(ExitCode.NotPossibleHere, [`relay cannot add ${LINE} to ${printable(path)}: ${reason}.`]);
}

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? "unknown error";
}

// The info/exclude path in the common git folder, built by relay rather than asked from git,
// because git follows a symbolic link there. relay checks it before it creates anything: the file
// and its folder may be missing, but neither may be a symbolic link, the file must be a regular
// file with one hard link, and the person must be able to write to it.
export function excludePath(repo: Repository): string {
  const path = join(repo.commonDir, "info", "exclude");
  const folder = lstatSync(dirname(path), { throwIfNoEntry: false });
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (folder !== undefined && !folder.isDirectory()) throw refuse(path, "its folder is a symbolic link or not a folder");
  if (file !== undefined && !file.isFile()) throw refuse(path, "it is a symbolic link or not a regular file");
  if (file !== undefined && file.nlink !== 1) throw refuse(path, "it has more than one hard link");
  try {
    accessSync(file !== undefined ? path : folder !== undefined ? dirname(path) : repo.commonDir, constants.W_OK);
  } catch {
    throw refuse(path, "you cannot write to it");
  }
  return path;
}

// Adds the comment and the line unless the exact line is already there, and returns whether it
// added them. The checks run again on the opened file, so a file swapped in after excludePath is
// not written.
export function addExcludeLine(path: string): boolean {
  try {
    mkdirSync(dirname(path));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw refuse(path, `relay could not create its folder (${errorCode(error)})`);
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (error) {
    throw refuse(path, `relay could not open it (${errorCode(error)})`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_BYTES) throw refuse(path, "it is not a regular file, or it is larger than 10 MB");
    if (stats.nlink !== 1) throw refuse(path, "it has more than one hard link");
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const text = buffer.toString("utf8", 0, length);
    if (text.split(/\r?\n/).includes(LINE)) return false;
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    writeSync(fd, `${separator}${COMMENT}\n${LINE}\n`);
    return true;
  } finally {
    closeSync(fd);
  }
}
