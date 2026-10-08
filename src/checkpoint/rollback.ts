// Rollback (design.md decision 9, the rollback spec): returns the working tree to the files of a
// checkpoint. relay plans the change by comparing a snapshot of the current files with the target,
// refuses when the plan touches a file relay has not saved, saves the current files as the undo
// checkpoint, deletes and writes only the planned paths, and checks the result. It never runs
// git checkout, reset, restore, clean or stash, never moves HEAD or a branch, and never writes an
// index other than its own temporary one. .relay/ is never part of the plan.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { onInterrupt } from "../core/cleanup";
import { printable, quote, shellWord } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { appendEvent, readEvents, type JobRef } from "../job/events";
import { readState, writeState } from "../job/state";
import { gitFailed } from "./commit";
import type { CheckpointInfo } from "./list";
import { saveCheckpoint, type SaveResult } from "./save";
import { buildSnapshotTree, type Snapshot } from "./snapshot";

type Action = "modify" | "add" | "delete";

// Paths are compared as keys: git's bytes as latin1 text, so two names that are not valid UTF-8
// never compare equal. They are decoded as UTF-8 only to be shown.
interface PlanEntry {
  action: Action;
  key: string;
  // git's bytes, used for every file operation.
  raw: Buffer;
  // The mode and object of the path in the current snapshot ("000000" and zeros when it has none).
  oldMode: string;
  oldObject: string;
}

interface Plan {
  entries: PlanEntry[];
  // Submodules are never changed, so their keys stay out of the entries.
  submodules: string[];
}

type Flag = "assume-unchanged" | "skip-worktree";

// A file marked in the person's index, with the mode and object the index holds for it.
interface FlaggedFile {
  flag: Flag;
  mode: string;
  object: string;
}

export interface Prepared {
  target: CheckpointInfo;
  snapshot: Snapshot;
  plan: Plan;
  // Files marked assume-unchanged or skip-worktree in the person's index, by key. A snapshot holds
  // their index version, not what is on disk, so their changes are not saved.
  flagged: Map<string, FlaggedFile>;
  // Keys whose current content is not saved: files left out, untracked files with secret-like
  // names, and folders (ending in "/") that hold a repository of their own or a submodule.
  unsaved: Set<string>;
  // The paths the target checkpoint left out, as its trailers and its event name them. Its tree
  // holds an old version of such a file, or none, so the rollback never changes them.
  targetLeftOut: Set<string>;
}

// Why the plan cannot run, by key.
export interface Problems {
  // Files relay has not saved, or that stand where the rollback writes.
  unsaved: string[];
  // Files whose bytes on disk differ from what git stores for them, because of a line-ending
  // conversion, a clean filter or Git LFS. The undo checkpoint could not give them back exactly.
  converted: string[];
  flagged: Record<Flag, string[]>;
}

export interface RollbackSettings {
  job: JobRef;
  maxFileSizeMb: number;
  approved: string[];
  env: Record<string, string | undefined>;
}

const SUBMODULE_MODE = "160000";
const LINK_MODE = "120000";
const FILE_MODES = new Set(["100644", "100755"]);
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

// Steps 2 to 4: the current snapshot, the plan, and what the plan must not touch. Creates no
// checkpoint and changes no file.
export async function prepareRollback(repo: Repository, settings: RollbackSettings, target: CheckpointInfo): Promise<Prepared> {
  const snapshot = await currentSnapshot(repo, settings);
  const targetLeftOut = leftOutOf(settings.job, target);
  const plan = await readPlan(repo, snapshot.tree, target.commit, targetLeftOut);
  return {
    target,
    snapshot,
    plan,
    flagged: await flaggedFiles(repo),
    unsaved: new Set([...snapshot.unsavedKeys, ...plan.submodules.map((key) => `${key}/`)]),
    targetLeftOut,
  };
}

