import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { openRepository, type Repository } from "../../src/git/repo";
import { watchGitCalls } from "../../src/git/run";
import { addedLines, checkGitleaks, scanCheckpoint } from "../../src/secrets/scan";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

const FAKE = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");
const FAKE_VARIABLES = ["FAKE_GITLEAKS_SLEEP", "FAKE_GITLEAKS_EXIT", "FAKE_GITLEAKS_STDERR", "FAKE_GITLEAKS_REPORT", "FAKE_GITLEAKS_VERSION", "FAKE_GITLEAKS_RECORD", "GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"];
const MISSING = "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks";

let scratch: ScratchRepo;
let repo: Repository;

beforeEach(async () => {
  scratch = makeScratchRepo("empty");
  repo = await openRepository(scratch.repo);
});
afterEach(() => {
  for (const name of [...FAKE_VARIABLES, "RELAY_GITLEAKS"]) delete process.env[name];
  scratch.cleanup();
});

function commit(files: Record<string, string | null>, message = "change"): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) scratch.git("rm", "-q", "--", path);
    else {
      scratch.write(path, text);
      scratch.git("add", "-f", "--", path);
    }
  }
  scratch.git("commit", "-q", "--allow-empty", "-m", message);
}

const tree = (rev: string) => scratch.git("rev-parse", `${rev}^{tree}`).trim();
const tmpFiles = () => (existsSync(join(scratch.relayHome, "tmp")) ? readdirSync(join(scratch.relayHome, "tmp")) : []);
// The tree of the commit before HEAD, or null when HEAD is the first commit.
function parentTree(): string | null {
  try {
    return tree("HEAD~1");
  } catch {
    return null;
  }
}
const scanHead = (message?: string, parent = parentTree()) =>
  scanCheckpoint(repo, { jobId: "3f9a2c1d", parentTree: parent, newTree: tree("HEAD"), message });

