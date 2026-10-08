// relay checkpoint and saveCheckpoint (tasks.md 5.3): the checkpoints spec except listing, and the
// secret-scanning spec through the command. Every test that saves compares captureState() before
// and after. With RELAY_DOC_SAMPLES=1 the tests print each command and its exact output, for
// docs/checkpoints.md.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "../../src/checkpoint/save";
import { openRepository } from "../../src/git/repo";
import { takeJobLock } from "../../src/job/lock";
import { MAIN, runRelay, runRelayInProcess, type RelayResult } from "../helpers/cli";
import { captureState, type RepoState } from "../helpers/invariants";
import { makeScratchRepo, runGit, type ScratchRepo } from "../helpers/scratch-repo";
import { fakeAwsKey, fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

const FAKE_GITLEAKS = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");
const MB = 1024 * 1024;
const JOB_FILES = [".relay/checkpoint.md", ".relay/decisions.md", ".relay/events.jsonl", ".relay/state.json", ".relay/task.md"];
const NOTHING_SAVED =
  "Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.";

let scratch: ScratchRepo;

// Each command runs git and gitleaks several times; a test with several commands takes seconds.
setDefaultTimeout(30_000);

beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

function sample(args: string[], result: RelayResult): void {
  if (process.env.RELAY_DOC_SAMPLES !== "1") return;
  const shown = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg));
  console.log(["$ relay", ...shown].join(" ") + "\n" + result.stdout + result.stderr + `(exit code ${result.code})\n`);
}

// `shown` replaces the arguments in the printed sample, so a planted secret is never printed.
async function relay(args: string[], cwd = scratch.repo, shown = args): Promise<RelayResult> {
  const result = await runRelayInProcess(args, { cwd, relayHome: scratch.relayHome });
  sample(shown, result);
  return result;
}

// A scratch repository with a job whose baseline is saved. `limitMb` writes the size limit to
// config.toml first.
async function setUpJob(kind: "full" | "empty" = "full", limitMb?: number): Promise<void> {
  scratch = makeScratchRepo(kind);
  if (limitMb !== undefined) {
    mkdirSync(scratch.relayHome, { mode: 0o700 });
    writeFileSync(join(scratch.relayHome, "config.toml"), `[checkpoint]\nmax_file_size_mb = ${limitMb}\n`, { mode: 0o600 });
  }
  expect((await relay(["init"])).code).toBe(0);
}

const state = (root = scratch.repo) => JSON.parse(readFileSync(join(root, ".relay", "state.json"), "utf8"));
const jobId = (root = scratch.repo) => state(root).job_id as string;
const ref = (n: number | "latest", root = scratch.repo) =>
  n === "latest" ? `refs/relay/jobs/${jobId(root)}/latest` : `refs/relay/jobs/${jobId(root)}/checkpoints/${n}`;
const relayRefs = () => scratch.git("for-each-ref", "--format=%(refname)", "refs/relay/").split("\n").filter(Boolean);
const sha = (name: string) => scratch.git("rev-parse", name).trim();
const short = (name: string) => sha(name).slice(0, 7);
const show = (spec: string) => scratch.git("show", spec);
const paths = (name: string) => scratch.git("ls-tree", "-r", "-z", "--name-only", name).split("\0").filter(Boolean);
const trailer = (name: string, key: string) =>
  scratch.git("for-each-ref", `--format=%(trailers:key=${key},valueonly=true,separator=%x0a)`, name).trim();