// Step 4: what stops the plan. relay runs it before it asks, and again just before the first file
// changes. A path the plan adds may not exist yet, unless it is the same file as a path the plan
// deletes (a name that changed only in case, on a file system that ignores case). A file the plan
// changes or deletes must hold exactly the bytes saved for it. A flagged file stops the rollback
// when the plan touches it or when it differs from the index, because relay cannot see its changes.
export function findProblems(root: string, prepared: Prepared): Problems {
  const { plan, unsaved, flagged } = prepared;
  const deleted = new Map(plan.entries.filter((entry) => entry.action === "delete").map((entry) => [entry.key, entry]));
  const problems: Problems = { unsaved: [], converted: [], flagged: { "assume-unchanged": [], "skip-worktree": [] } };
  const reported = new Set<string>();
  const report = (list: string[], key: string) => {
    if (!reported.has(key)) list.push(key);
    reported.add(key);
  };
  for (const entry of plan.entries) {
    const flag = flagged.get(entry.key);
    if (isUnsaved(entry.key, unsaved)) {
      report(problems.unsaved, entry.key);
      continue;
    }
    if (flag !== undefined) {
      report(problems.flagged[flag.flag], entry.key);
      continue;
    }
    const way = checkFolders(root, entry, deleted, unsaved);
    if (way === "deleted first") continue;
    if (way !== "clear") {
      report(problems.unsaved, way.blocking);
      continue;
    }
    const stat = lstat(root, entry.raw);
    if (stat === undefined) continue;
    if (stat.isDirectory()) {
      for (const key of filesUnder(root, entry.raw)) if (!deleted.has(key)) report(problems.unsaved, key);
    } else if (entry.action === "add") {
      if (!sameFileAsDeleted(root, entry, stat, deleted)) report(problems.unsaved, entry.key);
    } else if (FILE_MODES.has(entry.oldMode) && stat.isFile() && blobId(readFileSync(absolute(root, entry.raw)), entry.oldObject) !== entry.oldObject) {
      report(problems.converted, entry.key);
    }
  }
  for (const [key, file] of flagged) {
    // relay never writes .relay/, so a flagged job file there cannot be overwritten.
    if (key.split("/")[0]!.toLowerCase() === ".relay") continue;
    if (!reported.has(key) && differsFromIndex(root, key, file)) report(problems.flagged[file.flag], key);
  }
  return problems;
}

export function hasProblems(problems: Problems): boolean {
  return problems.unsaved.length + problems.converted.length + problems.flagged["assume-unchanged"].length +
    problems.flagged["skip-worktree"].length > 0;
}

// The exit-code-8 message: one sentence for each kind of problem.
export function problemLines(problems: Problems): string[] {
  const list = (keys: string[]) => [...keys].sort().map(show).join(", ");
  const lines: string[] = [];
  if (problems.unsaved.length > 0) {
    lines.push(`Rolling back would overwrite files relay has not saved: ${list(problems.unsaved)}. Move them or delete them yourself, then try again.`);
  }
  if (problems.converted.length > 0) {
    lines.push(
      `Rolling back would overwrite files whose exact bytes relay cannot save, because git changes them when it stores them (line endings, a clean filter or Git LFS): ${list(problems.converted)}. Move them or delete them yourself, then try again.`,
    );
  }
  for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
    const keys = [...problems.flagged[flag]].sort();
    if (keys.length === 0) continue;
    const words = keys.map((key) => shellWord(Buffer.from(key, "latin1").toString("utf8"))).join(" ");
    lines.push(
      `relay cannot roll back files marked ${flag} in your index, because git does not show their changes: ${list(keys)}. Clear the flag with git update-index --no-${flag} -- ${words}, then try again.`,
    );
  }
  return lines;
}

// Checks the folders on the way to the entry's path, from the top. Returns the first one relay
// must not go through: a folder that holds files relay has not saved, or a file or symbolic link
// where a folder should be. The plan may delete such a file or link first ("deleted first"), and
// nothing then stands at the path; but when the entry is itself a deletion, its file is not where
// git saw it.
function checkFolders(
  root: string,
  entry: PlanEntry,
  deleted: Map<string, PlanEntry>,
  unsaved: Set<string>,
): "clear" | "deleted first" | { blocking: string } {
  for (const folder of folders(entry.raw)) {
    const key = folder.toString("latin1");
    if (unsaved.has(`${key}/`)) return { blocking: `${key}/` };
    const stat = lstat(root, folder);
    if (stat === undefined) return "clear";
    if (stat.isDirectory()) continue;
    return entry.action === "delete" || !deleted.has(key) ? { blocking: key } : "deleted first";
  }
  return "clear";
}

