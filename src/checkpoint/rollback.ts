// Rollback (design.md decision 9, the rollback spec): returns the working tree to the files of a
// checkpoint. relay plans the change by comparing a snapshot of the current files with the target,
// refuses when the plan touches a file relay has not saved, saves the current files as the undo
// checkpoint, deletes and writes only the planned paths, and checks the result. It never runs
// git checkout, reset, restore, clean or stash, never moves HEAD or a branch, and never writes an
// index other than its own temporary one. .relay/ is never part of the plan.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { onInterrupt } from "../core/cleanup";
import { quote } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { appendEvent, type JobRef } from "../job/events";
import { readState, writeState } from "../job/state";
import { gitFailed } from "./commit";
import type { CheckpointInfo } from "./list";
import { saveCheckpoint, type SaveResult } from "./save";
import { buildSnapshotTree, type Snapshot } from "./snapshot";

type Action = "modify" | "add" | "delete";

interface PlanEntry {
  action: Action;
  // As git prints it, decoded for display and comparison.
  path: string;
  // git's bytes, used for every file operation, so a name that is not valid UTF-8 is still found.
  raw: Buffer;
}

interface Plan {
  entries: PlanEntry[];
  // Submodules are never changed, so their paths stay out of the plan.
  submodules: string[];
}

export interface Prepared {
  target: CheckpointInfo;
  snapshot: Snapshot;
  plan: Plan;
  // Files marked assume-unchanged or skip-worktree in the person's index. The snapshot holds
  // their index version, not what is on disk, so their content may not be saved.
  flagged: string[];
  // Paths whose current content is not saved: files left out, untracked files with secret-like
  // names, flagged files, and folders (ending in "/") that hold a repository of their own or a
  // submodule.
  unsaved: Set<string>;
}

export interface RollbackSettings {
  job: JobRef;
  maxFileSizeMb: number;
  approved: string[];
  env: Record<string, string | undefined>;
}

const SUBMODULE_MODE = "160000";
const decoder = new TextDecoder();

// The checkpoint to roll back to: a number, a commit prefix of at least 7 hexadecimal characters
// that matches exactly one checkpoint, or by default the newest checkpoint that was not saved
// before a rollback. `list` is newest first.
export function resolveTarget(list: CheckpointInfo[], argument: string | undefined): CheckpointInfo {
  if (argument === undefined) {
    const target = list.find((checkpoint) => checkpoint.kind !== "pre_rollback");
    if (target === undefined) {
      throw new CommandError(ExitCode.NotPossibleHere, ["This job has no checkpoint to roll back to yet. Save one with relay checkpoint."]);
    }
    return target;
  }
  const isNumber = /^[1-9][0-9]*$/.test(argument);
  const byNumber = isNumber ? list.find((checkpoint) => checkpoint.number === Number(argument)) : undefined;
  if (byNumber !== undefined) return byNumber;
  if (/^[0-9a-fA-F]{7,64}$/.test(argument)) {
    const matches = list.filter((checkpoint) => checkpoint.commit.startsWith(argument.toLowerCase()));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw usage(`${argument} matches more than one checkpoint. Use the checkpoint number.`);
  } else if (!isNumber) {
    throw usage(`relay rollback needs a checkpoint number or a commit prefix of at least 7 hexadecimal characters, not ${quote(argument)}.`);
  }
  throw usage(`Checkpoint ${argument} does not exist. See relay checkpoints.`);
}

// Steps 2 to 4: the current snapshot, the plan, and the paths the plan must not touch. Creates no
// checkpoint and changes no file.
export async function prepareRollback(repo: Repository, settings: RollbackSettings, target: CheckpointInfo): Promise<Prepared> {
  const snapshot = await currentSnapshot(repo, settings);
  const plan = await readPlan(repo, snapshot.tree, target.commit);
  const flagged = await flaggedPaths(repo);
  return { target, snapshot, plan, flagged, unsaved: unsavedPaths(snapshot, plan, flagged) };
}

// The planned paths that hold files relay has not saved, or that stand where the rollback must
// write: a file or link on the way to a planned path, a file that is not in the current snapshot
// where the rollback adds one, and the files inside a folder that stands where a file goes.
export function filesInTheWay(root: string, plan: Plan, unsaved: Set<string>): string[] {
  const deleted = new Set(plan.entries.filter((entry) => entry.action === "delete").map((entry) => entry.path));
  const found = new Set<string>();
  for (const entry of plan.entries) {
    if (unsaved.has(entry.path)) {
      found.add(entry.path);
      continue;
    }
    const way = checkFolders(root, entry, deleted, unsaved);
    if (way === "deleted first") continue;
    if (way !== "clear") {
      found.add(way.blocking);
      continue;
    }
    const stat = lstat(root, entry.raw);
    if (stat?.isDirectory()) {
      for (const file of filesUnder(root, entry.raw)) if (!deleted.has(file)) found.add(file);
    } else if (stat !== undefined && entry.action === "add") {
      found.add(entry.path);
    }
  }
  return [...found].sort();
}

