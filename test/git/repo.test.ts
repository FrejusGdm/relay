import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { openRepository, RepositoryError } from "../../src/git/repo";
import { makeScratchRepo, runGit, type ScratchRepo } from "../helpers/scratch-repo";

let scratch: ScratchRepo;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = makeScratchRepo();
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  scratch.cleanup();
});

function setParentEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

async function expectProblem(cwd: string, problem: string, message: string): Promise<void> {
  const error = await openRepository(cwd).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RepositoryError);
  expect((error as RepositoryError).problem).toBe(problem as RepositoryError["problem"]);
  expect((error as RepositoryError).lines).toEqual([message]);
}

test("a subfolder resolves to the worktree root", async () => {
  const repo = await openRepository(join(scratch.repo, "src"));
  expect(repo).toEqual({
    worktreeRoot: scratch.repo,
    gitDir: join(scratch.repo, ".git"),
    commonDir: join(scratch.repo, ".git"),
    indexPath: join(scratch.repo, ".git", "index"),
    isLinkedWorktree: false,
    head: { sha: scratch.git("rev-parse", "HEAD").trim(), branch: "main", detached: false },
  });
});

test("a linked worktree returns its own index and the shared common folder", async () => {
  const linked = join(scratch.root, "linked");
  scratch.git("worktree", "add", "-q", "-b", "other", linked);
  const repo = await openRepository(linked);
  expect(repo).toEqual({
    worktreeRoot: linked,
    gitDir: join(scratch.repo, ".git", "worktrees", "linked"),
    commonDir: join(scratch.repo, ".git"),
    indexPath: join(scratch.repo, ".git", "worktrees", "linked", "index"),
    isLinkedWorktree: true,
    head: { sha: scratch.git("rev-parse", "HEAD").trim(), branch: "other", detached: false },
  });
});

test("a detached HEAD has a commit and no branch", async () => {
  scratch.git("switch", "-q", "--detach");
  const repo = await openRepository(scratch.repo);
  expect(repo.head).toEqual({ sha: scratch.git("rev-parse", "HEAD").trim(), branch: null, detached: true });
});

test("a repository with no commits has a branch and no commit", async () => {
  const empty = makeScratchRepo("empty");
  try {
    const repo = await openRepository(empty.repo);
    expect(repo.worktreeRoot).toBe(empty.repo);
    expect(repo.head).toEqual({ sha: null, branch: "main", detached: false });
  } finally {
    empty.cleanup();
  }
});

test("a bare repository is refused", async () => {
  runGit(scratch.root, ["init", "-q", "--bare", "bare.git"]);
  await expectProblem(join(scratch.root, "bare.git"), "bare", "This repository has no working tree. relay needs one.");
});

test("a folder outside any repository is refused", async () => {
  const outside = join(scratch.root, "outside");
  mkdirSync(outside);
  await expectProblem(
    outside,
    "not_a_repository",
    "This folder is not inside a git repository. Run relay init inside your project.",
  );
});

test.each([".git", ".git/refs"])("the inside of the git folder (%s) is refused", async (inside) => {
  await expectProblem(
    join(scratch.repo, inside),
    "inside_git_dir",
    "This folder is inside the .git folder. Run relay from your project's files instead.",
  );
});

test("GIT_DIR and GIT_WORK_TREE in the parent do not change which repository is opened", async () => {
  const other = join(scratch.root, "other");
  mkdirSync(other);
  runGit(other, ["init", "-q", "-b", "elsewhere"]);
  setParentEnv("GIT_DIR", join(other, ".git"));
  setParentEnv("GIT_WORK_TREE", other);
  setParentEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
  const repo = await openRepository(scratch.repo);
  expect(repo.worktreeRoot).toBe(scratch.repo);
  expect(repo.indexPath).toBe(join(scratch.repo, ".git", "index"));
  expect(repo.head.branch).toBe("main");
});

test("git older than 2.34 is refused with its version", async () => {
  const fakeBin = join(scratch.root, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "git"), '#!/bin/sh\necho "git version 2.30.0"\n', { mode: 0o755 });
  setParentEnv("PATH", `${fakeBin}${delimiter}${process.env.PATH}`);
  await expectProblem(scratch.repo, "git_too_old", "relay needs git 2.34 or newer. You have git 2.30.0.");
});

test("a git version with a vendor suffix is read", async () => {
  const fakeBin = join(scratch.root, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "git"), '#!/bin/sh\necho "git version 2.33.1 (Apple Git-130)"\n', { mode: 0o755 });
  setParentEnv("PATH", `${fakeBin}${delimiter}${process.env.PATH}`);
  await expectProblem(scratch.repo, "git_too_old", "relay needs git 2.34 or newer. You have git 2.33.1.");
});