// Whether the file at a path the plan adds is a file the plan deletes under a name that differs
// only in case, which a file system that ignores case shows under both names.
function sameFileAsDeleted(root: string, entry: PlanEntry, stat: Stats, deleted: Map<string, PlanEntry>): boolean {
  for (const [key, other] of deleted) {
    if (key.toLowerCase() !== entry.key.toLowerCase()) continue;
    const otherStat = lstat(root, other.raw);
    if (otherStat !== undefined && otherStat.dev === stat.dev && otherStat.ino === stat.ino) return true;
  }
  return false;
}

// Whether a flagged file on disk differs from the version the index holds. A file that is not on
// disk, as in a sparse checkout, does not count.
function differsFromIndex(root: string, key: string, file: FlaggedFile): boolean {
  const raw = Buffer.from(key, "latin1");
  const stat = lstat(root, raw);
  if (stat === undefined) return false;
  if (file.mode === LINK_MODE) return !stat.isSymbolicLink() || blobId(readlinkSync(absolute(root, raw), { encoding: "buffer" }), file.object) !== file.object;
  if (!FILE_MODES.has(file.mode) || !stat.isFile()) return true;
  return blobId(readFileSync(absolute(root, raw)), file.object) !== file.object;
}

// The object name git gives these bytes as a blob, without filters, with the hash of `like` (40
// hexadecimal characters for SHA-1, 64 for SHA-256).
function blobId(bytes: Buffer, like: string): string {
  return createHash(like.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
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
  const before = new Set(prepared.snapshot.unsavedKeys);
  const sameUnsaved = undo.unsavedKeys.length === before.size && undo.unsavedKeys.every((key) => before.has(key));
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

// Step 10: the paths that still differ from the target, apart from .relay/, submodules, files
// relay has not saved, files the target left out, and files that were there before but not in the
// snapshot, such as files that were ignored before the rollback restored an older .gitignore.
export async function checkResult(repo: Repository, settings: RollbackSettings, prepared: Prepared): Promise<string[]> {
  const after = await currentSnapshot(repo, settings);
  const plan = await readPlan(repo, after.tree, prepared.target.commit, prepared.targetLeftOut);
  const planned = new Set(prepared.plan.entries.map((entry) => entry.key));
  const appeared = (await readPlan(repo, prepared.snapshot.tree, after.tree)).entries
    .filter((entry) => entry.action === "add" && !planned.has(entry.key))
    .map((entry) => entry.key);
  const ignored = new Set([
    ...prepared.unsaved,
    ...after.unsavedKeys,
    ...prepared.flagged.keys(),
    ...plan.submodules.map((key) => `${key}/`),
    ...appeared,
  ]);
  return plan.entries.filter((entry) => !isUnsaved(entry.key, ignored)).map((entry) => show(entry.key));
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

// What changes from tree `from` to commit or tree `to`, outside .relay/ and apart from the paths
// in `leftOut`.
async function readPlan(repo: Repository, from: string, to: string, leftOut = new Set<string>()): Promise<Plan> {
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to, "--", ".", ":(exclude).relay"]);
  if (result.code !== 0) throw gitFailed("relay could not compare your files with the checkpoint", result.stderr);
  // Each change is ":<old mode> <new mode> <old object> <new object> <status>", then the path.
  const parts = splitNul(Buffer.from(result.stdout));
  const plan: Plan = { entries: [], submodules: [] };
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldObject, , status] = decoder.decode(parts[i]!).slice(1).split(" ") as [string, string, string, string, string];
    const raw = parts[i + 1]!;
    const key = raw.toString("latin1");
    if (!safePath(raw)) {
      throw new CommandError(ExitCode.Failed, [
        `relay refused the path ${quote(show(key))}, because it leads outside the project or into .git. relay changed nothing.`,
      ]);
    }
    // The pathspec leaves out .relay; this also leaves out .RELAY and the like, which a file
    // system that ignores case treats as the same folder.
    if (key.split("/")[0]!.toLowerCase() === ".relay" || isLeftOut(key, leftOut)) continue;
    if (oldMode === SUBMODULE_MODE || newMode === SUBMODULE_MODE) plan.submodules.push(key);
    else plan.entries.push({ action: status === "D" ? "delete" : status === "A" ? "add" : "modify", key, raw, oldMode, oldObject });
  }
  return plan;
}

