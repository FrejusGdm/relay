import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { openRepository, type Repository } from "../../src/git/repo";
import { watchGitCalls } from "../../src/git/run";
import { compareTrust, recordTrust, TrustRecordError, trustReport } from "../../src/git/trust";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

let scratch: ScratchRepo;
let repo: Repository;
let jobDir: string;
let gitDir: string;

beforeEach(async () => {
  scratch = makeScratchRepo();
  repo = await openRepository(scratch.repo);
  jobDir = join(scratch.relayHome, "jobs", "3f9a2c1d");
  gitDir = join(scratch.repo, ".git");
});
afterEach(() => scratch.cleanup());

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function readRecord(): Record<string, any> {
  return JSON.parse(readFileSync(join(jobDir, "git-trust.json"), "utf8"));
}

function writeHook(name: string, text = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(join(gitDir, "hooks", name), text, { mode: 0o755 });
}

test("records the repository config, info/attributes and every hook, with private modes", async () => {
  writeHook("pre-commit");
  await recordTrust(repo, jobDir);

  expect(statSync(jobDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(jobDir, "git-trust.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(jobDir)).toEqual(["git-trust.json"]);

  const record = readRecord();
  expect(record.schema_version).toBe(1);
  expect(record.job_id).toBe("3f9a2c1d");
  expect(record.worktree_root).toBe(scratch.repo);
  expect(Number.isNaN(Date.parse(record.recorded_at))).toBe(false);

  const config = record.config_files.find((file: { path: string }) => file.path === join(gitDir, "config"));
  expect(config.scope).toBe("local");
  expect(config.sha256).toBe(sha256(readFileSync(join(gitDir, "config"))));
  expect(config.keys.map((key: { name: string }) => key.name)).toEqual(expect.arrayContaining(["core.bare", "core.filemode", "core.repositoryformatversion"]));
  expect(config.keys.find((key: { name: string }) => key.name === "core.bare")).toEqual({
    name: "core.bare",
    count: 1,
    values_hmac: createHmac("sha256", Buffer.from(record.values_salt, "hex")).update(JSON.stringify(["false"])).digest("hex"),
  });
  expect(record.values_salt).toMatch(/^[0-9a-f]{64}$/);
  expect(record.attributes_file).toEqual({ path: join(gitDir, "info", "attributes"), sha256: null });

  const hookNames = readdirSync(join(gitDir, "hooks")).sort();
  expect(hookNames).toContain("pre-commit");
  expect(record.hooks.dir).toBe(join(gitDir, "hooks"));
  expect(record.hooks.entries.map((entry: { name: string }) => entry.name)).toEqual(hookNames);
  expect(record.hooks.entries.find((entry: { name: string }) => entry.name === "pre-commit")).toEqual({
    name: "pre-commit",
    mode: "100755",
    sha256: sha256("#!/bin/sh\nexit 0\n"),
  });
  expect(record.hooks_path).toBeNull();
});

test("records the content hash of an existing info/attributes file", async () => {
  writeFileSync(join(gitDir, "info", "attributes"), "*.bin binary\n");
  await recordTrust(repo, jobDir);
  expect(readRecord().attributes_file.sha256).toBe(sha256("*.bin binary\n"));
});

test("stores key names but no values, and hides credentials in key names", async () => {
  scratch.git("remote", "add", "origin", "https://user:token123@example.com/repo.git");
  scratch.git("config", "url.https://user:token456@example.com/.insteadOf", "https://example.com/");
  scratch.git("config", "url.https://example.com/?access_token=token789#frag-token000.insteadOf", "https://other.example/");
  await recordTrust(repo, jobDir);
  const text = readFileSync(join(jobDir, "git-trust.json"), "utf8");
  expect(text).toContain('"remote.origin.url"');
  expect(text).toContain('"url.https://***@example.com/.insteadof"');
  expect(text).not.toContain("token123");
  expect(text).not.toContain("token456");
  expect(text).not.toContain("token789");
  expect(text).not.toContain("token000");
  expect(text).toContain('"url.https://example.com/?***.insteadof"');
  expect(text).not.toContain("example.com/repo.git");
});

test("an unchanged repository compares equal", async () => {
  await recordTrust(repo, jobDir);
  expect(await compareTrust(repo, jobDir)).toEqual([]);
});

test("the comparison runs only git config and git rev-parse", async () => {
  await recordTrust(repo, jobDir);
  const watch = watchGitCalls();
  await compareTrust(repo, jobDir);
  watch.stop();
  // Each call is git, then -c <setting> pairs, then the command.
  const commands = watch.calls.map((argv) => {
    let i = 1;
    while (argv[i] === "-c") i += 2;
    return argv[i];
  });
  expect(new Set(commands)).toEqual(new Set(["config", "rev-parse"]));
});

test("an added core.fsmonitor key is detected and marked as able to run commands", async () => {
  await recordTrust(repo, jobDir);
  scratch.git("config", "core.fsmonitor", "touch /tmp/pwned");
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "config", path: join(gitDir, "config"), addedKeys: ["core.fsmonitor"], removedKeys: [], changedKeys: [] }]);
  expect(trustReport(changes, repo)[1]).toBe("  added  core.fsmonitor (can run commands)");
});

