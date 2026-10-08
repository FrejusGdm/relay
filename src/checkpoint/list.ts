// Reading a job's checkpoints from its refs, with one git for-each-ref call (the checkpoints spec,
// "Listing checkpoints"). relay checkpoints prints them, and relay rollback finds its target here.
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { gitFailed, jobPrefix } from "./commit";

export interface CheckpointInfo {
  number: number;
  commit: string;
  ref: string;
  // The Relay-Kind trailer: baseline, manual, pre_rollback, handoff or auto.
  kind: string;
  // The message given with -m, or null.
  message: string | null;
  createdAt: Date;
  // The Relay-Head trailer: the commit HEAD pointed to, or null in a repository without commits.
  head: string | null;
  leftOut: string[];
}

// One field per placeholder, each ending in a NUL byte. Several Relay-Left-Out trailers are
// joined with the unit separator, which a path never holds.
const FIELDS = [
  "%(refname)",
  "%(objectname)",
  "%(objecttype)",
  "%(committerdate:unix)",
  "%(contents:subject)",
  ...["Relay-Kind", "Relay-Head", "Relay-Left-Out"].map((key) => `%(trailers:key=${key},valueonly=true,unfold=true,separator=%x1f)`),
];
const decoder = new TextDecoder();

// The job's checkpoints, newest first. A ref that does not point to a commit is skipped.
export async function listCheckpoints(repo: Repository, jobId: string): Promise<CheckpointInfo[]> {
  const prefix = `${jobPrefix(jobId)}checkpoints/`;
  const result = await git(repo, ["for-each-ref", `--format=${FIELDS.map((field) => `${field}%00`).join("")}`, prefix]);
  if (result.code !== 0) throw gitFailed(`relay could not read the checkpoints of job ${jobId}`, result.stderr);
  // for-each-ref ends each ref with a newline, which starts the next ref's first field.
  const fields = decoder.decode(result.stdout).split("\0");
  const checkpoints: CheckpointInfo[] = [];
  for (let i = 0; i + FIELDS.length <= fields.length; i += FIELDS.length) {
    const [ref, commit, type, time, subject, kind, head, leftOut] = fields.slice(i, i + FIELDS.length).map((field, n) =>
      n === 0 ? field.replace(/^\n/, "") : field,
    ) as [string, string, string, string, string, string, string, string];
    const number = /^[1-9][0-9]*$/.test(ref.slice(prefix.length)) ? Number(ref.slice(prefix.length)) : null;
    if (number === null || type !== "commit") continue;
    const message = new RegExp(`^relay checkpoint ${number}: (.+)$`).exec(subject)?.[1] ?? null;
    checkpoints.push({
      number,
      commit,
      ref,
      kind,
      message,
      createdAt: new Date(Number(time) * 1000),
      head: head === "" || head === "none" ? null : head,
      leftOut: leftOut === "" ? [] : leftOut.split("\x1f"),
    });
  }
  return checkpoints.sort((a, b) => b.number - a.number);
}