const subject = (name: string) => scratch.git("for-each-ref", "--format=%(contents:subject)", name).trim();
const events = (root = scratch.repo) =>
  readFileSync(join(root, ".relay", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const lastEvent = (root = scratch.repo) => events(root).at(-1);

// captureState skips the files in .relay/; the status line of the ignored .relay/ folder is
// removed here too.
function personState(root = scratch.repo): RepoState {
  const captured = captureState(root);
  return { ...captured, status: captured.status.filter((entry) => !entry.includes(".relay/")) };
}

test("staged, unstaged and untracked work is saved; ignored files are not; nothing of the person's changes", async () => {
  await setUpJob();
  scratch.write("s.txt", "staged version\n");
  scratch.git("add", "s.txt");
  scratch.write("s.txt", "edited after staging\n");
  scratch.write("a.txt", "unstaged\n");
  scratch.git("add", "a.txt");
  scratch.git("commit", "-q", "-m", "add a.txt");
  scratch.write("a.txt", "unstaged change\n");
  scratch.write("u.txt", "untracked\n");
  scratch.write("debug.log", "ignored\n");
  scratch.write(".gitignore", "ignored.log\nnode_modules/\ndebug.log\n");
  scratch.git("add", ".gitignore");
  scratch.git("commit", "-q", "-m", "ignore debug.log");
  // The commits above are the person's; the checkpoint below compares with checkpoint 1.
  const before = personState();
  const result = await relay(["checkpoint", "-m", "Login form done"]);
  expect(result).toEqual({
    code: 0,
    stdout: `Saved checkpoint 2 · ${short(ref(2))}\n4 files changed since checkpoint 1\n`,
    stderr: "",
  });
  expect(show(`${ref(2)}:s.txt`)).toBe("edited after staging\n");
  expect(show(`${ref(2)}:a.txt`)).toBe("unstaged change\n");
  expect(show(`${ref(2)}:u.txt`)).toBe("untracked\n");
  expect(paths(ref(2))).not.toContain("debug.log");
  expect(paths(ref(2)).filter((path) => path.startsWith(".relay/"))).toEqual(JOB_FILES);
  expect(personState()).toEqual(before);
});

test("the spec's example prints three changed files", async () => {
  await setUpJob("empty");
  scratch.write("a.txt", "a\n");
  scratch.write(".gitignore", "debug.log\n");
  scratch.git("add", "a.txt", ".gitignore");
  scratch.git("commit", "-q", "-m", "first");
  expect((await relay(["checkpoint"])).code).toBe(0);
  scratch.write("s.txt", "staged\n");
  scratch.git("add", "s.txt");
  scratch.write("s.txt", "staged, then edited\n");
  scratch.write("a.txt", "changed\n");
  scratch.write("u.txt", "untracked\n");
  scratch.write("debug.log", "ignored\n");
  const before = personState();
  const result = await relay(["checkpoint", "-m", "Login form done"]);
  expect(result.stdout).toBe(`Saved checkpoint 3 · ${short(ref(3))}\n3 files changed since checkpoint 2\n`);
  expect(paths(ref(3))).not.toContain("debug.log");
  expect(personState()).toEqual(before);
});

test("the message and its trailers", async () => {
  await setUpJob();
  scratch.write("notes.txt", "more\n");
  await relay(["checkpoint", "-m", "OAuth callback works"]);
  expect(subject(ref(2))).toBe("relay checkpoint 2: OAuth callback works");
  expect(trailer(ref(2), "Relay-Job")).toBe(jobId());
  expect(trailer(ref(2), "Relay-Checkpoint")).toBe("2");
  expect(trailer(ref(2), "Relay-Kind")).toBe("manual");
  expect(trailer(ref(2), "Relay-Branch")).toBe("main");
  expect(trailer(ref(2), "Relay-Head")).toBe(sha("HEAD"));
  expect(sha(`${ref(2)}^`)).toBe(sha(ref(1)));
});

test("without -m the subject is the number alone; a message is cleaned", async () => {
  await setUpJob();
  scratch.write("notes.txt", "one\n");
  await relay(["checkpoint"]);
  expect(subject(ref(2))).toBe("relay checkpoint 2");
  scratch.write("notes.txt", "two\n");
  await relay(["checkpoint", "-m", `Login\nform​ ${"x".repeat(300)}`]);
  expect(subject(ref(3))).toBe(`relay checkpoint 3: Login form ${"x".repeat(189)}`);
  expect(lastEvent().data.message).toBe(`Login form ${"x".repeat(189)}`);
});

test("numbers count up and latest follows the newest checkpoint", async () => {
  await setUpJob();
  for (let n = 2; n <= 5; n++) {
    scratch.write("notes.txt", `version ${n}\n`);
    expect((await relay(["checkpoint"])).stdout.split("\n")[1]).toBe(`1 file changed since checkpoint ${n - 1}`);
    expect(sha(ref(n))).toBe(sha(ref("latest")));
  }
  expect(state().latest_checkpoint).toMatchObject({ number: 5, commit: sha(ref(5)), ref: ref(5), kind: "manual" });
  expect(state().checkpoint_count).toBe(5);
});

test("nothing changed means no checkpoint, no ref and no event", async () => {
  await setUpJob();
  const eventCount = events().length;
  const result = await relay(["checkpoint"]);
  expect(result).toEqual({ code: 0, stdout: "Nothing changed since checkpoint 1.\n", stderr: "" });
  expect(relayRefs()).toHaveLength(2);
  expect(events()).toHaveLength(eventCount);
  expect(await relay(["checkpoint", "--json"])).toEqual({ code: 0, stdout: '{"saved":false,"latest":1}\n', stderr: "" });
});

test("a change to task.md alone is a new checkpoint", async () => {
  await setUpJob();
  writeFileSync(join(scratch.repo, ".relay", "task.md"), "# New goal\n");
  const result = await relay(["checkpoint"]);
  expect(result.stdout).toBe(`Saved checkpoint 2 · ${short(ref(2))}\n1 file changed since checkpoint 1\n`);
  expect(show(`${ref(2)}:.relay/task.md`)).toBe("# New goal\n");
});

test("a file over the size limit is left out and listed", async () => {
  await setUpJob("full", 1);
  mkdirSync(join(scratch.repo, "assets"));
  writeFileSync(join(scratch.repo, "assets", "demo.mov"), Buffer.alloc(2 * MB, 7));
  scratch.write("notes.txt", "changed\n");
  const before = personState();
  const result = await relay(["checkpoint"]);
  expect(result.stdout).toBe(
    `Saved checkpoint 2 · ${short(ref(2))}\n1 file changed since checkpoint 1\nLeft out assets/demo.mov (2 MB, over the 1 MB limit)\n`,
  );
  expect(paths(ref(2))).not.toContain("assets/demo.mov");
  expect(trailer(ref(2), "Relay-Left-Out")).toBe("assets/demo.mov");
  expect(lastEvent().data.left_out).toEqual(["assets/demo.mov"]);
  expect(personState()).toEqual(before);
});

test("the checkpoint_saved event and the JSON output", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  const result = await relay(["checkpoint", "-m", "OAuth callback works", "--json"]);
  const commit = sha(ref(2));
  expect(JSON.parse(result.stdout)).toEqual({ saved: true, number: 2, commit, ref: ref(2), files_changed: 1, left_out: [] });
  expect(lastEvent()).toMatchObject({
    type: "checkpoint_saved",
    data: {
      number: 2,
      commit,
      kind: "manual",
      message: "OAuth callback works",
      parent: sha(ref(1)),
      head: sha("HEAD"),
      branch: "main",
      files_changed: 1,
      left_out: [],
    },
  });
  // The event and state.json are written after the refs, so the next checkpoint holds them.
  scratch.write("notes.txt", "again\n");
  await relay(["checkpoint"]);
  expect(show(`${ref(3)}:.relay/events.jsonl`)).toContain('"number":2');
});

test("two checkpoints at the same time either both save or one stops with exit code 6", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  const env = { RELAY_HOME: scratch.relayHome, HOME: scratch.home };
  const results = await Promise.all([0, 1].map(() => runRelay(["checkpoint"], { cwd: scratch.repo, env })));
  for (const result of results) {
    if (result.code === 6) {
      expect(result.stderr).toMatch(/^Another relay command is working on this job \(relay checkpoint, process \d+\)\. Try again when it finishes\.\n$/);
    } else {
      expect(result.code).toBe(0);
    }
  }
  const saved = results.filter((result) => result.stdout.startsWith("Saved"));
  expect(saved.length).toBeGreaterThanOrEqual(1);
  expect(relayRefs()).toHaveLength(2 + saved.length);
  expect(trailer(ref(2), "Relay-Checkpoint")).toBe("2");
});

