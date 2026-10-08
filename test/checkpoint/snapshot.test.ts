// The checkpoint tree (tasks.md 5.1): what buildSnapshotTree puts in the tree and leaves out, and
// that the person's index and relay's temporary files are untouched or gone afterwards.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshotTree } from "../../src/checkpoint/snapshot";
import { openRepository } from "../../src/git/repo";
import { runRelayInProcess } from "../helpers/cli";
import { captureState } from "../helpers/invariants";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

const MB = 1024 * 1024;
const JOB_FILES = [".relay/checkpoint.md", ".relay/decisions.md", ".relay/events.jsonl", ".relay/state.json", ".relay/task.md"];

let scratch: ScratchRepo;

// Each command runs git and gitleaks several times; a test with several commands takes seconds.
setDefaultTimeout(30_000);

beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

async function setUpJob(kind: "full" | "empty" = "full"): Promise<string> {
  scratch = makeScratchRepo(kind);
  expect((await runRelayInProcess(["init"], { cwd: scratch.repo, relayHome: scratch.relayHome })).code).toBe(0);
  return JSON.parse(readFileSync(join(scratch.repo, ".relay", "state.json"), "utf8")).job_id;
}

async function snapshot(jobId: string, options: { maxFileBytes?: number; approved?: string[] } = {}) {
  const repo = await openRepository(scratch.repo);
  return await buildSnapshotTree(repo, {
    jobId,
    relayHome: scratch.relayHome,
    maxFileBytes: options.maxFileBytes ?? 20 * MB,
    approved: options.approved ?? [],
  });
}

const paths = (tree: string) => scratch.git("ls-tree", "-r", "-z", "--name-only", tree).split("\0").filter((path) => path !== "");
const content = (tree: string, path: string) => scratch.git("show", `${tree}:${path}`);
const indexHash = () => createHash("sha256").update(readFileSync(join(scratch.repo, ".git", "index"))).digest("hex");
const tmpFiles = () => (existsSync(join(scratch.relayHome, "tmp")) ? readdirSync(join(scratch.relayHome, "tmp")) : []);

test("the tree holds the working-tree version of every tracked and untracked file and the job files", async () => {
  const jobId = await setUpJob();
  scratch.write(".relay/notes.tmp", "stray\n");
  const index = indexHash();
  const before = captureState(scratch.repo);

  const { tree, leftOut, secretLike } = await snapshot(jobId);
  expect(paths(tree).sort()).toEqual(
    [
      ".gitignore", "README.md", "docs/draft.md", "link-to-readme", "notes.txt", "run.sh", "src/app.ts", "src/util.ts",
      "staged.txt", ...JOB_FILES,
    ].sort(),
  );
  // Staged, then changed again: the tree has the working-tree version.
  expect(content(tree, "src/app.ts")).toBe("export const answer = 3;\n");
  expect(content(tree, "README.md")).toBe("# Scratch\n\nNot staged.\n");
  expect(content(tree, "notes.txt")).toBe("untracked\n");
  expect(content(tree, ".relay/task.md")).toBe(readFileSync(join(scratch.repo, ".relay", "task.md"), "utf8"));
  expect([leftOut, secretLike]).toEqual([[], []]);

  expect(indexHash()).toBe(index);
  expect(captureState(scratch.repo)).toEqual(before);
  expect(tmpFiles()).toEqual([]);
});

test("a file changed again in the same second as the person's git add, with the same size, is seen", async () => {
  const jobId = await setUpJob();
  for (let round = 0; round < 3; round++) {
    scratch.write("same.txt", `version ${round}a\n`);
    scratch.git("add", "same.txt");
    scratch.write("same.txt", `version ${round}b\n`);
    expect(content((await snapshot(jobId)).tree, "same.txt")).toBe(`version ${round}b\n`);
  }
});

test(".relay/verify.md is stored only when it exists, and never as a folder", async () => {
  const jobId = await setUpJob();
  expect(paths((await snapshot(jobId)).tree)).not.toContain(".relay/verify.md");
  scratch.write(".relay/verify.md/inside", "x\n");
  expect(paths((await snapshot(jobId)).tree).filter((path) => path.startsWith(".relay/verify.md"))).toEqual([]);
  rmSync(join(scratch.repo, ".relay", "verify.md"), { recursive: true });
  scratch.write(".relay/verify.md", "# Verify\n");
  const { tree } = await snapshot(jobId);
  expect(content(tree, ".relay/verify.md")).toBe("# Verify\n");
});