// The paths the target checkpoint left out: its Relay-Left-Out trailers, which stop after 50, and
// the left_out list of its checkpoint_saved event, which is complete.
function leftOutOf(job: JobRef, target: CheckpointInfo): Set<string> {
  const paths = new Set(target.leftOut);
  let events: ReturnType<typeof readEvents> = [];
  try {
    events = readEvents(job);
  } catch {
    // Without a readable event log, the trailers are all relay knows.
  }
  for (const event of events) {
    const { number, commit, left_out } = event.data;
    if (event.type !== "checkpoint_saved" || number !== target.number || commit !== target.commit || !Array.isArray(left_out)) continue;
    for (const path of left_out) if (typeof path === "string") paths.add(path);
  }
  return paths;
}

// Whether a key is a path in `leftOut` or lies in a folder there. The trailers write paths as
// printable text, the event as plain text.
function isLeftOut(key: string, leftOut: Set<string>): boolean {
  if (leftOut.size === 0) return false;
  const text = Buffer.from(key, "latin1").toString("utf8");
  const names = [text, ...[...text.matchAll(/\//g)].map((match) => text.slice(0, match.index + 1))];
  return names.some((name) => leftOut.has(name) || leftOut.has(printable(name)));
}

// The files of the person's index marked assume-unchanged (a lowercase tag in git ls-files -v) or
// skip-worktree (tag S or s), with the mode and object the index holds. ls-files only reads the
// index. Each entry is "<tag> <mode> <object> <stage>\t<path>".
async function flaggedFiles(repo: Repository): Promise<Map<string, FlaggedFile>> {
  const result = await git(repo, ["ls-files", "-z", "-v", "-s"]);
  if (result.code !== 0) throw gitFailed("relay could not read your index", result.stderr);
  const flagged = new Map<string, FlaggedFile>();
  for (const entry of splitNul(Buffer.from(result.stdout))) {
    const tab = entry.indexOf(0x09);
    const [tag, mode, object] = entry.subarray(0, tab).toString("latin1").split(" ") as [string, string, string];
    if (tag !== "S" && tag !== "s" && !/^[a-z]$/.test(tag)) continue;
    flagged.set(entry.subarray(tab + 1).toString("latin1"), { flag: tag.toLowerCase() === "s" ? "skip-worktree" : "assume-unchanged", mode, object });
  }
  return flagged;
}

function isUnsaved(key: string, unsaved: Set<string>): boolean {
  if (unsaved.has(key)) return true;
  for (let end = key.indexOf("/"); end !== -1; end = key.indexOf("/", end + 1)) {
    if (unsaved.has(key.slice(0, end + 1))) return true;
  }
  return false;
}

// A key as the person reads it.
function show(key: string): string {
  return printable(Buffer.from(key, "latin1").toString("utf8"));
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

// The keys of every file and link inside a folder, without following symbolic links.
function filesUnder(root: string, raw: Buffer): string[] {
  const found: string[] = [];
  for (const name of readdirSync(absolute(root, raw), { encoding: "buffer" })) {
    const path = Buffer.concat([raw, Buffer.from("/"), name]);
    if (lstat(root, path)?.isDirectory()) found.push(...filesUnder(root, path));
    else found.push(path.toString("latin1"));
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
