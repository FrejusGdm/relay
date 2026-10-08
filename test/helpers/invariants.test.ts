import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureState, type RepoState } from "./invariants";
import { makeScratchRepo, type ScratchRepo } from "./scratch-repo";

let scratch: ScratchRepo;
let before: RepoState;

beforeEach(() => {
  scratch = makeScratchRepo();
  before = captureState(scratch.repo);
});
afterEach(() => scratch.cleanup());

test("the scratch repository has every kind of state the capture records", () => {
  expect(before.head).toEqual({ symbolicRef: "refs/heads/main", commit: scratch.git("rev-parse", "HEAD").trim() });
  expect(Object.keys(before.gitFiles)).toEqual(["config", "config.worktree", "info/attributes"]);
  expect(Object.keys(before.hooks)).toContain("pre-commit.sample");
  expect(before.refs.map((line) => line.split(" ")[0])).toEqual(["refs/heads/feature", "refs/heads/main", "refs/stash", "refs/tags/v1"]);
  expect(before.stashList).toContain("saved work");
  expect(Object.keys(before.reflogs)).toContain("logs/refs/heads/main");
  expect(Object.keys(before.indexes)).toEqual(["index"]);
  expect(Object.keys(before.files).sort()).toEqual([
    ".gitignore", "README.md", "docs/draft.md", "ignored.log", "link-to-readme", "node_modules/pkg/index.js",
    "notes.txt", "run.sh", "src/app.ts", "src/util.ts", "staged.txt",
  ]);
  expect(before.status).toContain("1 MM N... 100644 100644 100644 " + scratch.git("rev-parse", "HEAD:src/app.ts").trim() + " " + scratch.git("rev-parse", ":src/app.ts").trim() + " src/app.ts");
  expect(before.status).toContain("! ignored.log");
  expect(before.status).toContain("? notes.txt");
  expect(scratch.home).toBe(process.env.HOME!);
  expect(scratch.relayHome).toBe(process.env.RELAY_HOME!);
});

test("two captures of an unchanged repository are equal", () => {
  expect(captureState(scratch.repo)).toEqual(before);
});

test("a ref under refs/relay/ is not part of the capture", () => {
  scratch.git("update-ref", "refs/relay/jobs/3f9a2c1d/latest", "HEAD");
  expect(captureState(scratch.repo)).toEqual(before);
});

test("a planted file-system monitor does not run during a capture", () => {
  const marker = join(scratch.root, "fsmonitor-ran");
  writeFileSync(join(scratch.root, "monitor.sh"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  scratch.git("config", "core.fsmonitor", join(scratch.root, "monitor.sh"));
  captureState(scratch.repo);
  expect(existsSync(marker)).toBe(false);
});

test("detects a changed index byte", () => {
  // Changes the first entry's ctime nanoseconds and writes a matching checksum, so git still
  // reads the index.
  const index = join(scratch.repo, ".git", "index");
  const bytes = readFileSync(index);
  bytes[12 + 7] = bytes[12 + 7]! ^ 0x01;
  createHash("sha1").update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
  writeFileSync(index, bytes);
  const after = captureState(scratch.repo);
  expect(after.indexes).not.toEqual(before.indexes);
});

test("stops when a git call fails, for example on a damaged index", () => {
  // The first four bytes are the signature "DIRC"; git refuses an index without it.
  const index = join(scratch.repo, ".git", "index");
  const bytes = readFileSync(index);
  bytes[0] = 0x58;
  writeFileSync(index, bytes);
  expect(() => captureState(scratch.repo)).toThrow("captureState: git status");
});

test("detects a changed .git/config, a created info/attributes and a new hook", () => {
  scratch.git("config", "core.editor", "vi");
  writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "* -diff\n");
  writeFileSync(join(scratch.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  const after = captureState(scratch.repo);
  expect(before.gitFiles["info/attributes"]).toBeNull();
  expect(after.gitFiles["config"]).not.toBe(before.gitFiles["config"]);
  expect(after.gitFiles["info/attributes"]).not.toBeNull();
  expect(after.hooks["pre-commit"]).toBeDefined();
  expect(before.hooks["pre-commit"]).toBeUndefined();
});

test("detects a symbolic ref that points somewhere else", () => {
  scratch.git("symbolic-ref", "refs/heads/current", "refs/heads/main");
  const withMain = captureState(scratch.repo);
  scratch.git("symbolic-ref", "refs/heads/current", "refs/heads/feature");
  const withFeature = captureState(scratch.repo);
  expect(withMain.refs).toContain(`refs/heads/current ${scratch.git("rev-parse", "main").trim()} refs/heads/main`);
  expect(withFeature.refs).not.toEqual(withMain.refs);
});

test("detects a new stash entry", () => {
  const commit = scratch.git("stash", "create", "more work").trim();
  scratch.git("stash", "store", "-m", "more work", commit);
  const after = captureState(scratch.repo);
  expect(after.stashList).not.toEqual(before.stashList);
  expect(after.files).toEqual(before.files);
});

test("detects a reflog line", () => {
  appendFileSync(join(scratch.repo, ".git", "logs", "refs", "heads", "feature"), "extra line\n");
  const after = captureState(scratch.repo);
  expect(after.reflogs).not.toEqual(before.reflogs);
  expect(after.refs).toEqual(before.refs);
});

test("detects a moved branch", () => {
  scratch.git("update-ref", "--no-deref", "refs/heads/feature", "main");
  const after = captureState(scratch.repo);
  expect(after.refs).not.toEqual(before.refs);
});

test("detects a changed file mode", () => {
  chmodSync(join(scratch.repo, "run.sh"), 0o644);
  const after = captureState(scratch.repo);
  expect(after.files["run.sh"]!.mode).not.toBe(before.files["run.sh"]!.mode);
  expect(after.files["run.sh"]!.sha256).toBe(before.files["run.sh"]!.sha256);
});

test("detects a changed ignored file", () => {
  writeFileSync(join(scratch.repo, "ignored.log"), "changed\n");
  const after = captureState(scratch.repo);
  expect(after.files["ignored.log"]).not.toEqual(before.files["ignored.log"]);
  expect(after.status).toEqual(before.status);
});

test("cleanup removes the folder and gives back HOME and RELAY_HOME", () => {
  const outer = { HOME: process.env.HOME, RELAY_HOME: process.env.RELAY_HOME };
  const inner = makeScratchRepo("empty");
  expect(process.env.HOME).toBe(inner.home);
  inner.cleanup();
  expect(existsSync(inner.root)).toBe(false);
  expect({ HOME: process.env.HOME, RELAY_HOME: process.env.RELAY_HOME }).toEqual(outer);
});