test("files over the limit are listed and left out, and a tracked one keeps its index version", async () => {
  const jobId = await setUpJob();
  writeFileSync(join(scratch.repo, "big.bin"), Buffer.alloc(2 * MB, 1));
  writeFileSync(join(scratch.repo, "README.md"), "x".repeat(2 * MB));
  const index = indexHash();

  const { tree, leftOut } = await snapshot(jobId, { maxFileBytes: 1 * MB });
  expect(leftOut.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
    { path: "README.md", reason: "size", bytes: 2 * MB },
    { path: "big.bin", reason: "size", bytes: 2 * MB },
  ]);
  expect(paths(tree)).not.toContain("big.bin");
  expect(content(tree, "README.md")).toBe("# Scratch\n");
  expect(indexHash()).toBe(index);
  expect(tmpFiles()).toEqual([]);
});

test("an untracked file with a secret-like name is kept out unless the person approved it", async () => {
  const jobId = await setUpJob();
  scratch.write("config/.env.local", "A=1\n");
  scratch.write(".env.example", "A=\n");

  const refused = await snapshot(jobId);
  expect(refused.secretLike).toEqual(["config/.env.local"]);
  expect(paths(refused.tree)).not.toContain("config/.env.local");
  expect(paths(refused.tree)).toContain(".env.example");

  const approved = await snapshot(jobId, { approved: ["config/.env.local"] });
  expect([approved.secretLike, approved.approvedSecretLike]).toEqual([[], ["config/.env.local"]]);
  expect(content(approved.tree, "config/.env.local")).toBe("A=1\n");
});

test("in a repository with no commits and no index, the tree holds the files and no index is created", async () => {
  const jobId = await setUpJob("empty");
  scratch.write("first.txt", "first\n");
  const before = captureState(scratch.repo);
  const { tree } = await snapshot(jobId);
  expect(paths(tree).sort()).toEqual(["first.txt", ...JOB_FILES].sort());
  expect(existsSync(join(scratch.repo, ".git", "index"))).toBe(false);
  expect(captureState(scratch.repo)).toEqual(before);
  expect(tmpFiles()).toEqual([]);
});

// APFS refuses file names that are not UTF-8 (EILSEQ), so such a file cannot exist on macOS.
test.skipIf(process.platform === "darwin")("a file name that is not UTF-8 is still measured and left out", async () => {
  const jobId = await setUpJob();
  const name = Buffer.concat([Buffer.from("big"), Buffer.from([0xff]), Buffer.from(".bin")]);
  writeFileSync(Buffer.concat([Buffer.from(`${scratch.repo}/`), name]), Buffer.alloc(2 * MB, 1));
  const { tree, leftOut } = await snapshot(jobId, { maxFileBytes: 1 * MB });
  expect(leftOut).toEqual([{ path: "big\ufffd.bin", reason: "size", bytes: 2 * MB }]);
  expect(paths(tree).filter((path) => path.startsWith("big"))).toEqual([]);
});

test("in a cone-mode sparse checkout with a sparse index, files outside the cone keep their committed version", async () => {
  const jobId = await setUpJob();
  scratch.write("b/f.txt", "outside the cone\n");
  scratch.git("add", "b/f.txt");
  scratch.git("commit", "-q", "-m", "b");
  scratch.git("sparse-checkout", "init", "--cone", "--sparse-index");
  scratch.git("sparse-checkout", "set", "src");
  scratch.write("src/app.ts", "export const answer = 4;\n");
  const before = captureState(scratch.repo);
  const { tree } = await snapshot(jobId);
  expect(content(tree, "b/f.txt")).toBe("outside the cone\n");
  expect(content(tree, "src/app.ts")).toBe("export const answer = 4;\n");
  expect(paths(tree)).toContain(".relay/task.md");
  expect(captureState(scratch.repo)).toEqual(before);
});

test("the temporary files are removed when git fails", async () => {
  const jobId = await setUpJob();
  // A damaged index makes git ls-files fail on relay's copy of it.
  writeFileSync(join(scratch.repo, ".git", "index"), "not an index\n");
  await expect(snapshot(jobId)).rejects.toThrow("relay could not build the checkpoint");
  expect(tmpFiles()).toEqual([]);
});
