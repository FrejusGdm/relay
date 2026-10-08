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

// One field per placeholder, each ending in a NUL byte. The trailers come as one field of
// "Key: value" lines joined with the unit separator, which a path never holds, and relay picks the
// keys itself: older git, such as 2.39 on macOS, applies the keys of every %(trailers:key=...) atom of a format to
// all of them, so separate atoms per key gave each field the values of all three keys.
const FIELDS = [
  "%(refname)",
  "%(objectname)",
  "%(objecttype)",
  "%(committerdate:unix)",
  "%(contents:subject)",
  "%(trailers:only=true,unfold=true,separator=%x1f)",
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
    const [ref, commit, type, time, subject, trailers] = fields.slice(i, i + FIELDS.length).map((field, n) =>
      n === 0 ? field.replace(/^\n/, "") : field,
    ) as [string, string, string, string, string, string];
    const values = trailerValues(trailers);
    const kind = values("Relay-Kind")[0] ?? "";
    const head = values("Relay-Head")[0] ?? "";
    const leftOut = values("Relay-Left-Out");
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
      leftOut,
    });
  }
  return checkpoints.sort((a, b) => b.number - a.number);
}

// The values of one trailer key, in order, from "Key: value" entries joined with the unit separator.
// Keys are compared without regard to case, as git does.
function trailerValues(trailers: string): (key: string) => string[] {
  const entries = trailers === "" ? [] : trailers.split("\x1f").map((entry) => {
    const colon = entry.indexOf(":");
    return colon === -1 ? null : { key: entry.slice(0, colon).trim().toLowerCase(), value: entry.slice(colon + 1).trim() };
  });
  return (key) => entries.flatMap((entry) => (entry !== null && entry.key === key.toLowerCase() ? [entry.value] : []));
}
