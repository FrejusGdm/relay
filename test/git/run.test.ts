import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { git, watchGitCalls } from "../../src/git/run";
import { captureState } from "../helpers/invariants";
import { GIT_GUARD_PASS, makeScratchRepo, plainGit as plainGitIn, runGit, type ScratchRepo } from "../helpers/scratch-repo";

const HOOK_EVENTS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
  "p4-pre-submit", "post-index-change",
];

const PREFIX = [
  "git",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.quotePath=false",
  "-c", "diff.external=",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "commit.gpgSign=false",
  "-c", "log.showSignature=false",
  "-c", "gpg.program=false",
  "-c", "gpg.ssh.program=false",
  "-c", "gpg.x509.program=false",
  "-c", "core.logAllRefUpdates=false",
  "-c", "core.splitIndex=false",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "color.ui=false",
  ...HOOK_EVENTS.flatMap((event) => ["-c", `hook.${event}.enabled=false`]),
];

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

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

// Plain git, without relay's runner, to show that a planted program does run there.
function plainGit(args: string[], env: Record<string, string> = {}): number {
  return plainGitIn(scratch.repo, args, env);
}

// Records every process start while `body` runs, and still starts the process.
async function spySpawn<T>(body: () => Promise<T>): Promise<{ result: T; spawns: { argv: string[]; options: Record<string, unknown> }[] }> {
  const original = Bun.spawn;
  const spawns: { argv: string[]; options: Record<string, unknown> }[] = [];
  Bun.spawn = ((argv: string[], options: Record<string, unknown>) => {
    spawns.push({ argv, options });
    return (original as (...args: unknown[]) => unknown)(argv, options);
  }) as unknown as typeof Bun.spawn;
  try {
    return { result: await body(), spawns };
  } finally {
    Bun.spawn = original;
  }
}

// A script that creates `marker` when something runs it.
function markerScript(name: string): { script: string; marker: string } {
  const script = join(scratch.root, name);
  const marker = join(scratch.root, `${name}.ran`);
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
  return { script, marker };
}

function removeMarker(marker: string): void {
  Bun.spawnSync(["rm", "-f", marker]);
}

async function expectRefusedWithoutSpawn(args: string[], options: { input?: string; indexFile?: string } = {}): Promise<void> {
  const { spawns } = await spySpawn(async () => {
    await expect(git(scratch.repo, args, options)).rejects.toThrow(`relay refused to run git ${args.join(" ")}`);
  });
  expect(spawns).toEqual([]);
}

test("every call starts git with the exact overrides first", async () => {
  const watch = watchGitCalls();
  const { result, spawns } = await spySpawn(() => git(scratch.repo, ["status", "--porcelain"]));
  watch.stop();
  expect(result.code).toBe(0);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.argv).toEqual([...PREFIX, "status", "--porcelain"]);
  expect(spawns[0]!.options.cwd).toBe(scratch.repo);
  expect(watch.calls).toEqual([[...PREFIX, "status", "--porcelain"]]);
});

test("git itself sees the overrides as command-line settings", async () => {
  const result = await git(scratch.repo, ["config", "--list", "--show-scope"]);
  const commandScope = decode(result.stdout).split("\n").filter((line) => line.startsWith("command\t"));
  const expected = PREFIX.filter((_, i) => i > 0 && PREFIX[i - 1] === "-c").map((setting) => `command\t${setting.toLowerCase()}`);
  expect(commandScope).toEqual(expected);
});

test("the environment drops the parent's GIT_ variables and sets relay's own", async () => {
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_ALLOW_PROTOCOL"]) {
    setParentEnv(name, "/somewhere/else");
  }
  const { spawns } = await spySpawn(() => git(scratch.repo, ["status"]));
  const env = spawns[0]!.options.env as Record<string, string>;
  expect(Object.keys(env).filter((name) => name.startsWith("GIT_")).sort()).toEqual([
    "GIT_ALLOW_PROTOCOL", "GIT_OPTIONAL_LOCKS", "GIT_PAGER", "GIT_TERMINAL_PROMPT",
  ]);
  expect(env.GIT_ALLOW_PROTOCOL).toBe("");
  expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GIT_PAGER).toBe("cat");
  expect(env.PAGER).toBe("cat");
  expect(env.LC_ALL).toBe("C");
  for (const [name, value] of Object.entries(GIT_GUARD_PASS)) expect(env[name]).toBe(value);
  expect(env.HOME).toBe(scratch.home);
});