test("a removed key is detected", async () => {
  scratch.git("config", "alias.st", "status");
  await recordTrust(repo, jobDir);
  scratch.git("config", "--unset", "alias.st");
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "config", path: join(gitDir, "config"), addedKeys: [], removedKeys: ["alias.st"], changedKeys: [] }]);
  expect(trustReport(changes, repo)[1]).toBe("  removed  alias.st (can run commands)");
});

test("a changed value is detected without naming the value", async () => {
  scratch.git("remote", "add", "origin", "https://example.com/repo.git");
  await recordTrust(repo, jobDir);
  scratch.git("remote", "set-url", "origin", "https://example.com/other.git");
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "config", path: join(gitDir, "config"), addedKeys: [], removedKeys: [], changedKeys: ["remote.origin.url"] }]);
  expect(trustReport(changes, repo)[1]).toBe("  changed  remote.origin.url");
  expect(readFileSync(join(jobDir, "git-trust.json"), "utf8")).not.toContain("example.com/repo.git");
});

test("an added key does not hide a changed value", async () => {
  scratch.git("config", "core.fsmonitor", "false");
  await recordTrust(repo, jobDir);
  scratch.git("config", "core.fsmonitor", "touch /tmp/pwned");
  scratch.git("config", "user.name", "Someone");
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "config", path: join(gitDir, "config"), addedKeys: ["user.name"], removedKeys: [], changedKeys: ["core.fsmonitor"] }]);
  expect(trustReport(changes, repo).slice(1, 3)).toEqual(["  added  user.name", "  changed  core.fsmonitor (can run commands)"]);
});

test("a second value for an existing key is a change", async () => {
  scratch.git("config", "credential.helper", "store");
  await recordTrust(repo, jobDir);
  scratch.git("config", "--add", "credential.helper", "!touch /tmp/pwned");
  expect((await compareTrust(repo, jobDir))[0]).toMatchObject({ changedKeys: ["credential.helper"] });
});

test("a change of comments or spacing only is reported without keys", async () => {
  await recordTrust(repo, jobDir);
  writeFileSync(join(gitDir, "config"), readFileSync(join(gitDir, "config"), "utf8") + "# a comment\n");
  const changes = await compareTrust(repo, jobDir);
  expect(trustReport(changes, repo)[1]).toBe("  changed comments, spacing or the order of settings");
});

test("an added hook is detected", async () => {
  await recordTrust(repo, jobDir);
  writeHook("pre-commit");
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "hook", path: join(gitDir, "hooks", "pre-commit"), change: "added" }]);
});

test("a changed hook, a changed file mode and a removed hook are detected", async () => {
  writeHook("pre-commit");
  writeHook("post-checkout");
  writeHook("pre-push");
  await recordTrust(repo, jobDir);
  writeHook("pre-commit", "#!/bin/sh\ntouch /tmp/pwned\n");
  chmodSync(join(gitDir, "hooks", "post-checkout"), 0o644);
  rmSync(join(gitDir, "hooks", "pre-push"));
  expect(await compareTrust(repo, jobDir)).toEqual([
    { kind: "hook", path: join(gitDir, "hooks", "post-checkout"), change: "changed" },
    { kind: "hook", path: join(gitDir, "hooks", "pre-commit"), change: "changed" },
    { kind: "hook", path: join(gitDir, "hooks", "pre-push"), change: "removed" },
  ]);
});

