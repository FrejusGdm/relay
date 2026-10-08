// Per-step snapshots of a baseline run (add-handoff-evaluation design decision 6). Each one is a
// commit under refs/relay-eval/steps/<n>, built with a temporary index like relay's checkpoints, so
// the scratch repository's HEAD, branch and index never change.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "./git.ts";

export async function snapshotStep(repo: string, indexPath: string, step: number, parent: string): Promise<string> {
  mkdirSync(dirname(indexPath), { recursive: true });
  const env = { GIT_INDEX_FILE: indexPath };
  await git(repo, ["add", "-A"], { env });
  const tree = (await git(repo, ["write-tree"], { env })).stdout.trim();
  const commit = (await git(repo, ["commit-tree", tree, "-p", parent, "-m", `eval step ${step}`])).stdout.trim();
  await git(repo, ["update-ref", `refs/relay-eval/steps/${step}`, commit]);
  return commit;
}
