// saveCheckpoint(): the one function that saves a checkpoint (design.md section 14). relay init,
// relay checkpoint and, in later changes, relay rollback and relay switch call it. It works in this
// order: read state.json, compare the git trust record, take the job lock, build the snapshot
// tree, stop on unapproved secret-like file names, compare with the latest checkpoint, scan for
// secrets, commit, write the refs, then append the event and update state.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { printable, shellWord } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { changedFiles, compareTrust, TrustRecordError, trustReport } from "../git/trust";
import { appendEvent, type JobRef } from "../job/events";
import { takeJobLock } from "../job/lock";
import { readState, StateFileError, writeState, type JobState } from "../job/state";
import { scanCheckpoint } from "../secrets/scan";
import { cleanMessage, commitCheckpoint, gitFailed, readJobRefs, type CheckpointKind } from "./commit";
import { buildSnapshotTree, type LeftOutFile } from "./snapshot";

export interface SaveOptions {
  relayHome: string;
  // The command that saves, for the job lock and the checkpoint_refused event.
  command: "init" | "checkpoint" | "rollback" | "switch" | "run";
  // The first checkpoint of a job is always saved as baseline, whatever kind is asked for.
  kind: CheckpointKind;
  maxFileSizeMb: number;
  // The command's environment, which names RELAY_GITLEAKS for the scan.
  env: Record<string, string | undefined>;
  message?: string;
  // Paths, relative to the worktree root, of untracked files with secret-like names that the
  // person approves (--include). They are added to approved_paths when the checkpoint is saved.
  include?: string[];
  trailers?: [string, string][];
  // The caller already holds the job lock.
  lockHeld?: boolean;
  // Untracked files with secret-like names that the person has not approved are left out instead
  // of stopping the checkpoint. relay rollback uses it, and never changes those files.
  leaveOutSecretLike?: boolean;
}

// What the second line of the output compares with.
export type Compared = { with: "checkpoint"; number: number } | { with: "commit"; commit: string } | { with: "nothing" };

export type SaveResult =
  | {
      saved: true;
      number: number;
      commit: string;
      ref: string;
      kind: CheckpointKind;
      filesChanged: number;
      compared: Compared;
      leftOut: LeftOutFile[];
      // Approved untracked files saved for the first time.
      included: string[];
      tree: string;
      secretLike: string[];
      unsavedKeys: string[];
    }
  // Nothing changed; files left out are still reported, since a new one is not saved.
  | { saved: false; latest: number; leftOut: LeftOutFile[]; tree: string; secretLike: string[]; unsavedKeys: string[] };

// These two files change after every checkpoint, so they alone never make a new one.
const ALWAYS_CHANGING = new Set([".relay/state.json", ".relay/events.jsonl"]);
const SHOWN_FINDINGS = 20;
const decoder = new TextDecoder();

export async function saveCheckpoint(repo: Repository, options: SaveOptions): Promise<SaveResult> {
  const relayDir = join(repo.worktreeRoot, ".relay");
  const { job } = await openJob(repo, options.relayHome, options.command);
  const jobId = job.id;

  const release = options.lockHeld ? () => {} : takeJobLock(options.relayHome, jobId, options.command);
  try {
    // Read again under the lock, so approvals and the latest checkpoint are current.
    const state = readJobState(relayDir);
    const refs = await readJobRefs(repo, jobId);
    const include = options.include ?? [];
    const snapshot = await buildSnapshotTree(repo, {
      jobId,
      relayHome: options.relayHome,
      maxFileBytes: options.maxFileSizeMb * 1024 * 1024,
      approved: [...state.approved_paths, ...include],
    });

    if (snapshot.secretLike.length > 0 && options.leaveOutSecretLike !== true) {
      await appendEvent(job, "checkpoint_refused", { command: options.command, reason: "secret_like_file", files: snapshot.secretLike });
      throw new CommandError(ExitCode.SecretFound, snapshot.secretLike.flatMap((path) => [
        `Stopped: ${printable(path)} is not ignored by git and may hold secrets.`,
        `Add it to .gitignore, or include it with: relay checkpoint --include ${shellWord(path)}`,
      ]));
    }

    const latestTree = refs.latest === null ? null : await treeOf(repo, refs.latest);
    const parentTree = latestTree ?? (repo.head.sha === null ? null : await treeOf(repo, repo.head.sha));
    let compared: Compared;
    let changed: string[];
    if (refs.latest !== null) {
      compared = { with: "checkpoint", number: refs.highest };
      changed = (await changedPaths(repo, latestTree, snapshot.tree)).filter((path) => !ALWAYS_CHANGING.has(path));
      if (changed.length === 0) {
        const { tree, secretLike, unsavedKeys } = snapshot;
        return { saved: false, latest: refs.highest, leftOut: snapshot.leftOut, tree, secretLike, unsavedKeys };
      }
    } else {
      // The job files are new to the person's commit, so only the person's files are counted.
      compared = repo.head.sha === null ? { with: "nothing" } : { with: "commit", commit: repo.head.sha };
      changed = (await changedPaths(repo, parentTree, snapshot.tree)).filter((path) => !path.startsWith(".relay/"));
    }

    const message = cleanMessage(options.message);
    const findings = await scanCheckpoint(repo, { jobId, parentTree, newTree: snapshot.tree, message: message ?? undefined, env: options.env });
    if (findings.length > 0) {
      await appendEvent(job, "checkpoint_refused", { command: options.command, reason: "secret_found", findings });
      const lines = findings
        .slice(0, SHOWN_FINDINGS)
        .map((finding) => `Stopped: possible secret in ${printable(finding.path)} line ${finding.line} (${printable(finding.rule)}).`);
      if (findings.length > SHOWN_FINDINGS) lines.push(`and ${findings.length - SHOWN_FINDINGS} more`);
      lines.push("Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.");
      throw new CommandError(ExitCode.SecretFound, lines);
    }

    const kind: CheckpointKind = refs.latest === null ? "baseline" : options.kind;
    const leftOut = [
      ...snapshot.leftOut.map((file) => file.path),
      ...(options.leaveOutSecretLike === true ? snapshot.secretLike : []),
    ];
    const saved = await commitCheckpoint(
      repo,
      { jobId, tree: snapshot.tree, kind, message, leftOut, trailers: options.trailers ?? [] },
      refs,
    );

    const createdAt = new Date().toISOString();
    await appendEvent(job, "checkpoint_saved", {
      number: saved.number,
      commit: saved.commit,
      kind,
      message,
      parent: saved.parent,
      head: repo.head.sha,
      branch: repo.head.branch,
      files_changed: changed.length,
      left_out: leftOut,
    });
    // Only paths that named an approved file saved in this checkpoint are kept.
    const included = [...new Set(include)].filter(
      (path) => snapshot.approvedSecretLike.includes(path) && !state.approved_paths.includes(path),
    );
    writeState(relayDir, {
      ...state,
      updated_at: createdAt,
      latest_checkpoint: { number: saved.number, commit: saved.commit, ref: saved.ref, kind, created_at: createdAt },
      checkpoint_count: (await readJobRefs(repo, jobId)).count,
      approved_paths: [...state.approved_paths, ...included],
    });
    return {
      saved: true,
      number: saved.number,
      commit: saved.commit,
      ref: saved.ref,
      kind,
      filesChanged: changed.length,
      compared,
      leftOut: snapshot.leftOut,
      included,
      tree: snapshot.tree,
      secretLike: snapshot.secretLike,
      unsavedKeys: snapshot.unsavedKeys,
    };
  } finally {
    release();
  }
}