test("without a job, or with a damaged state.json, relay checkpoint stops with exit code 3", async () => {
  scratch = makeScratchRepo();
  expect(await relay(["checkpoint"])).toEqual({ code: 3, stdout: "", stderr: "relay is not set up here. Run relay init first.\n" });
  expect((await relay(["init"])).code).toBe(0);
  writeFileSync(join(scratch.repo, ".relay", "state.json"), "{");
  expect(await relay(["checkpoint"])).toEqual({
    code: 3,
    stdout: "",
    stderr: ".relay/state.json is damaged: it is not valid JSON. relay changed nothing.\n",
  });
  writeFileSync(join(scratch.repo, ".relay", "state.json"), '{"schema_version":1}');
  expect((await relay(["checkpoint"])).stderr).toBe(
    ".relay/state.json is damaged: job_id is missing or has the wrong type. relay changed nothing.\n",
  );
  expect(relayRefs()).toHaveLength(2);
});

test("with a detached HEAD the branch trailer says (detached) and HEAD stays detached", async () => {
  await setUpJob();
  scratch.git("switch", "-q", "--detach");
  const head = sha("HEAD");
  scratch.write("notes.txt", "detached work\n");
  const before = personState();
  expect((await relay(["checkpoint"])).code).toBe(0);
  expect(trailer(ref(2), "Relay-Branch")).toBe("(detached)");
  expect(trailer(ref(2), "Relay-Head")).toBe(head);
  expect(lastEvent().data.branch).toBeNull();
  expect(personState()).toEqual(before);
});

