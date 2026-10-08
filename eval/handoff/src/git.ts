import { dirname, isAbsolute } from "node:path";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Like relay's own git runner (add-checkpoint-engine design decision 8), inherited GIT_ variables
// are dropped so they cannot point git at another repository. GIT_CEILING_DIRECTORIES stops git
// from using a repository in a parent folder when cwd is not a repository itself.
function gitEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CEILING_DIRECTORIES: dirname(cwd),
    // relay's test preload puts a guard program named git first on PATH, which stops every git
    // process started without this variable. This file is the harness's one git runner, so it
    // sets the variable the same way src/git/run.ts does. Outside the tests nothing reads it.
    RELAY_GIT_RUNNER: "1",
    ...extra,
  };
}

export async function git(
  cwd: string,
  args: string[],
  options?: { env?: Record<string, string>; allowFailure?: boolean },
): Promise<GitResult> {
  if (!isAbsolute(cwd)) {
    throw new Error(`git.ts needs an absolute working directory, got ${cwd}.`);
  }
  const child = Bun.spawn([
    "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
    "-c", "user.name=relay eval", "-c", "user.email=eval@relay.invalid", ...args,
  ], {
    cwd,
    env: gitEnv(cwd, options?.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && options?.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return { exitCode, stdout, stderr };
}
