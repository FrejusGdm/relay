import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { snapshotStep } from "../src/snapshot.ts";
import { cleanup, gitRepo, temp } from "./helpers.ts";

afterEach(cleanup);

test("Snapshots add refs without changing HEAD, the branch or the index", async () => {
  const repo = await gitRepo({ "a.txt": "one\n", "NOTES.md": "# Notes\n" });
  writeFileSync(join(repo, "NOTES.md"), "# Notes\nUncommitted note from the person.\n");
  const head = (await git(repo, ["symbolic-ref", "HEAD"])).stdout;
  const tip = (await git(repo, ["rev-parse", "main"])).stdout;
  const index = readFileSync(join(repo, ".git", "index"));
  const indexPath = join(temp("eval-home"), "tmp", "run.index");
  let parent = tip.trim();
  const commits: string[] = [];
  for (const step of [1, 2, 3]) {
    writeFileSync(join(repo, `step-${step}.txt`), `step ${step}\n`);
    parent = await snapshotStep(repo, indexPath, step, parent);
    commits.push(parent);
  }
  expect((await git(repo, ["symbolic-ref", "HEAD"])).stdout).toBe(head);
  expect((await git(repo, ["rev-parse", "main"])).stdout).toBe(tip);
  expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/relay-eval/"])).stdout.trim().split("\n");
  expect(refs).toEqual(commits.map((commit, index) => `refs/relay-eval/steps/${index + 1} ${commit}`));
  expect((await git(repo, ["log", "--format=%s", commits[2]!])).stdout).toBe("eval step 3\neval step 2\neval step 1\nstart\n");
  expect((await git(repo, ["show", `${commits[0]}:NOTES.md`])).stdout).toContain("Uncommitted note");
  expect((await git(repo, ["ls-tree", "--name-only", commits[1]!])).stdout).toBe("NOTES.md\na.txt\nstep-1.txt\nstep-2.txt\n");
});