async function scanError(action: () => Promise<unknown>): Promise<CommandError> {
  const error = await action().then(() => undefined, (caught) => caught);
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

describe("with the fake scanner", () => {
  beforeEach(() => {
    process.env.RELAY_GITLEAKS = FAKE;
    process.env.FAKE_GITLEAKS_RECORD = join(scratch.root, "record.json");
  });
  const record = () => JSON.parse(readFileSync(join(scratch.root, "record.json"), "utf8"));

  test("findings map to the file and line they come from", async () => {
    commit({
      "a.txt": "FAKE-SECRET:old\none\ntwo\nthree\nfour\nfive\n",
      "b.txt": "FAKE-SECRET:deleted\n",
      ".relay/task.md": "# Task\nFAKE-SECRET:task\n",
    });
    commit({
      "a.txt": "FAKE-SECRET:old\nFAKE-SECRET:hunk-one\ntwo\nthree\nfour\nFAKE-SECRET:hunk-two\n",
      "b.txt": null,
      "tab\tname.txt": "clean\n++ FAKE-SECRET:plus\n",
      'quote"name.txt': "FAKE-SECRET:quoted\n",
      "café/new.txt": "x\ny\nFAKE-SECRET:added\n",
      ".relay/decisions.md": "# Decisions\n\nFAKE-SECRET:decision\n",
    });

    const findings = await scanHead("fix it FAKE-SECRET:message");
    const sorted = [...findings].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    expect(sorted).toEqual([
      { path: "(checkpoint message)", line: 1, rule: "message" },
      { path: ".relay/decisions.md", line: 3, rule: "decision" },
      { path: ".relay/task.md", line: 2, rule: "task" },
      { path: "a.txt", line: 2, rule: "hunk-one" },
      { path: "a.txt", line: 6, rule: "hunk-two" },
      { path: "café/new.txt", line: 3, rule: "added" },
      { path: 'quote"name.txt', line: 1, rule: "quoted" },
      { path: "tab\tname.txt", line: 2, rule: "plus" },
    ]);
    // Only the added lines, the job files and the message were scanned.
    expect(record().input).not.toContain("FAKE-SECRET:old");
    expect(record().input).not.toContain("FAKE-SECRET:deleted");
    expect(record().input).not.toContain("two\nthree");
  });

  test.each([
    ["the -diff attribute in .gitattributes", () => commit({ ".gitattributes": "hidden.txt -diff\n" }), "hidden.txt"],
    ["the binary attribute in .git/info/attributes", () => writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "*.dat binary\n"), "hidden.dat"],
    ["a NUL byte in the file", () => undefined, "nul.bin"],
  ])("added lines hidden by %s are still scanned", async (_, prepare, path) => {
    prepare();
    commit({ "base.txt": "base\n" });
    commit({ [path]: path === "nul.bin" ? "a\u0000b\nFAKE-SECRET\n" : "clean\nFAKE-SECRET\n" });
    expect(await scanHead()).toEqual([{ path, line: 2, rule: "fake-rule" }]);
  });

  test("the patch is asked for without context lines between hunks", async () => {
    commit({ "f.txt": "1\n2\n3\n4\n5\n" });
    commit({ "f.txt": "1\ntwo\n3\nfour FAKE-SECRET\n5\n", "g.txt": "FAKE-SECRET\n" });
    const calls = watchGitCalls();
    const findings = await scanHead();
    calls.stop();
    expect(calls.calls.find((call) => call.includes("diff-tree"))).toContain("--inter-hunk-context=0");
    expect(findings).toEqual([{ path: "f.txt", line: 4, rule: "fake-rule" }, { path: "g.txt", line: 1, rule: "fake-rule" }]);
  });

  test("context lines inside a hunk take a line number and do not shift later files", () => {
    commit({ "f.txt": "1\n2\n3\n4\n5\n" });
    commit({ "f.txt": "1\ntwo\n3\nfour\n5\n", "g.txt": "++ added\nmore\n" });
    const patch = Buffer.from(
      scratch.git("diff-tree", "-p", "--text", "-U0", "--inter-hunk-context=3", "--src-prefix=a/", "--dst-prefix=b/", "-r", "HEAD~1", "HEAD"),
    );
    expect(patch.toString()).toContain("\n 3\n");
    expect(addedLines(patch).map(({ path, line, text }) => [path, line, text.toString()])).toEqual([
      ["f.txt", 2, "two"],
      ["f.txt", 4, "four"],
      ["g.txt", 1, "++ added"],
      ["g.txt", 2, "more"],
    ]);
  });

  test("a path with a space, which git ends with a tab, keeps its name", async () => {
    commit({ "my file.txt": "FAKE-SECRET\n" });
    expect(await scanHead()).toEqual([{ path: "my file.txt", line: 1, rule: "fake-rule" }]);
  });

  test("scan files of a process that has ended are removed, those of a running one are kept", async () => {
    const ended = Bun.spawn(["true"]);
    await ended.exited;
    const tmp = join(scratch.relayHome, "tmp");
    mkdirSync(tmp, { recursive: true });
    const stale = [`3f9a2c1d-${ended.pid}-0123abcd.scan`, `texts-${ended.pid}-0123abcd.report.json`, `3f9a2c1d-${ended.pid}-0123abcd.ignore`];
    const live = `3f9a2c1d-${process.pid}-0123abcd.scan`;
    for (const name of [...stale, live, "other.txt"]) writeFileSync(join(tmp, name), "x");
    commit({ "x.txt": "clean\n" });
    expect(await scanHead()).toEqual([]);
    expect(tmpFiles().sort()).toEqual([live, "other.txt"]);
  });

  test("gitleaks that runs past the time limit is stopped, and the scan did not finish", async () => {
    process.env.FAKE_GITLEAKS_SLEEP = "10000";
    commit({ "x.txt": "clean\n" });
    const started = Date.now();
    const error = await scanError(() => scanCheckpoint(repo, { jobId: "3f9a2c1d", parentTree: null, newTree: tree("HEAD"), timeoutMs: 500 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect([error.code, error.lines]).toEqual([1, ["The secret scan did not finish: gitleaks did not finish within 0.5 seconds, so relay stopped it. Nothing was saved."]]);
    expect(tmpFiles()).toEqual([]);
  });

  test("a checkpoint without a parent scans every line of the tree", async () => {
    commit({ "src/config.ts": "a\nb\nFAKE-SECRET\n" });
    expect(await scanHead(undefined, null)).toEqual([{ path: "src/config.ts", line: 3, rule: "fake-rule" }]);
  });

  test("the report's Secret, Match and Line never reach the findings", async () => {
    commit({ "x.txt": "token FAKE-SECRET marker-in-the-line\n" });
    expect(JSON.stringify(await scanHead(undefined, null))).not.toContain("marker-in-the-line");
  });

  test("gitleaks runs on stdin with relay's configuration, an empty ignore file and private temporary files", async () => {
    process.env.GITLEAKS_CONFIG = join(scratch.root, "allow.toml");
    process.env.GITLEAKS_CONFIG_TOML = "[allowlist]\n";
    commit({ "x.txt": "clean\n" });
    expect(await scanHead()).toEqual([]);
    const { args, config, ignore, configVariables, files } = record();
    const base = join(scratch.relayHome, "tmp", files[0].name.replace(/\.\w+$/, ""));
    expect(files[0].name).toMatch(new RegExp(`^3f9a2c1d-${process.pid}-[0-9a-f]{8}\\.ignore$`));
    expect(args).toEqual([
      "stdin", "--config", join(scratch.relayHome, "gitleaks.toml"), "--gitleaks-ignore-path", `${base}.ignore`,
      "--ignore-gitleaks-allow", "--redact", "--no-banner", "--log-level", "error", "--report-format", "json",
      "--report-path", `${base}.report.json`, "--exit-code", "42",
    ]);
    expect(config).toBe("[extend]\nuseDefault = true\n");
    expect(ignore).toBe("");
    expect(configVariables).toEqual([]);
    expect(files).toEqual([
      { name: files[0].name, mode: 0o600 },
      { name: files[0].name.replace(".ignore", ".scan"), mode: 0o600 },
    ]);
    expect(tmpFiles()).toEqual([]);
  });

  test("exit code 42 with findings returns them, and the temporary files are removed", async () => {
    commit({ "x.txt": "FAKE-SECRET\n" });
    expect(await scanHead(undefined, null)).toHaveLength(1);
    expect(tmpFiles()).toEqual([]);
  });

  test.each([
    ["exit code 1", { FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_STDERR: "failed to load config\n" }, "failed to load config"],
    [
      "a colored log line",
      { FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_STDERR: "\u001b[90m8:42AM\u001b[0m \u001b[31mFTL\u001b[0m \u001b[1munable to load gitleaks config, err: open x\u001b[0m\n" },
      "unable to load gitleaks config, err: open x",
    ],
    ["exit code 2 without a message", { FAKE_GITLEAKS_EXIT: "2" }, "gitleaks exited with code 2"],
    ["exit code 42 with an empty report", { FAKE_GITLEAKS_EXIT: "42", FAKE_GITLEAKS_REPORT: "[]" }, "gitleaks gave an exit code that does not match its report"],
    ["exit code 0 with findings", { FAKE_GITLEAKS_EXIT: "0", FAKE_GITLEAKS_REPORT: '[{"RuleID":"x","StartLine":1}]' }, "gitleaks gave an exit code that does not match its report"],
    ["a report that is not JSON", { FAKE_GITLEAKS_EXIT: "42", FAKE_GITLEAKS_REPORT: "not json" }, "relay could not read the gitleaks report"],
    ["no report", { FAKE_GITLEAKS_EXIT: "0" }, "relay could not read the gitleaks report"],
    ["a finding outside the input", { FAKE_GITLEAKS_EXIT: "42", FAKE_GITLEAKS_REPORT: '[{"RuleID":"x","StartLine":99}]' }, "relay could not read the gitleaks report"],
  ])("%s stops the scan with exit code 1 and removes the temporary files", async (_, variables, reason) => {
    Object.assign(process.env, variables);
    commit({ "x.txt": "clean\n" });
    const error = await scanError(() => scanHead());
    expect(error.code).toBe(1);
    expect(error.lines).toEqual([`The secret scan did not finish: ${reason}. Nothing was saved.`]);
    expect(tmpFiles()).toEqual([]);
  });

  test.each([
    ["a path that does not exist", () => join(scratch.root, "no-such-gitleaks")],
    ["a file that cannot be run", () => (writeFileSync(join(scratch.root, "plain"), ""), chmodSync(join(scratch.root, "plain"), 0o644), join(scratch.root, "plain"))],
  ])("a missing program (%s) gives exit code 3", async (_, program) => {
    process.env.RELAY_GITLEAKS = program();
    commit({ "x.txt": "clean\n" });
    const error = await scanError(() => scanHead());
    expect(error.code).toBe(3);
    expect(error.lines).toEqual([MISSING]);
    expect(tmpFiles()).toEqual([]);
  });

  test.each([["8.30.1"], ["8.28.0"], ["v8.30.1"], ["9.0.0"]])("version %s is accepted", async (version) => {
    process.env.FAKE_GITLEAKS_VERSION = version;
    await checkGitleaks();
  });

  test.each([["8.27.9"], ["7.99.0"], ["version is set by build process"]])("version %s is refused with exit code 3", async (version) => {
    process.env.FAKE_GITLEAKS_VERSION = version;
    const error = await scanError(() => checkGitleaks());
    expect([error.code, error.lines]).toEqual([3, [MISSING]]);
  });
});

describe("with the real gitleaks", () => {
  let token: string;
  beforeEach(() => {
    requireGitleaks();
    token = fakeGithubToken();
  });
  afterEach(() => {
    expect(filesContaining(scratch.relayHome, token)).toEqual([]);
    expect(tmpFiles()).toEqual([]);
  });

  test("gitleaks on PATH is 8.28 or newer", async () => {
    await checkGitleaks();
  });

  test("a token in a file is found on its line", async () => {
    commit({ "src/config.ts": "export const a = 1;\n" });
    commit({ "src/config.ts": `${"// line\n".repeat(11)}export const token = "${token}";\n` });
    const findings = await scanHead();
    expect(findings).toEqual([{ path: "src/config.ts", line: 12, rule: "github-pat" }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  test("a token in .relay/decisions.md is found", async () => {
    commit({ ".relay/decisions.md": `# Decisions\n\nUse the key ${token} for now.\n` });
    expect(await scanHead(undefined, null)).toEqual([{ path: ".relay/decisions.md", line: 3, rule: "github-pat" }]);
  });

  test("a token in the message is found", async () => {
    commit({ "x.txt": "clean\n" });
    expect(await scanHead(`use token ${token}`)).toEqual([{ path: "(checkpoint message)", line: 1, rule: "github-pat" }]);
  });

  test("a gitleaks:allow comment, a project .gitleaks.toml, a .gitleaksignore and GITLEAKS_CONFIG do not hide a token", async () => {
    const allow = `[extend]\nuseDefault = true\n\n[allowlist]\nregexes = ['''ghp_''']\n`;
    commit({
      ".gitleaks.toml": allow,
      ".gitleaksignore": ":github-pat:1\n:github-pat:2\nsrc/config.ts:github-pat:1\n",
      "src/config.ts": `const token = "${token}"; // gitleaks:allow\n`,
    });
    writeFileSync(join(scratch.root, "allow.toml"), allow);
    process.env.GITLEAKS_CONFIG = join(scratch.root, "allow.toml");
    // The allow list does hide the token when gitleaks is given it.
    const direct = Bun.spawnSync(["gitleaks", "stdin", "--config", join(scratch.root, "allow.toml"), "--no-banner", "--log-level", "error"], {
      stdin: Buffer.from(`const token = "${token}";\n`),
    });
    expect(direct.exitCode).toBe(0);

    expect(await scanHead(undefined, null)).toEqual([{ path: "src/config.ts", line: 1, rule: "github-pat" }]);
  });

  test("a -diff attribute and a NUL byte do not hide a token from the real gitleaks", async () => {
    commit({ ".gitattributes": "notes.txt -diff\n" });
    commit({ "notes.txt": `token ${token}\n`, "data.bin": `\u0000\n${token}\n` });
    const findings = await scanHead();
    expect([...findings].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: "data.bin", line: 2, rule: "github-pat" },
      { path: "notes.txt", line: 1, rule: "github-pat" },
    ]);
  });

  test("a token committed before is not found again when another line of its file changes", async () => {
    commit({ "src/config.ts": `const token = "${token}";\nconst a = 1;\n` });
    commit({ "src/config.ts": `const token = "${token}";\nconst a = 2;\n` });
    expect(await scanHead()).toEqual([]);
  });
});
