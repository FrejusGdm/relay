import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";

const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-git-"));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Git disables repository hooks and uses the evaluation author", async () => {
  const dir = temp();
  await git(dir, ["init", "-b", "main"]);
  const hook = join(dir, ".git", "hooks", "post-commit");
  writeFileSync(hook, '#!/bin/sh\nprintf "ran\\n" > hook-ran\n');
  chmodSync(hook, 0o755);
  // The -c settings of git() apply to the command they run, not to what it writes, so this stores
  // the hooks folder in the repository's own settings.
  await git(dir, ["config", "core.hooksPath", ".git/hooks"]);
  writeFileSync(join(dir, "file.txt"), "A file for the commit.\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "test"]);
  expect(existsSync(join(dir, "hook-ran"))).toBe(false);
  expect((await git(dir, ["log", "-1", "--format=%an <%ae>"])).stdout.trim())
    .toBe("relay eval <eval@relay.invalid>");
});

test("Git ignores the repository's commit signing settings", async () => {
  const dir = temp();
  await git(dir, ["init", "-b", "main"]);
  const signer = join(dir, "fake-gpg");
  writeFileSync(signer, '#!/bin/sh\nprintf "ran\\n" > "$(dirname "$0")/signer-ran"\nexit 1\n');
  chmodSync(signer, 0o755);
  const settings: [string, string][] = [["commit.gpgSign", "true"], ["gpg.program", signer]];
  for (const [key, value] of settings) await git(dir, ["config", key, value]);
  writeFileSync(join(dir, "file.txt"), "A file for the commit.\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "test"]);
  expect(existsSync(join(dir, "signer-ran"))).toBe(false);
});

test("Git rejects a relative working directory", async () => {
  await expect(git("relative", ["status"]))
    .rejects.toThrow("git.ts needs an absolute working directory, got relative.");
});

test("Git rejects failed commands unless failure is allowed", async () => {
  const dir = temp();
  await git(dir, ["init", "-b", "main"]);
  try {
    await git(dir, ["rev-parse", "nope"]);
    throw new Error("The git command unexpectedly succeeded.");
  } catch (error) {
    expect(error instanceof Error && error.message.startsWith(`git rev-parse nope failed in ${dir}`)).toBe(true);
  }
  const result = await git(dir, ["rev-parse", "nope"], { allowFailure: true });
  expect(result.exitCode).not.toBe(0);
});

test("Git ignores an inherited GIT_DIR that points at another repository", async () => {
  const other = temp();
  const scratch = temp();
  await git(other, ["init", "-b", "main"]);
  await git(scratch, ["init", "-b", "main"]);
  writeFileSync(join(scratch, "file.txt"), "A scratch file.\n");
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    await git(scratch, ["add", "-A"]);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.tree;
  }
  expect((await git(scratch, ["diff", "--cached", "--name-only"])).stdout).toBe("file.txt\n");
  expect((await git(other, ["diff", "--cached", "--name-only"])).stdout).toBe("");
});

test("Git does not use a repository in a parent folder", async () => {
  const outer = temp();
  await git(outer, ["init", "-b", "main"]);
  const inner = join(outer, "scratch");
  mkdirSync(inner);
  const result = await git(inner, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not a git repository");
});