// Checks the folders on the way to the entry's path, from the top. Returns the first one relay
// must not go through: a folder that holds files relay has not saved, or a file or symbolic link
// where a folder should be. The plan may delete such a file or link first ("deleted first"), and
// nothing then stands at the path; but when the entry is itself a deletion, its file is not where
// git saw it.
function checkFolders(
  root: string,
  entry: PlanEntry,
  deleted: Set<string>,
  unsaved: Set<string>,
): "clear" | "deleted first" | { blocking: string } {
  for (const folder of folders(entry.raw)) {
    const name = folder.toString("utf8");
    if (unsaved.has(`${name}/`)) return { blocking: `${name}/` };
    const stat = lstat(root, folder);
    if (stat === undefined) return "clear";
    if (stat.isDirectory()) continue;
    return entry.action === "delete" || !deleted.has(name) ? { blocking: name } : "deleted first";
  }
  return "clear";
}

// Step 7: saves the current files as a pre_rollback checkpoint, or reuses the latest checkpoint
// when nothing but state.json and events.jsonl changed since. The caller holds the job lock.
export async function saveUndoPoint(repo: Repository, settings: RollbackSettings, target: CheckpointInfo): Promise<SaveResult> {
  return await saveCheckpoint(repo, {
    relayHome: settings.job.relayHome,
    command: "rollback",
    kind: "pre_rollback",
    maxFileSizeMb: settings.maxFileSizeMb,
    env: settings.env,
    message: `Before rolling back to checkpoint ${target.number}`,
    lockHeld: true,
    leaveOutSecretLike: true,
  });
}

// Whether the files saved in the undo checkpoint are the ones the plan was made from.
export async function sameFiles(repo: Repository, prepared: Prepared, undo: SaveResult): Promise<boolean> {
  const again = unsavedPaths({ leftOut: undo.leftOut, secretLike: undo.secretLike }, prepared.plan, prepared.flagged);
  const sameUnsaved = again.size === prepared.unsaved.size && [...again].every((path) => prepared.unsaved.has(path));
  return sameUnsaved && (await readPlan(repo, prepared.snapshot.tree, undo.tree)).entries.length === 0;
}

// Steps 8 and 9: deletes the planned files and the folders they leave empty, then writes the
// planned files of the target through a temporary index. The target is read into that index
// first, so a checkpoint git cannot read stops the rollback before any file changes. A file that
// cannot be deleted or written is left as it is and shows in the check that follows.
export async function applyPlan(repo: Repository, job: JobRef, prepared: Prepared): Promise<void> {
  const tmpDir = join(job.relayHome, "tmp");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const index = join(tmpDir, `${job.id}-${randomBytes(4).toString("hex")}.rollback.index`);
  const removeIndex = () => {
    for (const file of [index, `${index}.lock`]) rmSync(file, { force: true });
  };
  const forget = onInterrupt(removeIndex);
  try {
    const read = await git(repo, ["read-tree", prepared.target.commit], { indexFile: index });
    if (read.code !== 0) throw gitFailed(`relay could not read checkpoint ${prepared.target.number}`, read.stderr);
    deletePlanned(repo.worktreeRoot, prepared.plan);
    const writes = prepared.plan.entries.filter((entry) => entry.action !== "delete");
    if (writes.length === 0) return;
    // git writes each file in place of what is there, and never through a symbolic link.
    const input = Buffer.concat(writes.flatMap((entry) => [entry.raw, Buffer.from([0])]));
    await git(repo, ["checkout-index", "-f", "-z", "--stdin"], { indexFile: index, input });
  } finally {
    removeIndex();
    forget();
  }
}

// Deletes each planned file whose folders are all real folders, then the folders that became
// empty, from the file's folder up to the worktree root.
function deletePlanned(root: string, plan: Plan): void {
  for (const entry of plan.entries) {
    if (entry.action !== "delete" || !realFolders(root, entry.raw)) continue;
    try {
      unlinkSync(absolute(root, entry.raw));
    } catch {
      continue;
    }
    for (const folder of folders(entry.raw).reverse()) {
      try {
        rmdirSync(absolute(root, folder));
      } catch {
        break;
      }
    }
  }
}

// Step 10: the paths that still differ from the target, apart from .relay/, submodules and files
// relay has not saved.
export async function checkResult(repo: Repository, settings: RollbackSettings, prepared: Prepared): Promise<string[]> {
  const after = await currentSnapshot(repo, settings);
  const plan = await readPlan(repo, after.tree, prepared.target.commit);
  const ignored = new Set([...prepared.unsaved, ...unsavedPaths(after, plan, prepared.flagged)]);
  return plan.entries.map((entry) => entry.path).filter((path) => !isUnsaved(path, ignored));
}

