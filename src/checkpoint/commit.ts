// The checkpoint commit and its refs (design.md decisions 2 and 4). The commit is made with
// commit-tree and never signed, and both refs are written in one update-ref transaction that fails
// when the checkpoint number is already taken, so a checkpoint ref is never overwritten.
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { wasInterrupted } from "../core/cleanup";
import { printable } from "../core/quote";
import { VERSION } from "../core/version";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { isJobId } from "../job/id";
import { removeInvisible } from "../text/invisible";

export type CheckpointKind = "baseline" | "manual" | "pre_rollback" | "handoff" | "auto";

export interface JobRefs {
  // The highest checkpoint number, 0 when there is none, and how many checkpoint refs exist.
  highest: number;
  count: number;
  latest: string | null;
}

export interface CommitInput {
  jobId: string;
  tree: string;
  kind: CheckpointKind;
  message: string | null;
  leftOut: string[];
  // Extra trailers from the caller, such as ["Relay-Worker", "5d2e8f01"].
  trailers: [string, string][];
}

export interface SavedCommit {
  number: number;
  commit: string;
  ref: string;
  parent: string | null;
}

const MESSAGE_LIMIT = 200;
const LEFT_OUT_TRAILERS = 50;
const decoder = new TextDecoder();

export function jobPrefix(jobId: string): string {
  if (!isJobId(jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(jobId)} in a ref.`);
  return `refs/relay/jobs/${jobId}/`;
}

// The checkpoint numbers and the latest checkpoint of a job, from one for-each-ref call.
export async function readJobRefs(repo: Repository, jobId: string): Promise<JobRefs> {
  const prefix = jobPrefix(jobId);
  const result = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  if (result.code !== 0) throw gitFailed(`relay could not read the checkpoints of job ${jobId}`, result.stderr);
  const refs: JobRefs = { highest: 0, count: 0, latest: null };
  for (const line of decoder.decode(result.stdout).split("\n")) {
    const [name, sha] = line.split(" ");
    if (name === `${prefix}latest`) refs.latest = sha ?? null;
    const number = /^checkpoints\/([1-9][0-9]*)$/.exec(name?.slice(prefix.length) ?? "")?.[1];
    if (number !== undefined) {
      refs.count++;
      refs.highest = Math.max(refs.highest, Number(number));
    }
  }
  return refs;
}

// One line of at most 200 characters: newlines and tabs become spaces, and other control
// characters and invisible characters are removed. Returns null when nothing is left.
export function cleanMessage(text: string | undefined): string | null {
  if (text === undefined) return null;
  const oneLine = text.replace(/\r\n|[\r\n\t]/g, " ").replace(/\p{Cc}/gu, "");
  const cleaned = removeInvisible(oneLine).text.trim();
  return cleaned === "" ? null : Array.from(cleaned).slice(0, MESSAGE_LIMIT).join("");
}

// Creates the commit and records it as the next checkpoint and as latest. When another command
// recorded a checkpoint in the meantime, relay reads the refs again and tries once more.
export async function commitCheckpoint(repo: Repository, input: CommitInput, refs: JobRefs): Promise<SavedCommit> {
  const prefix = jobPrefix(input.jobId);
  const identity = await readIdentity(repo);
  for (let attempt = 0; attempt < 2; attempt++) {
    const number = refs.highest + 1;
    const parent = refs.latest ?? repo.head.sha;
    const message = commitMessage(repo, input, number);
    const made = await git(repo, ["commit-tree", "--no-gpg-sign", ...(parent === null ? [] : ["-p", parent]), input.tree], {
      input: message,
      identity,
    });
    if (made.code !== 0) throw gitFailed("relay could not create the checkpoint commit", made.stderr);
    const commit = decoder.decode(made.stdout).trim();
    const ref = `${prefix}checkpoints/${number}`;
    const latest = refs.latest === null ? `create ${prefix}latest ${commit}` : `update ${prefix}latest ${commit} ${refs.latest}`;
    const written = await git(repo, ["update-ref", "--stdin"], {
      input: ["start", `create ${ref} ${commit}`, latest, "prepare", "commit", ""].join("\n"),
    });
    if (written.code === 0) return { number, commit, ref, parent };
    const now = await readJobRefs(repo, input.jobId);
    if (now.highest === refs.highest && now.latest === refs.latest) {
      throw gitFailed("relay could not record the checkpoint", written.stderr);
    }
    refs = now;
  }
  throw new CommandError(ExitCode.Busy, ["Another relay command is saving a checkpoint for this job. Try again."]);
}

function commitMessage(repo: Repository, input: CommitInput, number: number): string {
  const subject = input.message === null ? `relay checkpoint ${number}` : `relay checkpoint ${number}: ${input.message}`;
  // Trailer values stay on one line: control characters are written as \u escapes.
  const leftOut = input.leftOut.map(printable);
  if (leftOut.length > LEFT_OUT_TRAILERS) {
    leftOut.splice(LEFT_OUT_TRAILERS - 1, Infinity, `and ${input.leftOut.length - (LEFT_OUT_TRAILERS - 1)} more`);
  }
  const trailers: [string, string][] = [
    ["Relay-Job", input.jobId],
    ["Relay-Checkpoint", String(number)],
    ["Relay-Kind", input.kind],
    ["Relay-Head", repo.head.sha ?? "none"],
    ["Relay-Branch", repo.head.branch === null ? "(detached)" : printable(repo.head.branch)],
    ...leftOut.map((path): [string, string] => ["Relay-Left-Out", path]),
    ...input.trailers.map(([key, value]): [string, string] => {
      if (!/^Relay-[A-Za-z][A-Za-z-]*$/.test(key)) throw new Error(`relay refused the trailer name ${JSON.stringify(key)}.`);
      return [key, printable(value)];
    }),
    ["Relay-Version", VERSION],
  ];
  return `${subject}\n\n${trailers.map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
}

// The person's user.name and user.email, or relay and relay@localhost when either is missing.
async function readIdentity(repo: Repository): Promise<{ name: string; email: string }> {
  const read = async (key: string, fallback: string) => {
    const result = await git(repo, ["config", "--get", key]);
    const value = result.code === 0 ? decoder.decode(result.stdout).trim() : "";
    return value === "" ? fallback : value;
  };
  return { name: await read("user.name", "relay"), email: await read("user.email", "relay@localhost") };
}

// A git command that failed: `what`, then each line of git's message on a line of its own. When a
// signal stopped relay, git failed because relay stopped it, and the message says so instead.
export function gitFailed(what: string, stderr: string): CommandError {
  if (wasInterrupted()) return new CommandError(ExitCode.Interrupted, ["relay was stopped before it finished. Nothing was saved."]);
  const lines = stderr.trim().split("\n").filter((line) => line.trim() !== "");
  return new CommandError(ExitCode.Failed, [`${what}.`, ...lines.map((line) => `  ${printable(line.trimEnd())}`)]);
}