test("a hook that is a symbolic link is recorded by its target", async () => {
  symlinkSync(join(scratch.root, "first.sh"), join(gitDir, "hooks", "pre-commit"));
  await recordTrust(repo, jobDir);
  const entry = readRecord().hooks.entries.find((hook: { name: string }) => hook.name === "pre-commit");
  expect(entry.mode).toMatch(/^120[0-7]{3}$/);
  expect(entry.sha256).toBe(sha256(join(scratch.root, "first.sh")));
  rmSync(join(gitDir, "hooks", "pre-commit"));
  symlinkSync(join(scratch.root, "second.sh"), join(gitDir, "hooks", "pre-commit"));
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "hook", path: join(gitDir, "hooks", "pre-commit"), change: "changed" }]);
});

test("a created info/attributes file is detected", async () => {
  await recordTrust(repo, jobDir);
  writeFileSync(join(gitDir, "info", "attributes"), "* filter=planted\n");
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "attributes", path: join(gitDir, "info", "attributes") }]);
});

test("a changed ~/.gitconfig under the test HOME is detected", async () => {
  const globalConfig = join(scratch.home, ".gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Test Person\n");
  await recordTrust(repo, jobDir);
  expect(readRecord().config_files).toContainEqual({
    path: globalConfig,
    scope: "global",
    sha256: sha256(readFileSync(globalConfig)),
    keys: [{ name: "user.name", count: 1, values_hmac: expect.stringMatching(/^[0-9a-f]{64}$/) }],
  });

  writeFileSync(globalConfig, "[user]\n\tname = Test Person\n[core]\n\tpager = less\n");
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "config", path: globalConfig, addedKeys: ["core.pager"], removedKeys: [], changedKeys: [] }]);
  expect(trustReport(changes, repo).slice(0, 2)).toEqual([
    "Stopped: ~/.gitconfig changed since this job started.",
    "  added  core.pager (can run commands)",
  ]);
});

test("a ~/.gitconfig created after the record is detected", async () => {
  await recordTrust(repo, jobDir);
  writeFileSync(join(scratch.home, ".gitconfig"), "[alias]\n\tst = status\n");
  expect(await compareTrust(repo, jobDir)).toEqual([
    { kind: "config", path: join(scratch.home, ".gitconfig"), addedKeys: ["alias.st"], removedKeys: [], changedKeys: [] },
  ]);
});

test("a file included from the repository config is recorded and checked", async () => {
  const included = join(scratch.root, "extra.inc");
  writeFileSync(included, "[user]\n\tname = Test Person\n");
  scratch.git("config", "include.path", included);
  await recordTrust(repo, jobDir);
  expect(readRecord().config_files.map((file: { path: string }) => file.path)).toContain(included);

  writeFileSync(included, "[user]\n\tname = Test Person\n[filter \"x\"]\n\tclean = touch /tmp/pwned\n");
  expect(await compareTrust(repo, jobDir)).toEqual([
    { kind: "config", path: included, addedKeys: ["filter.x.clean"], removedKeys: [], changedKeys: [] },
  ]);
});

