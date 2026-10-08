// The record of a handoff in git (add-relay-switch, design decision 13): a commit whose parent is
// the work checkpoint and whose tree is the checkpoint's tree with the new .relay/checkpoint.md,
// .relay/state.json and .relay/events.jsonl and without .relay/verify.md, under
// refs/relay/jobs/<job>/handoffs/<n>. It is built with a temporary index, never the person's, and
// it is not a checkpoint, so relay checkpoints and relay rollback do not see it.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitFailed, jobPrefix, readIdentity } from "../checkpoint/commit";
import { onInterrupt } from "../core/cleanup";
import { VERSION } from "../core/version";
import type { Repository } from "../git/repo";
import { git } from "../git/run";

interface HandoffCommitInput {
  jobId: string;
  relayHome: string;
  number: number;
  workCheckpoint: { number: number; commit: string };
  from: string | null;
  to: string;
  notesSource: "agent" | "relay";
  // Relay-Tests: the check results joined with "; ", or "none".
  tests: string;
  files: { checkpointMd: string; stateJson: string; eventsJsonl: string };
}

const decoder = new TextDecoder();

export function handoffRef(jobId: string, number: number): string {
  return `${jobPrefix(jobId)}handoffs/${number}`;
}

export async function recordHandoff(repo: Repository, input: HandoffCommitInput): Promise<{ ref: string; commit: string }> {
  const run = async (args: string[], options: { input?: string; indexFile?: string } = {}) => {
    const result = await git(repo, args, options);
    if (result.code !== 0) throw gitFailed("relay could not record the handoff", result.stderr);
    return decoder.decode(result.stdout).trim();
  };
  const blobs = {
    "checkpoint.md": await run(["hash-object", "-w", "--no-filters", "--stdin"], { input: input.files.checkpointMd }),
    "state.json": await run(["hash-object", "-w", "--no-filters", "--stdin"], { input: input.files.stateJson }),
    "events.jsonl": await run(["hash-object", "-w", "--no-filters", "--stdin"], { input: input.files.eventsJsonl }),
  };
  const tmp = join(input.relayHome, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const indexFile = join(tmp, `${input.jobId}-${randomBytes(4).toString("hex")}.index`);
  const removeIndex = () => {
    for (const file of [indexFile, `${indexFile}.lock`]) rmSync(file, { force: true });
  };
  const forget = onInterrupt(removeIndex);
  let tree: string;
  try {
    await run(["read-tree", input.workCheckpoint.commit], { indexFile });
    for (const [name, blob] of Object.entries(blobs)) {
      await run(["update-index", "--add", "--cacheinfo", `100644,${blob},.relay/${name}`], { indexFile });
    }
    await run(["update-index", "--force-remove", ".relay/verify.md"], { indexFile });
    tree = await run(["write-tree"], { indexFile });
  } finally {
    removeIndex();
    forget();
  }
  const trailers = [
    ["Relay-Job", input.jobId],
    ["Relay-Handoff", String(input.number)],
    ["Relay-Checkpoint", String(input.workCheckpoint.number)],
    ["Relay-From", input.from ?? "none"],
    ["Relay-To", input.to],
    ["Relay-Notes", input.notesSource],
    ["Relay-Tests", input.tests.replace(/[\r\n]+/g, " ")],
    ["Relay-Version", VERSION],
  ];
  const message = `relay handoff ${input.number}: ${input.from ?? "no agent"} to ${input.to}\n\n${trailers.map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
  const made = await git(repo, ["commit-tree", "--no-gpg-sign", "-p", input.workCheckpoint.commit, tree], { input: message, identity: await readIdentity(repo) });
  if (made.code !== 0) throw gitFailed("relay could not record the handoff", made.stderr);
  const commit = decoder.decode(made.stdout).trim();
  const ref = handoffRef(input.jobId, input.number);
  await run(["update-ref", "--stdin"], { input: ["start", `create ${ref} ${commit}`, "prepare", "commit", ""].join("\n") });
  return { ref, commit };
}

// Deletes the ref of a handoff that was not finished, when it still points to `commit`.
export async function deleteHandoffRef(repo: Repository, ref: string, commit: string): Promise<void> {
  const result = await git(repo, ["update-ref", "--stdin"], { input: ["start", `delete ${ref} ${commit}`, "prepare", "commit", ""].join("\n") });
  if (result.code !== 0) throw gitFailed("relay could not delete the unfinished handoff", result.stderr);
}