test("in a repository with no commits, the baseline has no parent and Relay-Head none", async () => {
  scratch = makeScratchRepo("empty");
  scratch.write("first.txt", "first\n");
  const before = personState();
  expect((await relay(["init"])).code).toBe(0);
  expect(personState()).toEqual(before);
  expect(trailer(ref(1), "Relay-Head")).toBe("none");
  expect(scratch.git("rev-list", "--parents", "-1", ref(1)).trim()).toBe(sha(ref(1)));
  expect(paths(ref(1))).toContain("first.txt");
  scratch.write("second.txt", "second\n");
  const next = personState();
  expect((await relay(["checkpoint"])).stdout).toBe(`Saved checkpoint 2 · ${short(ref(2))}\n1 file changed since checkpoint 1\n`);
  expect(personState()).toEqual(next);
});

test("a first checkpoint saved by relay checkpoint compares with HEAD, or counts the files saved", async () => {
  scratch = makeScratchRepo("empty");
  scratch.write("first.txt", "first\n");
  const token = fakeGithubToken();
  scratch.write("secret.ts", `const t = "${token}";\n`);
  expect((await relay(["init"])).code).toBe(4);
  writeFileSync(join(scratch.repo, "secret.ts"), "const t = 1;\n");
  expect((await relay(["checkpoint"])).stdout).toBe(`Saved checkpoint 1 · ${short(ref(1))}\n2 files saved\n`);
});

test("in a linked worktree the checkpoint holds its files, both indexes stay the same, and refs are shared", async () => {
  await setUpJob();
  scratch.git("worktree", "add", "-q", "-b", "second", "../wt");
  const worktree = join(scratch.root, "wt");
  writeFileSync(join(worktree, "wt-only.txt"), "worktree file\n");
  expect((await relay(["init"], worktree)).code).toBe(0);
  writeFileSync(join(worktree, "wt-only.txt"), "changed in the worktree\n");
  const before = personState(worktree);
  const main = personState();
  expect((await relay(["checkpoint"], worktree)).code).toBe(0);
  expect(personState(worktree)).toEqual(before);
  expect(personState()).toEqual(main);

  const worktreeRef = ref(2, worktree);
  expect(show(`${worktreeRef}:wt-only.txt`)).toBe("changed in the worktree\n");
  expect(trailer(worktreeRef, "Relay-Branch")).toBe("second");
  expect(jobId(worktree)).not.toBe(jobId());
  // Two jobs, two prefixes; the main checkout's job is untouched.
  expect(relayRefs().filter((name) => name.startsWith(`refs/relay/jobs/${jobId()}/`))).toHaveLength(2);
  expect(relayRefs().filter((name) => name.startsWith(`refs/relay/jobs/${jobId(worktree)}/`))).toHaveLength(3);
  expect(events().map((event) => event.type)).toEqual(["job_started", "checkpoint_saved"]);
});