test("a hooks folder named by core.hooksPath outside the worktree is recorded and checked", async () => {
  const hooksFolder = join(scratch.root, "shared-hooks");
  mkdirSync(hooksFolder);
  writeFileSync(join(hooksFolder, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  scratch.git("config", "core.hooksPath", hooksFolder);
  await recordTrust(repo, jobDir);
  expect(readRecord().hooks_path).toEqual({
    dir: hooksFolder,
    entries: [{ name: "pre-commit", mode: "100755", sha256: sha256("#!/bin/sh\n") }],
  });

  writeFileSync(join(hooksFolder, "post-checkout"), "#!/bin/sh\n", { mode: 0o755 });
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([{ kind: "hook", path: join(hooksFolder, "post-checkout"), change: "added" }]);
  expect(trustReport(changes, repo).slice(0, 2)).toEqual([
    "Stopped: the git hooks changed since this job started.",
    `  added  ${join(hooksFolder, "post-checkout")}`,
  ]);
});

test("a hooks folder inside the worktree's own files is left to the checkpoints", async () => {
  mkdirSync(join(scratch.repo, ".husky"));
  scratch.git("config", "core.hooksPath", ".husky");
  await recordTrust(repo, jobDir);
  expect(readRecord().hooks_path).toBeNull();
});

test("a linked worktree records the shared config, attributes and hooks", async () => {
  const linked = join(scratch.root, "linked");
  scratch.git("worktree", "add", "-q", "-b", "other", linked);
  const linkedRepo = await openRepository(linked);
  await recordTrust(linkedRepo, jobDir);
  const record = readRecord();
  expect(record.config_files.map((file: { path: string }) => file.path)).toContain(join(gitDir, "config"));
  expect(record.attributes_file.path).toBe(join(gitDir, "info", "attributes"));
  expect(record.hooks.dir).toBe(join(gitDir, "hooks"));

  writeHook("pre-commit");
  expect(await compareTrust(linkedRepo, jobDir)).toEqual([{ kind: "hook", path: join(gitDir, "hooks", "pre-commit"), change: "added" }]);
});

test("config.worktree is recorded when worktree settings are on, even before it exists", async () => {
  scratch.git("config", "extensions.worktreeConfig", "true");
  await recordTrust(repo, jobDir);
  const worktreeConfig = join(gitDir, "config.worktree");
  expect(readRecord().config_files).toContainEqual({ path: worktreeConfig, scope: "worktree", sha256: null, keys: [] });
  scratch.git("config", "--worktree", "core.editor", "vi");
  expect(await compareTrust(repo, jobDir)).toEqual([
    { kind: "config", path: worktreeConfig, addedKeys: ["core.editor"], removedKeys: [], changedKeys: [] },
  ]);
});

test("a reverted change compares equal again", async () => {
  await recordTrust(repo, jobDir);
  const configPath = join(gitDir, "config");
  const original = readFileSync(configPath);
  scratch.git("config", "core.fsmonitor", "touch /tmp/pwned");
  writeHook("pre-commit");
  writeFileSync(join(gitDir, "info", "attributes"), "* filter=planted\n");
  expect(await compareTrust(repo, jobDir)).toHaveLength(3);

  writeFileSync(configPath, original);
  rmSync(join(gitDir, "hooks", "pre-commit"));
  rmSync(join(gitDir, "info", "attributes"));
  expect(await compareTrust(repo, jobDir)).toEqual([]);
});

test("a missing or damaged trust record stops the comparison", async () => {
  const file = join(jobDir, "git-trust.json");
  await expect(compareTrust(repo, jobDir)).rejects.toThrow(new TrustRecordError("missing", file));
  await expect(compareTrust(repo, jobDir)).rejects.toThrow(`The git trust record ${file} is missing.`);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(file, '{"schema_version":2}');
  await expect(compareTrust(repo, jobDir)).rejects.toThrow(`The git trust record ${file} is damaged.`);
  writeFileSync(file, "not json");
  await expect(compareTrust(repo, jobDir)).rejects.toBeInstanceOf(TrustRecordError);
});

test("a record whose elements lack fields is damaged", async () => {
  await recordTrust(repo, jobDir);
  const file = join(jobDir, "git-trust.json");
  const good = readFileSync(file, "utf8");
  const breakages: ((record: Record<string, any>) => void)[] = [
    (record) => { record.config_files[0].keys[0].count = "1"; },
    (record) => { delete record.config_files[0].keys[0].values_hmac; },
    (record) => { record.config_files[0].sha256 = 7; },
    (record) => { record.config_files.push(null); },
    (record) => { delete record.hooks.entries[0].mode; },
    (record) => { record.hooks_path = { dir: "/x" }; },
    (record) => { delete record.attributes_file.path; },
    (record) => { record.values_salt = "short"; },
  ];
  for (const breakIt of breakages) {
    const record = JSON.parse(good);
    breakIt(record);
    writeFileSync(file, JSON.stringify(record));
    const error = await compareTrust(repo, jobDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrustRecordError);
    expect((error as TrustRecordError).problem).toBe("damaged");
  }
});

test("recording again replaces the record", async () => {
  await recordTrust(repo, jobDir);
  writeHook("pre-commit");
  expect(await compareTrust(repo, jobDir)).toHaveLength(1);
  await recordTrust(repo, jobDir);
  expect(await compareTrust(repo, jobDir)).toEqual([]);
  expect(statSync(join(jobDir, "git-trust.json")).mode & 0o777).toBe(0o600);
});

test("a hook gaining only the owner's execute bit is a change", async () => {
  writeHook("pre-commit");
  chmodSync(join(gitDir, "hooks", "pre-commit"), 0o655);
  await recordTrust(repo, jobDir);
  chmodSync(join(gitDir, "hooks", "pre-commit"), 0o755);
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "hook", path: join(gitDir, "hooks", "pre-commit"), change: "changed" }]);
});

