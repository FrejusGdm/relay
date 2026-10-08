// captureState() records everything of the person's that relay must never change (design.md
// section 15). Tests compare a capture taken before a command with one taken after it.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { GIT_GUARD_PASS } from "./scratch-repo";

export interface RepoState {
  head: { symbolicRef: string; commit: string };
  // Every ref outside refs/relay/, with its object and, for a symbolic ref, its target: branches,
  // tags and refs/stash.
  refs: string[];
  stashList: string;
  // SHA-256 of each reflog file and of each worktree's index, by path inside the common git folder.
  reflogs: Record<string, string>;
  indexes: Record<string, string>;
  // SHA-256 of config, config.worktree and info/attributes (null when missing), by path inside
  // the common git folder, and of every entry in the hooks folder with its mode.
  gitFiles: Record<string, string | null>;
  hooks: Record<string, { mode: number; sha256: string }>;
  // Every file of the working tree except .git and .relay/, ignored files included.
  files: Record<string, { mode: number; sha256: string }>;
  status: string[];
}

// The capture writes nothing: optional locks are off, and hooks and the file-system monitor are
// disabled so a test that plants them can still capture. GIT_GUARD_PASS lets it past the test
// guard program for git. Any exit code other than `okCodes` stops the capture.
function readGit(cwd: string, args: string[], okCodes = [0]): { stdout: string; code: number } {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  Object.assign(env, { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", ...GIT_GUARD_PASS });
  const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!okCodes.includes(result.exitCode)) {
    throw new Error(`captureState: git ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.toString()}`);
  }
  return { stdout: result.stdout.toString(), code: result.exitCode };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(dir: string, skip: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(path)) continue;
    if (entry.isDirectory()) listFiles(path, skip, out);
    else out.push(path);
  }
  return out;
}

function hashFile(path: string): string {
  return lstatSync(path).isSymbolicLink() ? sha256(readlinkSync(path)) : sha256(readFileSync(path));
}

export function captureState(repoPath: string): RepoState {
  const [gitDir, commonDir] = readGit(repoPath, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
    .stdout.trim()
    .split("\n") as [string, string];

  // Exit code 1 means a detached HEAD, or no commit yet.
  const symbolicRef = readGit(repoPath, ["symbolic-ref", "-q", "HEAD"], [0, 1]).stdout.trim();
  const head = readGit(repoPath, ["rev-parse", "-q", "--verify", "HEAD"], [0, 1]);
  const refs = readGit(repoPath, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"])
    .stdout.split("\n")
    .filter((line) => line !== "" && !line.startsWith("refs/relay/"));

  // Linked worktrees keep their HEAD reflog and index in <common>/worktrees/<name>/.
  const worktreeDirs = [commonDir];
  const worktrees = join(commonDir, "worktrees");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees).sort()) worktreeDirs.push(join(worktrees, name));
  }
  const reflogs: Record<string, string> = {};
  const indexes: Record<string, string> = {};
  for (const dir of worktreeDirs) {
    const logs = join(dir, "logs");
    if (existsSync(logs)) {
      for (const file of listFiles(logs, () => false)) reflogs[relative(commonDir, file)] = hashFile(file);
    }
    const index = join(dir, "index");
    if (existsSync(index)) indexes[relative(commonDir, index)] = hashFile(index);
  }

  const gitFiles: RepoState["gitFiles"] = {};
  for (const file of [join(commonDir, "config"), join(gitDir, "config.worktree"), join(commonDir, "info", "attributes")]) {
    gitFiles[relative(commonDir, file)] = existsSync(file) ? hashFile(file) : null;
  }
  const hooks: RepoState["hooks"] = {};
  const hooksDir = join(commonDir, "hooks");
  if (existsSync(hooksDir)) {
    for (const file of listFiles(hooksDir, () => false)) {
      hooks[relative(hooksDir, file)] = { mode: lstatSync(file).mode, sha256: hashFile(file) };
    }
  }

  const files: RepoState["files"] = {};
  const skipped = new Set([join(repoPath, ".git"), join(repoPath, ".relay")]);
  for (const file of listFiles(repoPath, (path) => skipped.has(path))) {
    files[relative(repoPath, file)] = { mode: lstatSync(file).mode, sha256: hashFile(file) };
  }

  return {
    head: { symbolicRef, commit: head.code === 0 ? head.stdout.trim() : "(none)" },
    refs,
    stashList: readGit(repoPath, ["stash", "list"]).stdout,
    reflogs,
    indexes,
    gitFiles,
    hooks,
    files,
    status: readGit(repoPath, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"]).stdout.split("\0"),
  };
}