test("saveCheckpoint saves a handoff with extra trailers while the caller holds the job lock", async () => {
  await setUpJob();
  scratch.write("notes.txt", "handoff\n");
  const release = takeJobLock(scratch.relayHome, jobId(), "switch");
  try {
    const result = await saveCheckpoint(await openRepository(scratch.repo), {
      relayHome: scratch.relayHome,
      command: "switch",
      kind: "handoff",
      maxFileSizeMb: 20,
      env: process.env,
      trailers: [["Relay-Worker", "5d2e8f01"], ["Relay-Target", "claude:personal"]],
      lockHeld: true,
    });
    expect(result).toMatchObject({ saved: true, number: 2, kind: "handoff" });
  } finally {
    release();
  }
  expect(trailer(ref(2), "Relay-Kind")).toBe("handoff");
  expect(trailer(ref(2), "Relay-Worker")).toBe("5d2e8f01");
  expect(trailer(ref(2), "Relay-Target")).toBe("claude:personal");
  expect(lastEvent().data.kind).toBe("handoff");
});

test("while another command holds the job lock, relay checkpoint stops with exit code 6", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  const release = takeJobLock(scratch.relayHome, jobId(), "rollback");
  try {
    expect(await relay(["checkpoint"])).toEqual({
      code: 6,
      stdout: "",
      stderr: `Another relay command is working on this job (relay rollback, process ${process.pid}). Try again when it finishes.\n`,
    });
  } finally {
    release();
  }
  expect(relayRefs()).toHaveLength(2);
});

test("a git setting changed since relay init stops the checkpoint with exit code 5", async () => {
  await setUpJob();
  scratch.git("config", "core.fsmonitor", "touch pwned");
  scratch.write("notes.txt", "changed\n");
  expect(await relay(["checkpoint"])).toEqual({
    code: 5,
    stdout: "",
    stderr: [
      "Stopped: .git/config changed since this job started.",
      "  added  core.fsmonitor (can run commands)",
      "relay will not run git here until you check this change.",
      "If you made it yourself, run relay accept-git-changes in your terminal.",
      "",
    ].join("\n"),
  });
  expect(relayRefs()).toHaveLength(2);
  expect(lastEvent()).toMatchObject({
    type: "checkpoint_refused",
    data: { command: "checkpoint", reason: "git_changed", changed: [join(scratch.repo, ".git", "config")] },
  });
});

// The secret-scanning spec, through the command.

test("a token in an untracked file stops the checkpoint and is never shown or stored", async () => {
  await setUpJob();
  const token = fakeGithubToken();
  scratch.write("src/config.ts", `${Array.from({ length: 11 }, (_, i) => `// line ${i + 1}`).join("\n")}\nexport const token = "${token}";\n`);
  const before = personState();
  const result = await relay(["checkpoint"]);
  expect(result).toEqual({
    code: 4,
    stdout: "",
    stderr: `Stopped: possible secret in src/config.ts line 12 (github-pat).\n${NOTHING_SAVED}\n`,
  });
  expect(relayRefs()).toHaveLength(2);
  expect(lastEvent()).toMatchObject({
    type: "checkpoint_refused",
    data: { command: "checkpoint", reason: "secret_found", findings: [{ path: "src/config.ts", line: 12, rule: "github-pat" }] },
  });
  expect(Object.keys(lastEvent().data.findings[0]).sort()).toEqual(["line", "path", "rule"]);
  expect(filesContaining(join(scratch.repo, ".relay"), token)).toEqual([]);
  expect(filesContaining(scratch.relayHome, token)).toEqual([]);
  expect(personState()).toEqual(before);
});

test("a secret in a job file names the file and the line", async () => {
  await setUpJob();
  const key = fakeAwsKey();
  writeFileSync(join(scratch.repo, ".relay", "decisions.md"), `# Decisions\n\nUse the key ${key} for the bucket.\n`);
  const result = await relay(["checkpoint"]);
  expect(result.code).toBe(4);
  expect(result.stderr).toMatch(/^Stopped: possible secret in \.relay\/decisions\.md line 3 \([a-z-]+\)\.\n/);
  expect(result.stderr).not.toContain(key);
});

test("a secret in the message names (checkpoint message)", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  const token = fakeGithubToken();
  const result = await relay(["checkpoint", "-m", `use token ${token}`], scratch.repo, ["checkpoint", "-m", "use token ghp_…"]);
  expect(result).toEqual({
    code: 4,
    stdout: "",
    stderr: `Stopped: possible secret in (checkpoint message) line 1 (github-pat).\n${NOTHING_SAVED}\n`,
  });
  expect(filesContaining(scratch.relayHome, token)).toEqual([]);
  expect(filesContaining(join(scratch.repo, ".relay"), token)).toEqual([]);
});