// Reads state.json, checks that its job was set up in this checkout, and compares the git trust
// record, before any git command other than rev-parse and config runs. `command` names the
// command in the checkpoint_refused event of a refusal; relay checkpoints passes null, because
// listing appends no event.
export async function openJob(
  repo: Repository,
  relayHome: string,
  command: SaveOptions["command"] | null,
): Promise<{ state: JobState; job: JobRef }> {
  const found = findJob(repo, relayHome);
  await checkTrust(repo, found.job, command);
  return found;
}

// Reads state.json and checks that its job was set up in this checkout, without the trust check.
// relay accept-git-changes uses it, because it shows what the trust check would refuse.
export function findJob(repo: Repository, relayHome: string): { state: JobState; job: JobRef } {
  const state = readJobState(join(repo.worktreeRoot, ".relay"));
  return { state, job: { id: checkJobBelongsHere(repo, state, relayHome), worktreeRoot: repo.worktreeRoot, relayHome } };
}

// The job named in state.json must be the one relay init set up in this checkout: the job ID is
// not trusted alone, because another checkout's job ID would make relay write that job's refs.
// Returns the job ID.
function checkJobBelongsHere(repo: Repository, state: JobState, relayHome: string): string {
  let belongs = state.repository.worktree_root === repo.worktreeRoot;
  let record: { job_id?: unknown; worktree_root?: unknown } | undefined;
  try {
    record = JSON.parse(readFileSync(join(relayHome, "jobs", state.job_id, "git-trust.json"), "utf8"));
  } catch {
    // A missing or damaged trust record is reported by the trust check that follows.
  }
  if (record !== undefined) belongs &&= record.job_id === state.job_id && record.worktree_root === repo.worktreeRoot;
  if (!belongs) {
    throw new CommandError(ExitCode.NotPossibleHere, [
      `.relay/state.json names job ${state.job_id}, which relay init did not set up in this checkout. relay changed nothing.`,
    ]);
  }
  return state.job_id;
}

function readJobState(relayDir: string): JobState {
  try {
    return readState(relayDir);
  } catch (error) {
    if (!(error instanceof StateFileError)) throw error;
    if (error.problem === null) throw new CommandError(ExitCode.NotPossibleHere, ["relay is not set up here. Run relay init first."]);
    throw new CommandError(ExitCode.NotPossibleHere, [`.relay/state.json is damaged: ${error.problem}. relay changed nothing.`]);
  }
}

// Stops with exit code 5 when the git settings or hooks changed since relay init.
async function checkTrust(repo: Repository, job: JobRef, command: SaveOptions["command"] | null): Promise<void> {
  let changes;
  try {
    changes = await compareTrust(repo, join(job.relayHome, "jobs", job.id));
  } catch (error) {
    if (error instanceof TrustRecordError) throw new CommandError(ExitCode.GitChanged, [printable(error.message)]);
    throw error;
  }
  if (changes.length === 0) return;
  if (command !== null) await appendEvent(job, "checkpoint_refused", { command, reason: "git_changed", changed: changedFiles(changes) });
  throw new CommandError(ExitCode.GitChanged, trustReport(changes, repo));
}

async function treeOf(repo: Repository, commit: string): Promise<string> {
  const result = await git(repo, ["rev-parse", "--verify", `${commit}^{tree}`]);
  if (result.code !== 0) throw gitFailed(`relay could not read commit ${commit}`, result.stderr);
  return decoder.decode(result.stdout).trim();
}

// The paths that differ between two trees; `from` null means the empty tree.
async function changedPaths(repo: Repository, from: string | null, to: string): Promise<string[]> {
  const base = from ?? decoder.decode((await git(repo, ["hash-object", "-t", "tree", "/dev/null"])).stdout).trim();
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", base, to]);
  if (result.code !== 0) throw gitFailed("relay could not compare checkpoints", result.stderr);
  return decoder.decode(result.stdout).split("\0").filter((path) => path !== "");
}