test("names with control characters are printed visibly", async () => {
  await recordTrust(repo, jobDir);
  writeFileSync(join(gitDir, "config"), readFileSync(join(gitDir, "config"), "utf8") + '[filter "\x1b[8m"]\n\tclean = touch /tmp/pwned\n');
  const forged = "\x1b[1A\x1b[2K\rpost-checkout\u200b";
  writeHook(forged);
  const lines = trustReport(await compareTrust(repo, jobDir), repo);
  expect(lines).toContain("  added  filter.\\x1B[8m.clean (can run commands)");
  expect(lines).toContain("  added  \\x1B[1A\\x1B[2K\\x0Dpost-checkout\\u{200B}");
  for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B]/);
});

test("keys that can start programs or move the working tree are marked", async () => {
  await recordTrust(repo, jobDir);
  const keys: [string, string][] = [
    ["hook.lint.command", "x"], ["credential.https://example.com.helper", "x"], ["pager.status", "x"],
    ["core.gitProxy", "x"], ["core.alternateRefsCommand", "x"], ["gpg.ssh.defaultKeyCommand", "x"],
    ["trailer.sign.command", "x"], ["remote.origin.uploadpack", "x"], ["remote.origin.vcs", "x"],
    ["submodule.lib.update", "!x"], ["interactive.diffFilter", "x"], ["gc.recentObjectsHook", "x"],
    ["tar.tgz.command", "x"], ["imap.tunnel", "x"], ["sendemail.toCmd", "x"], ["sendemail.smtpServer", "/bin/x"],
    ["diff.tool", "x"], ["merge.guitool", "x"], ["difftool.x.cmd", "x"], ["mergetool.x.path", "x"],
    ["guitool.x.cmd", "x"], ["browser.x.cmd", "x"], ["man.viewer", "x"], ["man.x.path", "x"],
    ["web.browser", "x"], ["help.browser", "x"], ["instaweb.httpd", "x"],
  ];
  for (const [key, value] of keys) scratch.git("config", key, value);
  scratch.git("config", "core.worktree", scratch.repo);
  const lines = trustReport(await compareTrust(repo, jobDir), repo);
  const added = lines.filter((line) => line.startsWith("  added  "));
  expect(added).toHaveLength(keys.length + 1);
  expect(added.filter((line) => line.endsWith(" (can run commands)"))).toHaveLength(keys.length);
  expect(added).toContain("  added  core.worktree (changes where git writes files)");
});

test("a pipe in place of info/attributes is refused without waiting", async () => {
  await recordTrust(repo, jobDir);
  const attributes = join(gitDir, "info", "attributes");
  expect(Bun.spawnSync(["mkfifo", attributes]).exitCode).toBe(0);
  await expect(compareTrust(repo, jobDir)).rejects.toThrow(`relay will not read ${attributes}: it is not a regular file`);
});

test("a core.hooksPath starting with ~/ is read from the home folder", async () => {
  const hooksFolder = join(scratch.home, "my-hooks");
  mkdirSync(hooksFolder);
  scratch.git("config", "core.hooksPath", "~/my-hooks");
  await recordTrust(repo, jobDir);
  expect(readRecord().hooks_path).toEqual({ dir: hooksFolder, entries: [] });
  writeFileSync(join(hooksFolder, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "hook", path: join(hooksFolder, "pre-commit"), change: "added" }]);
});

test("a file included a second time on another branch is a change, though no bytes changed", async () => {
  const included = join(scratch.root, "p.inc");
  writeFileSync(included, '[filter "x"]\n\tclean = cat\n');
  writeFileSync(join(gitDir, "config"), readFileSync(join(gitDir, "config"), "utf8") +
    `[include]\n\tpath = ${included}\n[includeIf "onbranch:other"]\n\tpath = ${included}\n`);
  await recordTrust(repo, jobDir);
  scratch.git("switch", "-q", "-c", "other");
  expect(await compareTrust(repo, jobDir)).toEqual([
    { kind: "config", path: included, addedKeys: [], removedKeys: [], changedKeys: ["filter.x.clean"] },
  ]);
});