test("GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE in the parent do not redirect git", async () => {
  const other = join(scratch.root, "other");
  mkdirSync(other);
  runGit(other, ["init", "-q", "-b", "main"]);
  setParentEnv("GIT_DIR", join(other, ".git"));
  setParentEnv("GIT_WORK_TREE", other);
  setParentEnv("GIT_INDEX_FILE", join(other, ".git", "index"));

  const where = await git(scratch.repo, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-path", "index"]);
  expect(decode(where.stdout).split("\n").slice(0, 3)).toEqual([
    scratch.repo, join(scratch.repo, ".git"), join(scratch.repo, ".git", "index"),
  ]);
  const staged = await git(scratch.repo, ["diff", "--cached", "--name-only", "HEAD"]);
  expect(decode(staged.stdout)).toBe("src/app.ts\nstaged.txt\n");
});

test("GIT_EXTERNAL_DIFF and diff.external never run, and git diff still works", async () => {
  const fromEnv = markerScript("external-diff-env");
  const fromConfig = markerScript("external-diff-config");
  plainGit(["diff"], { GIT_EXTERNAL_DIFF: fromEnv.script });
  expect(existsSync(fromEnv.marker)).toBe(true);

  setParentEnv("GIT_EXTERNAL_DIFF", fromEnv.script);
  scratch.git("config", "diff.external", fromConfig.script);
  removeMarker(fromEnv.marker);
  const result = await git(scratch.repo, ["diff", "--", "README.md"]);
  expect(result.code).toBe(0);
  expect(decode(result.stdout)).toContain("+Not staged.");
  expect(existsSync(fromEnv.marker)).toBe(false);
  expect(existsSync(fromConfig.marker)).toBe(false);
});

test("diff drivers and textconv programs from .gitattributes never run in diff, log or show", async () => {
  const driver = markerScript("diff-driver");
  const textconv = markerScript("textconv");
  scratch.write(".gitattributes", "README.md diff=planted\n");
  scratch.git("config", "diff.planted.command", driver.script);
  scratch.git("config", "diff.planted.textconv", textconv.script);
  plainGit(["diff", "--", "README.md"]);
  plainGit(["diff", "--no-ext-diff", "--", "README.md"]);
  expect(existsSync(driver.marker)).toBe(true);
  expect(existsSync(textconv.marker)).toBe(true);
  removeMarker(driver.marker);
  removeMarker(textconv.marker);

  expect((await git(scratch.repo, ["diff", "--", "README.md"])).code).toBe(0);
  expect((await git(scratch.repo, ["log", "-p", "-1", "--", "README.md"])).code).toBe(0);
  expect((await git(scratch.repo, ["show", "HEAD~1", "--", "README.md"])).code).toBe(0);
  expect((await git(scratch.repo, ["diff-tree", "-p", "HEAD~1", "HEAD"])).code).toBe(0);
  expect(existsSync(driver.marker)).toBe(false);
  expect(existsSync(textconv.marker)).toBe(false);
});

// A commit with a (fake) signature, so git would check it with the signing program.
function signedCommit(): string {
  const tree = scratch.git("rev-parse", "HEAD^{tree}").trim();
  const head = scratch.git("rev-parse", "HEAD").trim();
  const signed = [
    `tree ${tree}`, `parent ${head}`,
    "author A <a@example.com> 1700000000 +0000", "committer A <a@example.com> 1700000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----", " ", " -----END PGP SIGNATURE-----", "", "signed", "",
  ].join("\n");
  writeFileSync(join(scratch.root, "signed.txt"), signed);
  return scratch.git("hash-object", "-w", "-t", "commit", join(scratch.root, "signed.txt")).trim();
}

test("log.showSignature in the repository does not start the signing program", async () => {
  const { script, marker } = markerScript("gpg-verify");
  const commit = signedCommit();
  scratch.git("config", "log.showSignature", "true");
  scratch.git("config", "gpg.program", script);
  plainGit(["log", "-1", commit]);
  expect(existsSync(marker)).toBe(true);
  removeMarker(marker);

  expect((await git(scratch.repo, ["log", "-1", commit])).code).toBe(0);
  expect((await git(scratch.repo, ["show", "-s", commit])).code).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test("signature format codes are refused, and a named format with them does not start the signing program", async () => {
  const { script, marker } = markerScript("gpg-format");
  const commit = signedCommit();
  scratch.git("config", "gpg.program", script);
  scratch.git("config", "gpg.ssh.program", script);
  scratch.git("config", "gpg.x509.program", script);
  scratch.git("config", "pretty.sig", "format:%G? %GS");
  plainGit(["-c", "log.showSignature=false", "log", "-1", "--format=%G?", commit]);
  expect(existsSync(marker)).toBe(true);
  removeMarker(marker);

  for (const args of [
    ["log", "-1", "--format=%G?", commit], ["log", "-1", "--pretty=format:%GS", commit], ["show", "-s", "--format=%GK", commit],
    ["rev-list", "-1", "--format=%GF", commit], ["diff-tree", "-s", "--pretty=tformat:%GP", commit], ["log", "--form=%GT", commit],
  ]) {
    await expectRefusedWithoutSpawn(args);
  }
  expect((await git(scratch.repo, ["log", "-1", "--pretty=sig", commit])).code).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test("GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT in the parent cannot plant settings", async () => {
  const { script, marker } = markerScript("planted-monitor");
  setParentEnv("GIT_CONFIG_PARAMETERS", `'core.fsmonitor'='${script}'`);
  setParentEnv("GIT_CONFIG_COUNT", "1");
  setParentEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
  setParentEnv("GIT_CONFIG_VALUE_0", script);
  await git(scratch.repo, ["status"]);
  expect(existsSync(marker)).toBe(false);
});

test("a core.fsmonitor script set in the repository never runs during git status", async () => {
  const { script, marker } = markerScript("fsmonitor");
  scratch.git("config", "core.fsmonitor", script);
  plainGit(["status"]);
  expect(existsSync(marker)).toBe(true);
  removeMarker(marker);

  const before = captureState(scratch.repo);
  const result = await git(scratch.repo, ["status", "--porcelain"]);
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(captureState(scratch.repo)).toEqual(before);
});

test("hooks in .git/hooks and in a configured core.hooksPath never run", async () => {
  const hooks = ["reference-transaction", "post-index-change"];
  const markers: string[] = [];
  const otherHooks = join(scratch.root, "other-hooks");
  mkdirSync(otherHooks);
  for (const dir of [join(scratch.repo, ".git", "hooks"), otherHooks]) {
    for (const hook of hooks) {
      const marker = join(dir, `${hook}.ran`);
      writeFileSync(join(dir, hook), `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`, { mode: 0o755 });
      markers.push(marker);
    }
  }
  plainGit(["update-ref", "refs/relay/control", "HEAD"]);
  expect(existsSync(markers[0]!)).toBe(true);
  removeMarker(markers[0]!);
  scratch.git("config", "core.hooksPath", otherHooks);

  const head = scratch.git("rev-parse", "HEAD").trim();
  expect((await git(scratch.repo, ["update-ref", "refs/relay/test", head])).code).toBe(0);
  expect((await git(scratch.repo, ["add", "-A"], { indexFile: join(scratch.root, "tmp.index") })).code).toBe(0);
  expect(markers.filter((marker) => existsSync(marker))).toEqual([]);
});

test("hooks defined in configuration (hook.<name>.command) never run", async () => {
  const transaction = markerScript("config-hook-reference-transaction");
  const indexChange = markerScript("config-hook-post-index-change");
  scratch.git("config", "hook.planted-ref.command", transaction.script);
  scratch.git("config", "hook.planted-ref.event", "reference-transaction");
  scratch.git("config", "hook.planted-index.command", indexChange.script);
  scratch.git("config", "hook.planted-index.event", "post-index-change");
  // Without relay's runner, git 2.54 and newer run them even with core.hooksPath=/dev/null.
  plainGit(["-c", "core.hooksPath=/dev/null", "update-ref", "refs/relay/control", "HEAD"]);
  plainGit(["-c", "core.hooksPath=/dev/null", "add", "-A"], { GIT_INDEX_FILE: join(scratch.root, "control.index") });
  const version = scratch.git("version").trim();
  if (!/^git version 2\.([0-4]\d|5[0-3])\./.test(version)) {
    expect(existsSync(transaction.marker)).toBe(true);
    expect(existsSync(indexChange.marker)).toBe(true);
  }
  removeMarker(transaction.marker);
  removeMarker(indexChange.marker);

  const head = scratch.git("rev-parse", "HEAD").trim();
  expect((await git(scratch.repo, ["update-ref", "refs/relay/test", head])).code).toBe(0);
  expect((await git(scratch.repo, ["add", "-A"], { indexFile: join(scratch.root, "tmp.index") })).code).toBe(0);
  expect(existsSync(transaction.marker)).toBe(false);
  expect(existsSync(indexChange.marker)).toBe(false);
});

test("protocol.<name>.allow in the repository cannot open a transport for a lazy fetch", async () => {
  const { marker } = markerScript("ext-transport");
  scratch.git("config", "core.repositoryformatversion", "1");
  scratch.git("config", "extensions.partialClone", "origin");
  scratch.git("config", "remote.origin.url", `ext::sh -c touch% ${marker}`);
  scratch.git("config", "remote.origin.promisor", "true");
  scratch.git("config", "protocol.ext.allow", "always");
  scratch.git("config", "protocol.allow", "always");
  const missing = "1234567890123456789012345678901234567890";
  plainGit(["cat-file", "-p", missing]);
  expect(existsSync(marker)).toBe(true);
  removeMarker(marker);

  const result = await git(scratch.repo, ["cat-file", "-p", missing]);
  expect(result.code).not.toBe(0);
  expect(existsSync(marker)).toBe(false);
  await expectRefusedWithoutSpawn(["archive", `--remote=ext::sh -c touch% ${marker}`, "HEAD"]);
});

test("an alias is never run, because only git's own commands are allowed", async () => {
  const { script, marker } = markerScript("alias");
  scratch.git("config", "alias.st", `!${script}`);
  plainGit(["st"]);
  expect(existsSync(marker)).toBe(true);
  removeMarker(marker);
  await expectRefusedWithoutSpawn(["st"]);
  expect(existsSync(marker)).toBe(false);
});

test("standard input is closed unless the caller passes input", async () => {
  const { result, spawns } = await spySpawn(() => git(scratch.repo, ["hash-object", "--stdin"]));
  expect(spawns[0]!.options.stdin).toBe("ignore");
  expect(decode(result.stdout)).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n");

  const withInput = await git(scratch.repo, ["hash-object", "--stdin"], { input: "hello\n" });
  expect(decode(withInput.stdout)).toBe("ce013625030ba8dba906f756967f9e9ca394464a\n");
});

test.each([
  ["reset", "--hard"], ["clean", "-fdx"], ["checkout", "--", "."], ["switch", "feature"], ["restore", "."],
  ["stash", "push"], ["rebase", "feature"], ["commit", "-m", "x"], ["merge", "feature"], ["push"], ["fetch"],
  ["pull"], ["rm", "README.md"], ["mv", "README.md", "x"], ["gc"], ["worktree", "remove", "x"],
  ["worktree", "add", "-f", "-B", "feature", "../x"], ["worktree", "move", "a", "b"], ["worktree", "prune"],
  ["maintenance", "register"], ["sparse-checkout", "set", "src"], ["fast-import"], ["merge-file", "a", "b", "c"],
  ["branch", "-f", "main", "feature"], ["tag", "-d", "v1"], ["reflog", "expire", "--all"], ["ls-remote", "origin"],
  ["archive", "HEAD"], ["hook", "run", "pre-commit"], ["help", "git"], ["init"], ["notes", "add"],
  ["ls-tree", "HEAD"], ["constructor"], ["__proto__"],
].map((args) => [args]))("%p is not an allowed command and starts no process", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test.each([
  [["-c", "core.hooksPath=/tmp/evil", "status"]],
  [["-C", "/", "status"]],
  [["--git-dir=/tmp/other", "status"]],
  [["--exec-path=/tmp/evil", "status"]],
  [["Status"]],
  [[]],
])("a leading option or a strange command name is refused: %p", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test.each([
  ["config", "user.email", "x@example.com"], ["config", "core.fsmonitor", "/tmp/evil"], ["config", "--add", "a.b", "c"],
  ["config", "--unset", "user.email"], ["config", "--replace-all", "a.b", "c"], ["config", "set", "a.b", "c"],
  ["config", "--edit"], ["config", "--get"], ["config", "--list", "--get", "a.b"], ["config", "--rename-section", "a", "b"],
].map((args) => [args]))("git config only reads: %p is refused", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test("git config reads values, lists and files", async () => {
  scratch.git("config", "user.email", "test@example.com");
  expect(decode((await git(scratch.repo, ["config", "--get", "user.email"])).stdout)).toBe("test@example.com\n");
  expect((await git(scratch.repo, ["config", "--list", "--show-origin", "--show-scope", "-z"])).code).toBe(0);
  const file = join(scratch.repo, ".git", "config");
  expect(decode((await git(scratch.repo, ["config", "--file", file, "--list", "--name-only", "-z"])).stdout)).toContain("user.email\0");
});

test.each([
  ["symbolic-ref", "HEAD", "refs/heads/feature"], ["symbolic-ref", "-d", "HEAD"], ["symbolic-ref", "--delete", "HEAD"],
  ["symbolic-ref", "--del", "HEAD"], ["symbolic-ref", "-qd", "HEAD"], ["symbolic-ref", "-m", "x", "HEAD", "refs/heads/feature"],
  ["symbolic-ref", "refs/heads/main"], ["symbolic-ref", "--short"],
].map((args) => [args]))("symbolic-ref other than reading HEAD is refused: %p", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test("--text, which forces a text patch, is allowed for diff-tree although it begins --textconv", async () => {
  const calls = watchGitCalls();
  const result = await git(scratch.repo, ["diff-tree", "--text", "-p", "HEAD~1", "HEAD"]);
  calls.stop();
  expect(result.code).toBe(0);
  expect(calls.calls[0]!.slice(PREFIX.length)).toEqual(["diff-tree", "--no-ext-diff", "--no-textconv", "--text", "-p", "HEAD~1", "HEAD"]);
});

test("symbolic-ref reads HEAD", async () => {
  expect(decode((await git(scratch.repo, ["symbolic-ref", "-q", "--short", "HEAD"])).stdout)).toBe("main\n");
  expect(decode((await git(scratch.repo, ["symbolic-ref", "-q", "HEAD"])).stdout)).toBe("refs/heads/main\n");
  expect(decode((await git(scratch.repo, ["symbolic-ref", "HEAD"])).stdout)).toBe("refs/heads/main\n");
});

test.each([
  ["diff", "--ext-diff"], ["diff", "--ext"], ["diff", "--textconv"], ["diff", "--textc"], ["diff", "--tex"], ["diff", "--output=/tmp/x"],
  ["diff", "--out=/tmp/x"], ["log", "--show-signature"], ["log", "--show-sig"], ["show", "--textconv", "HEAD"],
  ["diff-tree", "--ext-diff", "-p", "HEAD"], ["cat-file", "--textconv", "HEAD:README.md"], ["cat-file", "--filters", "HEAD:README.md"],
  ["cat-file", "--filt", "HEAD:README.md"], ["rev-list", "--show-signature", "HEAD"], ["for-each-ref", "--format=%(signature)"],
  ["version", "--build-options"], ["hash-object", "--path", "x", "README.md"], ["commit-tree", "-S", "HEAD^{tree}"],
  ["commit-tree", "--gpg-sign", "HEAD^{tree}"], ["commit-tree", "-F", "/etc/passwd", "HEAD^{tree}"],
  ["rev-list", "--output=.git/index", "HEAD"], ["rev-list", "--outp=.git/index", "HEAD"], ["status", "--output=x"],
  ["ls-files", "--output", "x"], ["cat-file", "--output=x", "-p", "HEAD"], ["rev-parse", "--output=x", "HEAD"],
].map((args) => [args]))("an option that starts a program or writes a file is refused: %p", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test.each([
  ["add", "-A"], ["read-tree", "HEAD"], ["update-index", "--refresh"], ["write-tree"], ["checkout-index", "-a", "-f"],
].map((args) => [args]))("%p without a temporary index is refused", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test.each([
  ["add", "-p"], ["add", "-Ap"], ["add", "--edit"], ["add", "--inter"], ["read-tree", "-u", "-m", "HEAD"],
  ["read-tree", "HEAD", "feature"], ["write-tree", "--prefix=src/"], ["checkout-index", "--prefix=/tmp/out/", "-a"],
  ["checkout-index", "--temp", "-a"], ["update-index", "--chmod=+x", "README.md"],
].map((args) => [args]))("an index command with options relay does not use is refused: %p", async (args) => {
  await expectRefusedWithoutSpawn(args, { indexFile: join(scratch.root, "tmp.index") });
});

test("a temporary index is used and the person's index stays the same", async () => {
  const before = captureState(scratch.repo);
  const tmpIndex = join(scratch.root, "tmp.index");
  expect((await git(scratch.repo, ["add", "-A"], { indexFile: tmpIndex })).code).toBe(0);
  const tree = await git(scratch.repo, ["write-tree"], { indexFile: tmpIndex });
  expect(tree.code).toBe(0);
  expect(scratch.git("ls-tree", "-r", "--name-only", decode(tree.stdout).trim())).toContain("notes.txt\n");
  expect(captureState(scratch.repo)).toEqual(before);
});

test.each([
  [["update-ref", "refs/heads/main", "HEAD~1"]],
  [["update-ref", "-d", "refs/heads/feature"]],
  [["update-ref", "-m", "refs/relay/x", "refs/heads/main", "HEAD~1"]],
  [["update-ref", "HEAD", "HEAD~1"]],
  [["update-ref", "refs/relay/../heads/main", "HEAD~1"]],
  [["update-ref", "refs/relayed/x", "HEAD"]],
  [["update-ref", "-z", "--stdin"]],
  [["update-ref", "--stdin", "refs/relay/x"]],
  [["update-ref"]],
])("update-ref outside refs/relay/ is refused: %p", async (args) => {
  await expectRefusedWithoutSpawn(args);
});

test.each([
  "update refs/heads/main 0000000000000000000000000000000000000000\n",
  "start\ncreate refs/relay/jobs/a/latest abc\nupdate refs/heads/main abc\nprepare\ncommit\n",
  'update "refs/heads/main" abc\n',
  "update  refs/heads/main abc\n",
  "symref-update refs/relay/x refs/heads/main\n",
  "option no-deref\n",
  "delete refs/stash\n",
])("update-ref --stdin with a line outside refs/relay/ is refused: %p", async (input) => {
  await expectRefusedWithoutSpawn(["update-ref", "--stdin"], { input });
});

test("update-ref writes under refs/relay/ in a transaction", async () => {
  const before = captureState(scratch.repo);
  const head = scratch.git("rev-parse", "HEAD").trim();
  const input = `start\ncreate refs/relay/jobs/3f9a2c1d/checkpoints/1 ${head}\ncreate refs/relay/jobs/3f9a2c1d/latest ${head}\nprepare\ncommit\n`;
  const result = await git(scratch.repo, ["update-ref", "--stdin"], { input });
  expect(result.code).toBe(0);
  expect(scratch.git("rev-parse", "refs/relay/jobs/3f9a2c1d/latest").trim()).toBe(head);
  expect(captureState(scratch.repo)).toEqual(before);
});

test("a symbolic ref planted under refs/relay/ cannot make update-ref move a branch", async () => {
  const main = scratch.git("rev-parse", "main").trim();
  const feature = scratch.git("rev-parse", "feature").trim();
  scratch.git("symbolic-ref", "refs/relay/jobs/3f9a2c1d/latest", "refs/heads/main");
  scratch.git("symbolic-ref", "refs/relay/jobs/3f9a2c1d/other", "refs/heads/main");

  const stdin = await git(scratch.repo, ["update-ref", "--stdin"], { input: `update refs/relay/jobs/3f9a2c1d/latest ${feature}\n` });
  expect(stdin.code).toBe(0);
  const plain = await git(scratch.repo, ["update-ref", "refs/relay/jobs/3f9a2c1d/other", feature]);
  expect(plain.code).toBe(0);

  expect(scratch.git("rev-parse", "main").trim()).toBe(main);
  expect(scratch.git("rev-parse", "refs/relay/jobs/3f9a2c1d/latest").trim()).toBe(feature);
  expect(scratch.git("rev-parse", "refs/relay/jobs/3f9a2c1d/other").trim()).toBe(feature);
});

test("a symbolic link at .git/refs/relay to the branch folder cannot make update-ref write a branch", async () => {
  const refs = join(scratch.repo, ".git", "refs");
  symlinkSync("heads", join(refs, "relay"));
  const main = scratch.git("rev-parse", "main").trim();
  const feature = scratch.git("rev-parse", "feature").trim();
  // Without the check, git follows the link and moves main.
  plainGit(["update-ref", "--no-deref", "refs/relay/main", feature]);
  expect(scratch.git("rev-parse", "main").trim()).toBe(feature);
  scratch.git("update-ref", "--no-deref", "refs/heads/main", main);

  const before = captureState(scratch.repo);
  await expect(git(scratch.repo, ["update-ref", "refs/relay/main", feature])).rejects.toThrow("refs/relay is a symbolic link");
  await expect(git(scratch.repo, ["update-ref", "--stdin"], { input: `create refs/relay/newbranch ${feature}\n` })).rejects.toThrow(
    "refs/relay is a symbolic link",
  );
  expect(captureState(scratch.repo)).toEqual(before);
  expect(existsSync(join(refs, "heads", "newbranch"))).toBe(false);
});

test("a symbolic link deeper under refs/relay/, or as the ref itself, is refused", async () => {
  const feature = scratch.git("rev-parse", "feature").trim();
  const relay = join(scratch.repo, ".git", "refs", "relay");
  mkdirSync(join(relay, "jobs"), { recursive: true });
  symlinkSync("../../heads", join(relay, "jobs", "3f9a2c1d"));
  await expect(git(scratch.repo, ["update-ref", "refs/relay/jobs/3f9a2c1d/main", feature])).rejects.toThrow(
    "refs/relay/jobs/3f9a2c1d is a symbolic link",
  );
  symlinkSync("../heads/main", join(relay, "latest"));
  await expect(git(scratch.repo, ["update-ref", "-d", "refs/relay/latest"])).rejects.toThrow("refs/relay/latest is a symbolic link");
  renameSync(join(scratch.repo, ".git", "refs"), join(scratch.repo, ".git", "real-refs"));
  symlinkSync("real-refs", join(scratch.repo, ".git", "refs"));
  await expect(git(scratch.repo, ["update-ref", "refs/relay/x", feature])).rejects.toThrow("refs is a symbolic link");
});

test("a symbolic link at .git/logs/refs/relay cannot make update-ref write a branch's reflog", async () => {
  const logs = join(scratch.repo, ".git", "logs", "refs");
  symlinkSync("heads", join(logs, "relay"));
  const mainLog = join(logs, "heads", "main");
  const head = scratch.git("rev-parse", "HEAD").trim();
  // Without the runner, git writes through the link into main's reflog.
  const original = readFileSync(mainLog);
  plainGit(["update-ref", "--no-deref", "--create-reflog", "refs/relay/main", head]);
  expect(readFileSync(mainLog)).not.toEqual(original);
  writeFileSync(mainLog, original);
  scratch.git("update-ref", "-d", "refs/relay/main");

  const before = captureState(scratch.repo);
  await expectRefusedWithoutSpawn(["update-ref", "--create-reflog", "refs/relay/main", head]);
  await expect(git(scratch.repo, ["update-ref", "refs/relay/main", head])).rejects.toThrow("logs/refs/relay is a symbolic link");
  expect(captureState(scratch.repo)).toEqual(before);
});

test("a planted reflog under logs/refs/relay, hard-linked to an index copy or a branch reflog, is refused and not written", async () => {
  const git_ = join(scratch.repo, ".git");
  const head = scratch.git("rev-parse", "HEAD").trim();
  const relayLogs = join(git_, "logs", "refs", "relay");
  mkdirSync(relayLogs, { recursive: true });
  // Without the runner, git appends to a reflog that exists, even with core.logAllRefUpdates=false.
  const controlTarget = join(scratch.root, "control-target");
  writeFileSync(controlTarget, "");
  linkSync(controlTarget, join(relayLogs, "control"));
  plainGit(["-c", "core.logAllRefUpdates=false", "update-ref", "--no-deref", "refs/relay/control", head]);
  expect(readFileSync(controlTarget, "utf8")).not.toBe("");
  Bun.spawnSync(["rm", join(relayLogs, "control")]);
  scratch.git("update-ref", "-d", "refs/relay/control");

  const indexCopy = join(scratch.root, "index-copy");
  copyFileSync(join(git_, "index"), indexCopy);
  linkSync(indexCopy, join(relayLogs, "main"));
  linkSync(join(git_, "logs", "refs", "heads", "feature"), join(relayLogs, "feature"));
  const indexBytes = readFileSync(indexCopy);
  const before = captureState(scratch.repo);

  await expect(git(scratch.repo, ["update-ref", "refs/relay/main", head])).rejects.toThrow(
    "logs/refs/relay/main has more than one hard link",
  );
  await expect(git(scratch.repo, ["update-ref", "--stdin"], { input: `create refs/relay/feature ${head}\n` })).rejects.toThrow(
    "logs/refs/relay/feature has more than one hard link",
  );
  expect(readFileSync(indexCopy)).toEqual(indexBytes);
  expect(captureState(scratch.repo)).toEqual(before);
});

test("an existing reflog for a relay ref, even a plain file, is refused", async () => {
  const head = scratch.git("rev-parse", "HEAD").trim();
  const relayLogs = join(scratch.repo, ".git", "logs", "refs", "relay", "jobs");
  mkdirSync(relayLogs, { recursive: true });
  writeFileSync(join(relayLogs, "latest"), "");
  await expect(git(scratch.repo, ["update-ref", "refs/relay/jobs/latest", head])).rejects.toThrow(
    "logs/refs/relay/jobs/latest exists, but relay never keeps a reflog for its refs",
  );
  expect(readFileSync(join(relayLogs, "latest"), "utf8")).toBe("");
});

test("a ref file under refs/relay with a second hard link is refused", async () => {
  const head = scratch.git("rev-parse", "HEAD").trim();
  scratch.git("update-ref", "refs/relay/linked", head);
  linkSync(join(scratch.repo, ".git", "refs", "relay", "linked"), join(scratch.root, "outside-link"));
  await expect(git(scratch.repo, ["update-ref", "refs/relay/linked", scratch.git("rev-parse", "feature").trim()])).rejects.toThrow(
    "refs/relay/linked has more than one hard link",
  );
  expect(scratch.git("rev-parse", "refs/relay/linked").trim()).toBe(head);
});

test("core.logAllRefUpdates=always in the repository writes no reflog for relay's refs", async () => {
  scratch.git("config", "core.logAllRefUpdates", "always");
  const head = scratch.git("rev-parse", "HEAD").trim();
  plainGit(["update-ref", "--no-deref", "refs/relay/control", head]);
  expect(existsSync(join(scratch.repo, ".git", "logs", "refs", "relay", "control"))).toBe(true);
  Bun.spawnSync(["rm", "-rf", join(scratch.repo, ".git", "logs", "refs", "relay")]);

  const before = captureState(scratch.repo);
  expect((await git(scratch.repo, ["update-ref", "refs/relay/jobs/3f9a2c1d/latest", head])).code).toBe(0);
  expect(existsSync(join(scratch.repo, ".git", "logs", "refs", "relay"))).toBe(false);
  expect(captureState(scratch.repo)).toEqual(before);
});

test("core.splitIndex=true in the repository writes no shared index file into .git", async () => {
  scratch.git("config", "core.splitIndex", "true");
  const sharedIndexes = () => readdirSync(join(scratch.repo, ".git")).filter((name) => name.startsWith("sharedindex."));
  plainGit(["add", "-A"], { GIT_INDEX_FILE: join(scratch.root, "control.index") });
  const written = sharedIndexes();
  expect(written.length).toBeGreaterThan(0);
  for (const name of written) Bun.spawnSync(["rm", join(scratch.repo, ".git", name)]);

  expect((await git(scratch.repo, ["add", "-A"], { indexFile: join(scratch.root, "tmp.index") })).code).toBe(0);
  expect(sharedIndexes()).toEqual([]);
  expect(readdirSync(scratch.root).filter((name) => name.startsWith("sharedindex."))).toEqual([]);
});

test("commit-tree never signs and takes the identity it is given", async () => {
  // git 2.34 to 2.39 sign commit-tree commits when commit.gpgSign is true; newer versions do not.
  const { script, marker } = markerScript("gpg");
  scratch.git("config", "commit.gpgSign", "true");
  scratch.git("config", "gpg.program", script);

  const parent = scratch.git("rev-parse", "HEAD").trim();
  const result = await git(scratch.repo, ["commit-tree", "-p", parent, "--no-gpg-sign", "HEAD^{tree}"], {
    input: "relay checkpoint 1\n",
    identity: { name: "relay", email: "relay@localhost" },
  });
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  const commit = scratch.git("cat-file", "commit", decode(result.stdout).trim());
  expect(commit).toContain(`\nparent ${parent}\n`);
  expect(commit).toContain("\nauthor relay <relay@localhost> ");
  expect(commit).toContain("\ncommitter relay <relay@localhost> ");
  expect(commit).not.toContain("gpgsig");
});

test("a git process that runs past the time limit is stopped", async () => {
  const fakeBin = join(scratch.root, "slow-bin");
  mkdirSync(fakeBin);
  const pidFile = join(scratch.root, "slow.pid");
  const childPidFile = join(scratch.root, "slow-child.pid");
  // The fake git starts a program of its own, as git starts a filter, then waits.
  writeFileSync(
    join(fakeBin, "git"),
    `#!/bin/sh\nsleep 30 &\necho $! > '${childPidFile}'\necho $$ > '${pidFile}'\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  setParentEnv("PATH", `${fakeBin}${delimiter}${process.env.PATH}`);
  const started = Date.now();
  await expect(git(scratch.repo, ["status"], { timeoutMs: 1500 })).rejects.toThrow(
    "git status did not finish within 1.5 seconds, so relay stopped it.",
  );
  expect(Date.now() - started).toBeLessThan(5000);
  // A killed process that another parent must still reap stays visible for a moment.
  for (const file of [pidFile, childPidFile]) {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }
});

test("with RELAY_TEST_GIT_LOG=1 each call is appended to the call log", async () => {
  setParentEnv("RELAY_TEST_GIT_LOG", "1");
  await git(scratch.repo, ["status"]);
  await git(scratch.repo, ["rev-parse", "HEAD"]);
  const lines = readFileSync(join(scratch.relayHome, "logs", "git-calls.jsonl"), "utf8").trimEnd().split("\n");
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    [...PREFIX, "status"],
    [...PREFIX, "rev-parse", "HEAD"],
  ]);
});
