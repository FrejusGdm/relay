// .relay/state.json (the job-files spec, "state.json schema"). relay replaces the file whole, so a
// crash leaves the old or the new content. Readers ignore fields they do not know, because later
// changes add fields without a new schema version.
import {
  closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { printable } from "../core/quote";
import { isJobId } from "./id";

export interface CheckpointRef {
  number: number;
  commit: string;
  ref: string;
  kind: string;
  created_at: string;
}

export interface JobState {
  schema_version: 1;
  job_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  relay_version: string;
  repository: { worktree_root: string; common_git_dir: string; linked_worktree: boolean };
  start: { head: string | null; branch: string | null; detached: boolean };
  latest_checkpoint: CheckpointRef | null;
  checkpoint_count: number;
  approved_paths: string[];
  last_rollback: Record<string, unknown> | null;
  // Fields added by later changes are kept when relay rewrites the file.
  [field: string]: unknown;
}

const STATE_FILE = "state.json";
const MAX_BYTES = 1024 * 1024;

export function statePath(relayDir: string): string {
  return join(relayDir, STATE_FILE);
}

// A state.json that is missing (`problem` null) or damaged. Commands that need a job turn it into
// their own message; relay init repeats the line as it is.
export class StateFileError extends CommandError {
  constructor(path: string, readonly problem: string | null) {
    super(ExitCode.NotPossibleHere, [
      problem === null ? `The job file ${printable(path)} is missing.` : `The job file ${printable(path)} is damaged: ${problem}.`,
    ]);
    this.name = "StateFileError";
  }
}

function damaged(path: string, problem: string): StateFileError {
  return new StateFileError(path, problem);
}

export function readState(relayDir: string): JobState {
  const path = statePath(relayDir);
  let text: string;
  try {
    text = readSmallFile(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new StateFileError(path, null);
    if (code === "ELOOP") throw damaged(path, "it is a symbolic link");
    if (error instanceof CommandError) throw error;
    // For example EACCES when the person cannot read it, or ENOTDIR when .relay is a file.
    throw damaged(path, `relay cannot read it (${code ?? "unknown error"})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw damaged(path, "it is not valid JSON");
  }
  const problem = stateProblem(value);
  if (problem !== undefined) throw damaged(path, problem);
  return value as JobState;
}

// The text of state.json for a state.
export function stateText(state: JobState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

// Writes state.json.tmp, then renames it over state.json. `afterWrite` lets a test stop between
// the two steps, as a crash would.
export function writeState(relayDir: string, state: JobState, afterWrite?: () => void): void {
  const path = statePath(relayDir);
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, stateText(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  afterWrite?.();
  renameSync(temporary, path);
}

// Reads a regular file through one descriptor, without following a symbolic link or waiting on
// a named pipe.
function readSmallFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw damaged(path, "it is not a regular file");
    if (stats.size > MAX_BYTES) throw damaged(path, "it is larger than 1 MB");
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const isCount: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const isTime: Check = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const orNull = (check: Check): Check => (value) => value === null || check(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fieldsProblem(value: unknown, where: string, fields: Record<string, Check>): string | undefined {
  if (!isObject(value)) return `${where} is not an object`;
  for (const [name, check] of Object.entries(fields)) {
    if (!check(value[name])) return `${where}${name} is missing or has the wrong type`;
  }
  return undefined;
}

const CHECKPOINT_FIELDS: Record<string, Check> = {
  number: (value) => isCount(value) && (value as number) >= 1,
  commit: isString,
  ref: isString,
  kind: isString,
  created_at: isTime,
};

// Returns the first problem found, or nothing for a valid state.
function stateProblem(value: unknown): string | undefined {
  const top = fieldsProblem(value, "", {
    schema_version: (field) => field === 1,
    job_id: isJobId,
    title: isString,
    status: isString,
    created_at: isTime,
    updated_at: isTime,
    relay_version: isString,
    repository: isObject,
    start: isObject,
    latest_checkpoint: orNull(isObject),
    checkpoint_count: isCount,
    approved_paths: (field) => Array.isArray(field) && field.every(isString),
    last_rollback: orNull(isObject),
  });
  if (top !== undefined) return top;
  const state = value as Record<string, unknown>;
  return (
    fieldsProblem(state.repository, "repository.", {
      worktree_root: isString,
      common_git_dir: isString,
      linked_worktree: isBoolean,
    }) ??
    fieldsProblem(state.start, "start.", { head: orNull(isString), branch: orNull(isString), detached: isBoolean }) ??
    (state.latest_checkpoint === null
      ? undefined
      : fieldsProblem(state.latest_checkpoint, "latest_checkpoint.", CHECKPOINT_FIELDS))
  );
}