test("moving an include so that a shadowed value wins is reported by key", async () => {
  const included = join(scratch.root, "p.inc");
  writeFileSync(included, "[core]\n\tpager = touch /tmp/pwned\n");
  const original = readFileSync(join(gitDir, "config"), "utf8");
  writeFileSync(join(gitDir, "config"), `${original}[include]\n\tpath = ${included}\n[core]\n\tpager = cat\n`);
  await recordTrust(repo, jobDir);
  writeFileSync(join(gitDir, "config"), `${original}[core]\n\tpager = cat\n[include]\n\tpath = ${included}\n`);
  const changes = await compareTrust(repo, jobDir);
  expect(changes).toEqual([
    { kind: "config", path: join(gitDir, "config"), addedKeys: [], removedKeys: [], changedKeys: [] },
    { kind: "order", changedKeys: ["core.pager"] },
  ]);
  expect(trustReport(changes, repo).slice(0, 4)).toEqual([
    "Stopped: .git/config changed since this job started.",
    "  changed comments, spacing or the order of settings",
    "Stopped: the order in which git reads its settings changed since this job started.",
    "  changed  core.pager (can run commands)",
  ]);
});

test("a hooks folder in the project that links outside it is recorded", async () => {
  const outside = join(scratch.root, "outside-hooks");
  mkdirSync(outside);
  writeFileSync(join(outside, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(outside, join(scratch.repo, ".husky"));
  scratch.git("config", "core.hooksPath", ".husky");
  await recordTrust(repo, jobDir);
  expect(readRecord().hooks_path).toEqual({
    dir: realpathSync(outside),
    entries: [{ name: "pre-commit", mode: "100755", sha256: sha256("#!/bin/sh\n") }],
  });
  writeFileSync(join(outside, "pre-commit"), "#!/bin/sh\ntouch /tmp/pwned\n");
  expect(await compareTrust(repo, jobDir)).toEqual([{ kind: "hook", path: join(realpathSync(outside), "pre-commit"), change: "changed" }]);
});

test("a core.hooksPath starting with ~user/ is read from that user's home folder", async () => {
  const hooksFolder = join(scratch.home, "user-hooks");
  mkdirSync(hooksFolder);
  scratch.git("config", "core.hooksPath", `~${userInfo().username}/user-hooks`);
  await recordTrust(repo, jobDir);
  expect(readRecord().hooks_path).toEqual({ dir: hooksFolder, entries: [] });

  scratch.git("config", "core.hooksPath", "~no-such-user-relay/hooks");
  await expect(compareTrust(repo, jobDir)).rejects.toThrow("relay cannot find the home folder named in core.hooksPath: ~no-such-user-relay/hooks");
});

test("a pipe in place of ~/.gitconfig is refused before git runs", async () => {
  await recordTrust(repo, jobDir);
  const globalConfig = join(scratch.home, ".gitconfig");
  expect(Bun.spawnSync(["mkfifo", globalConfig]).exitCode).toBe(0);
  const watch = watchGitCalls();
  await expect(compareTrust(repo, jobDir)).rejects.toThrow(`relay will not run git here: ${globalConfig} is not a regular file`);
  watch.stop();
  expect(watch.calls).toEqual([]);
  await expect(recordTrust(repo, jobDir)).rejects.toThrow("is not a regular file");
});

test("a link planted as the temporary record file is replaced, not written through", async () => {
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const victim = join(scratch.root, "victim.txt");
  writeFileSync(victim, "keep\n", { mode: 0o644 });
  symlinkSync(victim, join(jobDir, "git-trust.json.tmp"));
  await recordTrust(repo, jobDir);
  expect(readFileSync(victim, "utf8")).toBe("keep\n");
  expect(statSync(victim).mode & 0o777).toBe(0o644);
  expect(readdirSync(jobDir)).toEqual(["git-trust.json"]);
  expect(await compareTrust(repo, jobDir)).toEqual([]);
});

test("format characters and line or paragraph separators are printed visibly", async () => {
  await recordTrust(repo, jobDir);
  const [alm, lineSep, paraSep] = [0x061c, 0x2028, 0x2029].map((code) => String.fromCodePoint(code));
  writeFileSync(join(gitDir, "config"), readFileSync(join(gitDir, "config"), "utf8") + `[alias "a${alm}b${lineSep}c"]\n\tx = y\n`);
  writeHook(`post${paraSep}checkout`);
  const lines = trustReport(await compareTrust(repo, jobDir), repo);
  expect(lines).toContain("  added  alias.a\\u{61C}b\\u{2028}c.x (can run commands)");
  expect(lines).toContain("  added  post\\u{2029}checkout");
  for (const line of lines) expect(line).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
});