// Step 11: the rollback event and state.json. Events hold counts and numbers, never file contents.
export async function recordRollback(job: JobRef, prepared: Prepared, undoNumber: number): Promise<void> {
  const deleted = prepared.plan.entries.filter((entry) => entry.action === "delete").length;
  const data = {
    to_checkpoint: prepared.target.number,
    to_commit: prepared.target.commit,
    undo_checkpoint: undoNumber,
    files_written: prepared.plan.entries.length - deleted,
    files_deleted: deleted,
  };
  await appendEvent(job, "rollback", data);
  const relayDir = join(job.worktreeRoot, ".relay");
  const state = readState(relayDir);
  const now = new Date().toISOString();
  writeState(relayDir, { ...state, updated_at: now, last_rollback: { ...data, rolled_back_at: now } });
}

async function currentSnapshot(repo: Repository, settings: RollbackSettings): Promise<Snapshot> {
  return await buildSnapshotTree(repo, {
    jobId: settings.job.id,
    relayHome: settings.job.relayHome,
    maxFileBytes: settings.maxFileSizeMb * 1024 * 1024,
    approved: settings.approved,
  });
}

// What changes from tree `from` to commit or tree `to`, outside .relay/.
async function readPlan(repo: Repository, from: string, to: string): Promise<Plan> {
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to, "--", ".", ":(exclude).relay"]);
  if (result.code !== 0) throw gitFailed("relay could not compare your files with the checkpoint", result.stderr);
  // Each change is ":<old mode> <new mode> <old object> <new object> <status>", then the path.
  const parts = splitNul(Buffer.from(result.stdout));
  const plan: Plan = { entries: [], submodules: [] };
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , , status] = decoder.decode(parts[i]!).slice(1).split(" ");
    const raw = parts[i + 1]!;
    const path = raw.toString("utf8");
    if (!safePath(raw)) {
      throw new CommandError(ExitCode.Failed, [
        `relay refused the path ${quote(path)}, because it leads outside the project or into .git. relay changed nothing.`,
      ]);
    }
    // The pathspec leaves out .relay; this also leaves out .RELAY and the like, which a file
    // system that ignores case treats as the same folder.
    if (path.split("/")[0]!.toLowerCase() === ".relay") continue;
    if (oldMode === SUBMODULE_MODE || newMode === SUBMODULE_MODE) plan.submodules.push(path);
    else plan.entries.push({ action: status === "D" ? "delete" : status === "A" ? "add" : "modify", path, raw });
  }
  return plan;
}

function unsavedPaths(snapshot: Pick<Snapshot, "leftOut" | "secretLike">, plan: Plan, flagged: string[]): Set<string> {
  return new Set([
    ...snapshot.leftOut.map((file) => file.path),
    ...snapshot.secretLike,
    ...flagged,
    ...plan.submodules.map((path) => `${path}/`),
  ]);
}

// The files of the person's index marked assume-unchanged (a lowercase tag in git ls-files -v) or
// skip-worktree (tag S). ls-files only reads the index.
async function flaggedPaths(repo: Repository): Promise<string[]> {
  const result = await git(repo, ["ls-files", "-z", "-v"]);
  if (result.code !== 0) throw gitFailed("relay could not read your index", result.stderr);
  return splitNul(Buffer.from(result.stdout))
    .map((entry) => entry.toString("utf8"))
    .filter((entry) => entry.startsWith("S ") || /^[a-z] /.test(entry))
    .map((entry) => entry.slice(2));
}

function isUnsaved(path: string, unsaved: Set<string>): boolean {
  if (unsaved.has(path)) return true;
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    if (unsaved.has(path.slice(0, end + 1))) return true;
  }
  return false;
}

// A relative path inside the worktree: no empty, "." or ".." part, no leading "/", and no .git.
function safePath(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  return !text.startsWith("/") && text.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

// The folders that lead to a path, from the top: "a" and "a/b" for "a/b/c".
function folders(raw: Buffer): Buffer[] {
  const found: Buffer[] = [];
  for (let end = raw.indexOf(0x2f); end !== -1; end = raw.indexOf(0x2f, end + 1)) found.push(raw.subarray(0, end));
  return found;
}

// Whether every folder that leads to the path is a real folder, not a symbolic link or a file.
function realFolders(root: string, raw: Buffer): boolean {
  return folders(raw).every((folder) => lstat(root, folder)?.isDirectory() === true);
}

// Every file and link inside a folder, without following symbolic links.
function filesUnder(root: string, raw: Buffer): string[] {
  const found: string[] = [];
  for (const name of readdirSync(absolute(root, raw), { encoding: "buffer" })) {
    const path = Buffer.concat([raw, Buffer.from("/"), name]);
    if (lstat(root, path)?.isDirectory()) found.push(...filesUnder(root, path));
    else found.push(path.toString("utf8"));
  }
  return found;
}

function absolute(root: string, raw: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${root}/`), raw]);
}

// Nothing there, also when a file stands where a folder on the way should be.
function lstat(root: string, raw: Buffer): Stats | undefined {
  try {
    return lstatSync(absolute(root, raw), { throwIfNoEntry: false });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOTDIR") return undefined;
    throw error;
  }
}

function splitNul(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let start = 0, end = bytes.indexOf(0); end !== -1; start = end + 1, end = bytes.indexOf(0, start)) {
    parts.push(bytes.subarray(start, end));
  }
  return parts;
}

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line]);
}
