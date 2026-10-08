// Finding the repository that holds a folder (design.md decision 13).
import { git } from "./run";

export interface Repository {
  worktreeRoot: string;
  gitDir: string;
  // The folder shared by all worktrees: refs, hooks and info/exclude live here.
  commonDir: string;
  indexPath: string;
  isLinkedWorktree: boolean;
  head: { sha: string | null; branch: string | null; detached: boolean };
}

type RepositoryProblem = "git_too_old" | "not_a_repository" | "bare" | "inside_git_dir";

// Each problem ends a command with exit code 3. `lines` are printed to standard error.
export class RepositoryError extends Error {
  constructor(readonly problem: RepositoryProblem, readonly lines: string[]) {
    super(lines[0]);
    this.name = "RepositoryError";
  }
}

const MESSAGES: Record<Exclude<RepositoryProblem, "git_too_old">, string> = {
  not_a_repository: "This folder is not inside a git repository. Run relay init inside your project.",
  bare: "This repository has no working tree. relay needs one.",
  inside_git_dir: "This folder is inside the .git folder. Run relay from your project's files instead.",
};

const decoder = new TextDecoder();

export async function openRepository(cwd: string): Promise<Repository> {
  await checkGitVersion(cwd);

  const where = await git(cwd, [
    "rev-parse", "--is-bare-repository", "--is-inside-work-tree", "--path-format=absolute",
    "--show-toplevel", "--git-dir", "--git-common-dir",
  ]);
  const lines = decoder.decode(where.stdout).split("\n");
  if (lines[0] === "true") throw problem("bare");
  if (lines[1] === "false") throw problem("inside_git_dir");
  if (where.code !== 0) {
    if (where.stderr.includes("not a git repository")) throw problem("not_a_repository");
    throw new Error(`git rev-parse failed: ${where.stderr.trim()}`);
  }
  const [, , worktreeRoot, gitDir, commonDir] = lines as [string, string, string, string, string];

  const index = await git(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (index.code !== 0) throw new Error(`git rev-parse failed: ${index.stderr.trim()}`);
  const branch = await git(worktreeRoot, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const sha = await git(worktreeRoot, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);

  return {
    worktreeRoot,
    gitDir,
    commonDir,
    indexPath: decoder.decode(index.stdout).trim(),
    isLinkedWorktree: gitDir !== commonDir,
    head: {
      sha: sha.code === 0 ? decoder.decode(sha.stdout).trim() : null,
      branch: branch.code === 0 ? decoder.decode(branch.stdout).trim() : null,
      detached: branch.code !== 0,
    },
  };
}

function problem(kind: Exclude<RepositoryProblem, "git_too_old">): RepositoryError {
  return new RepositoryError(kind, [MESSAGES[kind]]);
}

async function checkGitVersion(cwd: string): Promise<void> {
  const result = await git(cwd, ["version"]);
  const output = decoder.decode(result.stdout).trim();
  const match = /^git version ((\d+)\.(\d+)\S*)/.exec(output);
  if (result.code !== 0 || match === null) throw new Error(`relay could not read the git version: ${output || result.stderr.trim()}`);
  const [, version, major, minor] = match as unknown as [string, string, string, string];
  if (Number(major) < 2 || (Number(major) === 2 && Number(minor) < 34)) {
    throw new RepositoryError("git_too_old", [`relay needs git 2.34 or newer. You have git ${version}.`]);
  }
}
