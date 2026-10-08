// Scratch repositories for tests. Each one lives in a new relay-test- folder in the system
// temporary folder, with its own HOME and RELAY_HOME, and is removed by cleanup().
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ScratchRepo {
  root: string;
  repo: string;
  home: string;
  relayHome: string;
  // Runs git in the repository, without relay's runner, and returns standard output.
  git(...args: string[]): string;
  write(path: string, text: string): void;
  // Removes the folder and gives back the HOME and RELAY_HOME the test had before.
  cleanup(): void;
}

// Lets a git process past the test guard program for git (guard-bin/git), which stops every other
// git process that does not come from src/git/run.ts. Only helpers in this folder use it.
export const GIT_GUARD_PASS = { RELAY_GIT_RUNNER: "1" } as const;

// Setup commands never run hooks or signing, and never read the machine's git settings.
const SETUP_ENV = {
  ...GIT_GUARD_PASS,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test Person",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Person",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// Runs plain git, without relay's runner, and returns its exit code. Tests use it to show that a
// planted program does run when the runner's protections are missing.
export function plainGit(cwd: string, args: string[], env: Record<string, string> = {}): number {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env, ...GIT_GUARD_PASS },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode;
}

// The setting names git reads from the machine's system and global files, as relay's runner sees
// them: it removes every GIT_ variable, including the GIT_CONFIG_NOSYSTEM the test preload sets.
// A test that checks a list of settings relay prints leaves these out, because they differ from
// one machine to another (for example Git LFS's filter.lfs.* on CI runners).
export function machineGitKeys(cwd: string): Set<string> {
  const env: Record<string, string> = { ...GIT_GUARD_PASS };
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  const result = Bun.spawnSync(["git", "config", "--list", "--name-only", "--show-scope"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const keys = new Set<string>();
  for (const line of result.stdout.toString().split("\n")) {
    const [scope, name] = line.split("\t");
    if ((scope === "system" || scope === "global") && name) keys.add(name);
  }
  return keys;
}

// Runs git without relay's runner, to set up or change a scratch repository.
export function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
    { cwd, env: { ...process.env, ...SETUP_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

// `full` (the default) holds, on branch main:
// - two commits on main, a branch `feature` with its own commit, and a tag `v1`;
// - a stash entry "saved work";
// - staged.txt (new, staged), src/app.ts (staged, then changed again), README.md (changed, not
//   staged), notes.txt and docs/draft.md (untracked), ignored.log and node_modules/pkg/index.js
//   (ignored), the executable run.sh and the symbolic link link-to-readme.
// `empty` is a repository with no commits and no files.
export function makeScratchRepo(kind: "full" | "empty" = "full"): ScratchRepo {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const relayHome = join(root, "relay-home");
  mkdirSync(repo);
  mkdirSync(home);
  const previous = { HOME: process.env.HOME, RELAY_HOME: process.env.RELAY_HOME };
  process.env.HOME = home;
  process.env.RELAY_HOME = relayHome;

  const scratch: ScratchRepo = {
    root,
    repo,
    home,
    relayHome,
    git: (...args) => runGit(repo, args),
    write(path, text) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    },
    cleanup() {
      process.env.HOME = previous.HOME;
      process.env.RELAY_HOME = previous.RELAY_HOME;
      rmSync(root, { recursive: true, force: true });
    },
  };

  scratch.git("init", "-q", "-b", "main");
  if (kind === "empty") return scratch;

  scratch.write("README.md", "# Scratch\n");
  scratch.write("src/app.ts", "export const answer = 1;\n");
  scratch.write("run.sh", "#!/bin/sh\necho run\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("README.md", join(repo, "link-to-readme"));
  scratch.write(".gitignore", "ignored.log\nnode_modules/\n");
  scratch.git("add", "-A");
  scratch.git("commit", "-q", "-m", "first commit");

  scratch.git("switch", "-q", "-c", "feature");
  scratch.write("feature.txt", "feature work\n");
  scratch.git("add", "feature.txt");
  scratch.git("commit", "-q", "-m", "feature work");
  scratch.git("switch", "-q", "main");

  scratch.write("src/util.ts", "export const two = 2;\n");
  scratch.git("add", "src/util.ts");
  scratch.git("commit", "-q", "-m", "second commit");
  scratch.git("tag", "v1");

  scratch.write("README.md", "# Scratch\n\nWork to stash.\n");
  scratch.git("stash", "push", "-q", "-m", "saved work");

  scratch.write("staged.txt", "staged\n");
  scratch.write("src/app.ts", "export const answer = 2;\n");
  scratch.git("add", "staged.txt", "src/app.ts");
  scratch.write("src/app.ts", "export const answer = 3;\n");
  scratch.write("README.md", "# Scratch\n\nNot staged.\n");
  scratch.write("notes.txt", "untracked\n");
  scratch.write("docs/draft.md", "untracked draft\n");
  scratch.write("ignored.log", "ignored\n");
  scratch.write("node_modules/pkg/index.js", "module.exports = 1;\n");
  return scratch;
}