test("each finding gets a line, at most 20, then the number of the others", async () => {
  await setUpJob();
  scratch.write("tokens.txt", Array.from({ length: 23 }, () => `token = "${fakeGithubToken()}"`).join("\n") + "\n");
  const lines = (await relay(["checkpoint"])).stderr.split("\n");
  expect(lines.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `Stopped: possible secret in tokens.txt line ${i + 1} (github-pat).`));
  expect(lines.slice(20)).toEqual(["and 3 more", NOTHING_SAVED, ""]);
});

test("a secret already committed on the person's branch is not scanned again", async () => {
  scratch = makeScratchRepo();
  scratch.write("old.ts", `export const token = "${fakeGithubToken()}";\nexport const a = 1;\n`);
  scratch.git("add", "old.ts");
  scratch.git("commit", "-q", "-m", "old secret");
  expect((await relay(["init"])).code).toBe(0);
  writeFileSync(join(scratch.repo, "old.ts"), readFileSync(join(scratch.repo, "old.ts"), "utf8").replace("a = 1", "a = 2"));
  expect((await relay(["checkpoint"])).code).toBe(0);
});

test("an unignored .env.local needs approval; once approved it is saved and stays approved", async () => {
  await setUpJob();
  scratch.write(".env.local", "MODE=dev\n");
  scratch.write(".env.example", "MODE=\n");
  const before = personState();
  expect(await relay(["checkpoint"])).toEqual({
    code: 4,
    stdout: "",
    stderr:
      "Stopped: .env.local is not ignored by git and may hold secrets.\n" +
      "Add it to .gitignore, or include it with: relay checkpoint --include .env.local\n",
  });
  expect(relayRefs()).toHaveLength(2);
  expect(lastEvent()).toMatchObject({
    type: "checkpoint_refused",
    data: { command: "checkpoint", reason: "secret_like_file", files: [".env.local"] },
  });

  const approved = await relay(["checkpoint", "--include", ".env.local"]);
  expect(approved.stdout).toBe(`Saved checkpoint 2 · ${short(ref(2))}\n2 files changed since checkpoint 1\nIncluded .env.local (you approved it)\n`);
  expect(show(`${ref(2)}:.env.local`)).toBe("MODE=dev\n");
  expect(show(`${ref(2)}:.env.example`)).toBe("MODE=\n");
  expect(state().approved_paths).toEqual([".env.local"]);

  writeFileSync(join(scratch.repo, ".env.local"), "MODE=test\n");
  expect((await relay(["checkpoint"])).stdout).toBe(`Saved checkpoint 3 · ${short(ref(3))}\n1 file changed since checkpoint 2\n`);
  expect(show(`${ref(3)}:.env.local`)).toBe("MODE=test\n");
  expect({ ...personState(), files: {}, status: [] }).toEqual({ ...before, files: {}, status: [] });
});

test("an approved file is still scanned", async () => {
  await setUpJob();
  const token = fakeGithubToken();
  scratch.write("deploy.pem", `token ${token}\n`);
  const result = await relay(["checkpoint", "--include", "deploy.pem"]);
  expect(result.code).toBe(4);
  expect(result.stderr).toStartWith("Stopped: possible secret in deploy.pem line 1 (github-pat).\n");
  expect(state().approved_paths).toEqual([]);
});

test("--include outside the project is a usage error", async () => {
  await setUpJob();
  expect(await relay(["checkpoint", "--include", "../x"])).toEqual({
    code: 2,
    stdout: "",
    stderr: 'relay: --include needs a path relative to the top folder of the project, not "../x".\n',
  });
});

test("a scanner that fails or is missing stops the checkpoint and saves nothing", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { RELAY_GITLEAKS: FAKE_GITLEAKS, FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_STDERR: "failed to load config\n" });
    expect(await relay(["checkpoint"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "The secret scan did not finish: failed to load config. Nothing was saved.\n",
    });
    process.env.RELAY_GITLEAKS = join(scratch.root, "no-such-gitleaks");
    expect(await relay(["checkpoint"])).toEqual({
      code: 3,
      stdout: "",
      stderr: "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks\n",
    });
  } finally {
    for (const name of ["RELAY_GITLEAKS", "FAKE_GITLEAKS_EXIT", "FAKE_GITLEAKS_STDERR"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  expect(relayRefs()).toHaveLength(2);
});

// Regression tests for the review of task group 5.

test("in a cone-mode sparse checkout with a sparse index, relay init and relay checkpoint work", async () => {
  scratch = makeScratchRepo();
  scratch.write("b/f.txt", "outside the cone\n");
  scratch.git("add", "b/f.txt");
  scratch.git("commit", "-q", "-m", "b");
  scratch.git("sparse-checkout", "init", "--cone", "--sparse-index");
  scratch.git("sparse-checkout", "set", "src");
  const before = personState();
  expect((await relay(["init"])).code).toBe(0);
  scratch.write("src/app.ts", "export const answer = 5;\n");
  const next = personState();
  expect((await relay(["checkpoint"])).code).toBe(0);
  expect(show(`${ref(2)}:src/app.ts`)).toBe("export const answer = 5;\n");
  expect(show(`${ref(2)}:b/f.txt`)).toBe("outside the cone\n");
  expect(paths(ref(2))).toContain(".relay/task.md");
  expect(personState()).toEqual(next);
  expect({ ...before, files: {}, status: [] }).toEqual({ ...personState(), files: {}, status: [] });
});

test("a state.json that names another checkout's job stops with exit code 3 and writes no ref", async () => {
  await setUpJob();
  const mainJob = jobId();
  scratch.git("worktree", "add", "-q", "-b", "second", "../wt");
  const worktree = join(scratch.root, "wt");
  expect((await relay(["init"], worktree)).code).toBe(0);
  const edited = { ...state(worktree), job_id: mainJob };
  writeFileSync(join(worktree, ".relay", "state.json"), `${JSON.stringify(edited, null, 2)}\n`);
  writeFileSync(join(worktree, "wt-only.txt"), "from the worktree\n");
  expect(await relay(["checkpoint"], worktree)).toEqual({
    code: 3,
    stdout: "",
    stderr: `.relay/state.json names job ${mainJob}, which relay init did not set up in this checkout. relay changed nothing.\n`,
  });
  expect(relayRefs().filter((name) => name.startsWith(`refs/relay/jobs/${mainJob}/`))).toHaveLength(2);
  // The worktree root recorded in state.json is checked too.
  writeFileSync(join(worktree, ".relay", "state.json"), `${JSON.stringify({ ...edited, job_id: jobId(), repository: state().repository }, null, 2)}\n`);
  expect((await relay(["checkpoint"], worktree)).code).toBe(3);
});

test("untracked repositories of their own are left out and reported, with or without commits", async () => {
  await setUpJob();
  mkdirSync(join(scratch.repo, "fresh"));
  runGit(join(scratch.repo, "fresh"), ["init", "-q"]);
  writeFileSync(join(scratch.repo, "fresh", "f.txt"), "f\n");
  mkdirSync(join(scratch.repo, "withc"));
  runGit(join(scratch.repo, "withc"), ["init", "-q"]);
  writeFileSync(join(scratch.repo, "withc", "w.txt"), "w\n");
  runGit(join(scratch.repo, "withc"), ["add", "w.txt"]);
  runGit(join(scratch.repo, "withc"), ["commit", "-q", "-m", "w"]);
  scratch.write("other.txt", "other\n");
  const before = personState();
  expect(await relay(["checkpoint"])).toEqual({
    code: 0,
    stdout:
      `Saved checkpoint 2 · ${short(ref(2))}\n1 file changed since checkpoint 1\n` +
      "Left out fresh/ (a separate git repository)\nLeft out withc/ (a separate git repository)\n",
    stderr: "",
  });
  expect(paths(ref(2)).filter((path) => path.startsWith("fresh") || path.startsWith("withc"))).toEqual([]);
  expect(lastEvent().data.left_out).toEqual(["fresh/", "withc/"]);
  expect(personState()).toEqual(before);
});

test("when only a file over the limit is new, nothing is saved and the file is still reported", async () => {
  await setUpJob("full", 1);
  writeFileSync(join(scratch.repo, "big.bin"), Buffer.alloc(2 * MB, 3));
  expect(await relay(["checkpoint"])).toEqual({
    code: 0,
    stdout: "Nothing changed since checkpoint 1.\nLeft out big.bin (2 MB, over the 1 MB limit)\n",
    stderr: "",
  });
  expect(await relay(["checkpoint", "--json"])).toEqual({
    code: 0,
    stdout: '{"saved":false,"latest":1,"left_out":["big.bin"]}\n',
    stderr: "",
  });
  expect(relayRefs()).toHaveLength(2);
});

test("control characters in -m never reach the commit message or the event", async () => {
  await setUpJob();
  scratch.write("notes.txt", "changed\n");
  expect((await relay(["checkpoint", "-m", "ok\u001b[2J\u0007\u000b\u0085end"])).code).toBe(0);
  expect(subject(ref(2))).toBe("relay checkpoint 2: ok[2Jend");
  expect(lastEvent().data.message).toBe("ok[2Jend");
});

test("approved_paths keeps only --include paths that matched a saved file", async () => {
  await setUpJob();
  scratch.write("deploy.pem", "not a secret\n");
  const result = await relay(["checkpoint", "--include", "deploy.pem", "--include", "nothing/here.env", "--include", "a\u001bb"]);
  expect(result.code).toBe(0);
  expect(state().approved_paths).toEqual(["deploy.pem"]);
});

test("a baseline that fails with an error that is not a refusal still says the job is set up", async () => {
  scratch = makeScratchRepo();
  const index = join(scratch.repo, ".git", "index");
  chmodSync(index, 0o000);
  let result: RelayResult;
  try {
    result = await relay(["init"]);
  } finally {
    chmodSync(index, 0o644);
  }
  expect(result.code).toBe(1);
  expect(result.stderr.split("\n")[0]).toBe(`relay is set up (job ${jobId()}), but the baseline checkpoint was not saved.`);
  expect((await relay(["checkpoint"])).stdout).toStartWith("Saved checkpoint 1 ·");
});

test("Control-C while git builds the tree prints that relay was stopped and leaves no temporary file", async () => {
  scratch = makeScratchRepo();
  scratch.git("config", "filter.slow.clean", "sleep 5; cat");
  scratch.write(".gitattributes", "*.slow filter=slow\n");
  scratch.git("add", ".gitattributes");
  scratch.git("commit", "-q", "-m", "attributes");
  expect((await relay(["init"])).code).toBe(0);
  scratch.write("a.slow", "slow\n");
  const before = personState();
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "checkpoint"], {
    cwd: scratch.repo,
    env: { ...process.env, RELAY_HOME: scratch.relayHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const tmp = join(scratch.relayHome, "tmp");
  const deadline = Date.now() + 10_000;
  while (!(existsSync(tmp) && readdirSync(tmp).some((name) => name.endsWith(".index"))) && Date.now() < deadline) await Bun.sleep(5);
  await Bun.sleep(300);
  child.kill("SIGINT");
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(130);
  expect(stderr).not.toContain("failed");
  expect(["", "relay was stopped before it finished. Nothing was saved.\n"]).toContain(stderr);
  expect(readdirSync(tmp)).toEqual([]);
  expect(relayRefs()).toHaveLength(2);
  expect(personState()).toEqual(before);
});
