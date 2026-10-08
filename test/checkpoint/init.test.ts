// relay init and its baseline checkpoint (tasks.md 3.2 and 5.4). With RELAY_DOC_SAMPLES=1 the
// tests print each command and its exact output, for docs/checkpoints.md.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../src/core/version";
import { captureState, type RepoState } from "../helpers/invariants";
import { runRelayInProcess, type RelayResult } from "../helpers/cli";
import { makeScratchRepo, runGit, type ScratchRepo } from "../helpers/scratch-repo";
import { MAIN, runRelay } from "../helpers/cli";
import { fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

const FAKE_GITLEAKS = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");
const FILES = ["checkpoint.md", "decisions.md", "events.jsonl", "state.json", "task.md"];
const NOT_A_REPOSITORY = "This folder is not inside a git repository. Run relay init inside your project.";
const MISSING_GITLEAKS = "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks";

let scratch: ScratchRepo;

// Each command runs git and gitleaks several times; a test with several commands takes seconds.
setDefaultTimeout(30_000);

beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

async function init(args: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<RelayResult> {
  const result = await runRelayInProcess(["init", ...args], { cwd: options.cwd ?? scratch.repo, relayHome: scratch.relayHome, env: options.env });
  if (process.env.RELAY_DOC_SAMPLES === "1") {
    const shown = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));
    console.log(["$ relay init", ...shown].join(" ") + "\n" + result.stdout + result.stderr + `(exit code ${result.code})\n`);
  }
  return result;
}

const relayFile = (name: string, root = scratch.repo) => readFileSync(join(root, ".relay", name), "utf8");
const state = (root = scratch.repo) => JSON.parse(relayFile("state.json", root));
const excludeFile = () => join(scratch.repo, ".git", "info", "exclude");

// captureState skips the files in .relay/; the status line of the ignored .relay/ folder is
// removed here too, because relay init creates that folder.
function personState(root = scratch.repo): RepoState {
  const captured = captureState(root);
  return { ...captured, status: captured.status.filter((entry) => !entry.includes(".relay/")) };
}

function expectNothingCreated(root = scratch.repo): void {
  expect(existsSync(join(root, ".relay"))).toBe(false);
  expect(existsSync(join(scratch.relayHome, "jobs"))).toBe(false);
}

test("the first run creates the five files, prints the set-up lines and leaves the person's repository unchanged", async () => {
  scratch = makeScratchRepo();
  const before = personState();
  const exclude = readFileSync(excludeFile(), "utf8");

  const result = await init();
  const id = state().job_id;
  const commit = scratch.git("rev-parse", `refs/relay/jobs/${id}/checkpoints/1`).trim();
  expect(result).toEqual({
    code: 0,
    stdout: [
      `Set up relay in ${scratch.repo}`,
      `Job ${id}`,
      "Wrote .relay/task.md, state.json, checkpoint.md, decisions.md, events.jsonl",
      "Added /.relay/ to .git/info/exclude",
      `Saved checkpoint 1 · ${commit.slice(0, 7)} (baseline)`,
      "Next: write the goal in .relay/task.md",
      "",
    ].join("\n"),
    stderr: "",
  });
  expect(readdirSync(join(scratch.repo, ".relay")).sort()).toEqual(FILES);
  expect(readFileSync(excludeFile(), "utf8")).toBe(`${exclude}# relay: job files stay local\n/.relay/\n`);
  expect(personState()).toEqual(before);
  expect(scratch.git("status", "--porcelain", "--untracked-files=all")).not.toContain(".relay");
  expect(scratch.git("for-each-ref", "--format=%(refname)", "refs/relay/")).toBe(
    `refs/relay/jobs/${id}/checkpoints/1\nrefs/relay/jobs/${id}/latest\n`,
  );

  const jobDir = join(scratch.relayHome, "jobs", id);
  expect(statSync(jobDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(jobDir, "git-trust.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(jobDir, "git-trust.json"), "utf8")).job_id).toBe(id);
});

test("a worktree in the home folder is shown with ~", async () => {
  scratch = makeScratchRepo();
  const env = { HOME: scratch.root };
  const result = await init(["--title", "Demo"], { env });
  expect(result.stdout.split("\n")[0]).toBe("Set up relay in ~/repo");
  expect((await init([], { env })).stderr).toBe(`relay is already set up here (job ${state().job_id}).\n`);
});

test("run from a subfolder, relay init uses the worktree root", async () => {
  scratch = makeScratchRepo();
  expect((await init([], { cwd: join(scratch.repo, "src") })).code).toBe(0);
  expect(readdirSync(join(scratch.repo, ".relay")).sort()).toEqual(FILES);
  expect(existsSync(join(scratch.repo, "src", ".relay"))).toBe(false);
});

test("the job ID is 8 lowercase hexadecimal characters, and its only refs are the baseline's", async () => {
  scratch = makeScratchRepo();
  expect(scratch.git("for-each-ref", "refs/relay/")).toBe("");
  await init();
  const id = state().job_id;
  expect(id).toMatch(/^[0-9a-f]{8}$/);
  expect(scratch.git("for-each-ref", "--format=%(refname)", "refs/relay/")).toBe(
    `refs/relay/jobs/${id}/checkpoints/1\nrefs/relay/jobs/${id}/latest\n`,
  );
});

test("outside a git repository, relay init stops with exit code 3", async () => {
  scratch = makeScratchRepo();
  expect(await init([], { cwd: scratch.home })).toEqual({ code: 3, stdout: "", stderr: `${NOT_A_REPOSITORY}\n` });
  expect(existsSync(join(scratch.home, ".relay"))).toBe(false);
  expectNothingCreated();
});

test("a bare repository is refused with exit code 3", async () => {
  scratch = makeScratchRepo();
  runGit(scratch.root, ["init", "-q", "--bare", "bare.git"]);
  expect(await init([], { cwd: join(scratch.root, "bare.git") })).toEqual({
    code: 3,
    stdout: "",
    stderr: "This repository has no working tree. relay needs one.\n",
  });
  expect(existsSync(join(scratch.root, "bare.git", ".relay"))).toBe(false);
  expectNothingCreated();
});

test("a second relay init stops with exit code 3 and changes nothing", async () => {
  scratch = makeScratchRepo();
  await init();
  const id = state().job_id;
  const files = FILES.map((name) => relayFile(name));
  const exclude = readFileSync(excludeFile(), "utf8");
  const trust = readFileSync(join(scratch.relayHome, "jobs", id, "git-trust.json"), "utf8");
  const before = personState();

  expect(await init()).toEqual({ code: 3, stdout: "", stderr: `relay is already set up here (job ${id}).\n` });
  expect(FILES.map((name) => relayFile(name))).toEqual(files);
  expect(readFileSync(excludeFile(), "utf8")).toBe(exclude);
  expect(readFileSync(join(scratch.relayHome, "jobs", id, "git-trust.json"), "utf8")).toBe(trust);
  expect(readdirSync(join(scratch.relayHome, "jobs"))).toEqual([id]);
  expect(personState()).toEqual(before);
});

test("a .relay folder without a readable state.json is reported and kept", async () => {
  scratch = makeScratchRepo();
  scratch.write(".relay/notes.md", "mine\n");
  const result = await init();
  expect(result.code).toBe(3);
  expect(result.stderr).toBe(
    `relay is already set up here, but the job file ${join(scratch.repo, ".relay", "state.json")} is missing.\n` +
      "If an earlier relay init was stopped before it finished, delete the .relay folder and run relay init again.\n",
  );
  expect(readdirSync(join(scratch.repo, ".relay"))).toEqual(["notes.md"]);
});

test.each([
  ["no gitleaks program", (root: string) => ({ RELAY_GITLEAKS: join(root, "no-such-gitleaks") })],
  ["gitleaks 8.27", () => ({ RELAY_GITLEAKS: FAKE_GITLEAKS, FAKE_GITLEAKS_VERSION: "8.27.0" })],
])("with %s, relay init stops with exit code 3 and creates nothing", async (_, env) => {
  scratch = makeScratchRepo();
  const exclude = readFileSync(excludeFile(), "utf8");
  expect(await init([], { env: env(scratch.root) })).toEqual({ code: 3, stdout: "", stderr: `${MISSING_GITLEAKS}\n` });
  expectNothingCreated();
  expect(readFileSync(excludeFile(), "utf8")).toBe(exclude);
});

test("task.md takes its title from the branch", async () => {
  scratch = makeScratchRepo();
  scratch.git("switch", "-q", "-c", "auth-refactor");
  await init();
  expect(relayFile("task.md")).toBe(
    `# auth-refactor

<!-- relay job ${state().job_id}. Agents read this file first. Keep it current. -->

## Goal

Describe what this job should achieve.

## Acceptance criteria

- [ ] Describe how to tell the job is done.

## Plan

## Done

## In progress

## Left to do
`,
  );
  expect(state().title).toBe("auth-refactor");
});

test("--title sets the title in task.md and state.json", async () => {
  scratch = makeScratchRepo();
  await init(["--title", "Build authentication"]);
  expect(relayFile("task.md").split("\n")[0]).toBe("# Build authentication");
  expect(state().title).toBe("Build authentication");
});

test("the title loses newlines and invisible characters and is cut to 120 characters", async () => {
  scratch = makeScratchRepo();
  await init(["--title", `Fix\nthe\u200B login\u202E${"é".repeat(200)}`]);
  const title = `Fix the login${"é".repeat(107)}`;
  expect(state().title).toBe(title);
  expect(Array.from(title)).toHaveLength(120);
  expect(relayFile("task.md").split("\n")[0]).toBe(`# ${title}`);
});

test("checkpoint.md and decisions.md are written from their templates", async () => {
  scratch = makeScratchRepo();
  await init();
  const id = state().job_id;
  expect(relayFile("checkpoint.md")).toBe(
    `# Checkpoint\n\n<!-- relay job ${id}. The latest handoff, written for the next agent. -->\n\nNo handoff yet. relay writes this file when work moves to another agent.\n`,
  );
  expect(relayFile("decisions.md")).toBe(
    `# Decisions\n\n<!-- relay job ${id}. One entry per decision, newest last: the date, the decision, and why. -->\n`,
  );
});

test("state.json has the schema's fields, with the baseline as latest checkpoint", async () => {
  scratch = makeScratchRepo();
  const head = scratch.git("rev-parse", "HEAD").trim();
  await init();
  const saved = state();
  expect(Object.keys(saved)).toEqual([
    "schema_version", "job_id", "title", "status", "created_at", "updated_at", "relay_version", "repository", "start",
    "latest_checkpoint", "checkpoint_count", "approved_paths", "last_rollback",
  ]);
  expect(saved).toEqual({
    schema_version: 1,
    job_id: saved.job_id,
    title: "main",
    status: "active",
    created_at: saved.created_at,
    updated_at: saved.updated_at,
    relay_version: VERSION,
    repository: { worktree_root: scratch.repo, common_git_dir: join(scratch.repo, ".git"), linked_worktree: false },
    start: { head, branch: "main", detached: false },
    latest_checkpoint: {
      number: 1,
      commit: scratch.git("rev-parse", `refs/relay/jobs/${saved.job_id}/latest`).trim(),
      ref: `refs/relay/jobs/${saved.job_id}/checkpoints/1`,
      kind: "baseline",
      created_at: saved.latest_checkpoint.created_at,
    },
    checkpoint_count: 1,
    approved_paths: [],
    last_rollback: null,
  });
  for (const time of [saved.created_at, saved.updated_at, saved.latest_checkpoint.created_at]) expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(Date.parse(saved.updated_at)).toBeGreaterThanOrEqual(Date.parse(saved.created_at));
});

test("in a repository with no commits, start has no head", async () => {
  scratch = makeScratchRepo("empty");
  const before = personState();
  expect((await init()).code).toBe(0);
  expect(state().start).toEqual({ head: null, branch: "main", detached: false });
  expect(personState()).toEqual(before);
});

test("with a detached HEAD, the title is the folder name and start says detached", async () => {
  scratch = makeScratchRepo();
  scratch.git("switch", "-q", "--detach");
  const head = scratch.git("rev-parse", "HEAD").trim();
  const before = personState();
  await init();
  expect(state().title).toBe("repo");
  expect(state().start).toEqual({ head, branch: null, detached: true });
  expect(personState()).toEqual(before);
});

test("the first event is job_started and the second the baseline's checkpoint_saved", async () => {
  scratch = makeScratchRepo();
  await init();
  const lines = relayFile("events.jsonl").split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, type: "checkpoint_saved", data: { number: 1, kind: "baseline" } });
  const event = JSON.parse(lines[0]!);
  expect(event).toEqual({
    v: 1,
    id: 1,
    ts: event.ts,
    job: state().job_id,
    type: "job_started",
    actor: "relay",
    data: {
      title: "main",
      worktree_root: scratch.repo,
      head: scratch.git("rev-parse", "HEAD").trim(),
      branch: "main",
      detached: false,
      linked_worktree: false,
    },
  });
});

test("the exclude line is added once for the main checkout and a linked worktree", async () => {
  scratch = makeScratchRepo();
  scratch.git("worktree", "add", "-q", "-b", "second", "../wt");
  const worktree = join(scratch.root, "wt");
  scratch.write("../wt/new.txt", "untracked in the worktree\n");
  const exclude = readFileSync(excludeFile(), "utf8");

  // With the scratch folder as the home folder, the output shows paths starting with ~.
  const env = { HOME: scratch.root };
  expect((await init([], { env })).code).toBe(0);
  const before = personState(worktree);
  const result = await init([], { cwd: worktree, env });
  expect(result.code).toBe(0);
  expect(result.stdout.split("\n")[3]).toBe("/.relay/ is already in ~/repo/.git/info/exclude");
  expect(personState(worktree)).toEqual(before);

  expect(readFileSync(excludeFile(), "utf8")).toBe(`${exclude}# relay: job files stay local\n/.relay/\n`);
  expect(readFileSync(excludeFile(), "utf8").split("\n").filter((line) => line === "/.relay/")).toHaveLength(1);
  expect(readdirSync(join(worktree, ".relay")).sort()).toEqual(FILES);
  expect(runGit(worktree, ["status", "--porcelain", "--untracked-files=all"])).not.toContain(".relay");
  expect(state(worktree).repository).toEqual({ worktree_root: worktree, common_git_dir: join(scratch.repo, ".git"), linked_worktree: true });
  expect(state(worktree).job_id).not.toBe(state().job_id);
  expect(JSON.parse(relayFile("events.jsonl", worktree).split("\n")[0]!).data.linked_worktree).toBe(true);
});

test("an exclude file without a final newline gets one before the relay lines", async () => {
  scratch = makeScratchRepo();
  writeFileSync(excludeFile(), "*.tmp");
  await init();
  expect(readFileSync(excludeFile(), "utf8")).toBe("*.tmp\n# relay: job files stay local\n/.relay/\n");
});

test("when a later step fails, the files relay init created are removed", async () => {
  scratch = makeScratchRepo();
  // A file where the jobs folder should be makes writing the trust record fail.
  mkdirSync(scratch.relayHome, { mode: 0o700 });
  writeFileSync(join(scratch.relayHome, "jobs"), "not a folder\n");
  const exclude = readFileSync(excludeFile(), "utf8");
  const result = await init();
  expect([result.code, result.stdout]).toEqual([1, ""]);
  expect(result.stderr).toContain(join(scratch.relayHome, "jobs"));
  expect(existsSync(join(scratch.repo, ".relay"))).toBe(false);
  expect(readFileSync(join(scratch.relayHome, "jobs"), "utf8")).toBe("not a folder\n");
  // The exclude line stays: it is harmless, and the next relay init finds it.
  expect(readFileSync(excludeFile(), "utf8")).toBe(`${exclude}# relay: job files stay local\n/.relay/\n`);
});

test("a hard-linked info/exclude is refused before anything is created", async () => {
  scratch = makeScratchRepo();
  rmSync(excludeFile());
  linkSync(join(scratch.repo, ".git", "index"), excludeFile());
  const index = readFileSync(join(scratch.repo, ".git", "index"));
  expect(await init()).toEqual({
    code: 3,
    stdout: "",
    stderr: `relay cannot add /.relay/ to ${excludeFile()}: it has more than one hard link.\n`,
  });
  expect(readFileSync(join(scratch.repo, ".git", "index"))).toEqual(index);
  expectNothingCreated();
});

test.each([
  ["info/exclude", "it is a symbolic link or not a regular file"],
  ["info", "its folder is a symbolic link or not a folder"],
])("a symbolic link at %s is refused, and the file it points to is unchanged", async (link, reason) => {
  scratch = makeScratchRepo();
  const outside = join(scratch.home, ".zshrc");
  writeFileSync(outside, "export PATH\n");
  if (link === "info") {
    mkdirSync(join(scratch.home, "info"));
    rmSync(join(scratch.repo, ".git", "info"), { recursive: true });
    symlinkSync(join(scratch.home, "info"), join(scratch.repo, ".git", "info"));
    symlinkSync(outside, join(scratch.home, "info", "exclude"));
  } else {
    rmSync(excludeFile());
    symlinkSync(outside, excludeFile());
  }
  expect(await init()).toEqual({ code: 3, stdout: "", stderr: `relay cannot add /.relay/ to ${excludeFile()}: ${reason}.\n` });
  expect(readFileSync(outside, "utf8")).toBe("export PATH\n");
  expectNothingCreated();
});

test("an info/exclude the person cannot write is refused before anything is created", async () => {
  scratch = makeScratchRepo();
  chmodSync(excludeFile(), 0o444);
  expect(await init()).toEqual({ code: 3, stdout: "", stderr: `relay cannot add /.relay/ to ${excludeFile()}: you cannot write to it.\n` });
  expectNothingCreated();
});

test("a state.json relay cannot read is reported as damaged with exit code 3", async () => {
  scratch = makeScratchRepo();
  await init();
  const state = join(scratch.repo, ".relay", "state.json");
  chmodSync(state, 0o000);
  const result = await init();
  chmodSync(state, 0o644);
  expect(result.code).toBe(3);
  expect(result.stderr.split("\n")[0]).toBe(`relay is already set up here, but the job file ${state} is damaged: relay cannot read it (EACCES).`);
});

test("a regular file named .relay is reported with exit code 3", async () => {
  scratch = makeScratchRepo();
  scratch.write(".relay", "mine\n");
  expect(await init()).toEqual({
    code: 3,
    stdout: "",
    stderr: `${join(scratch.repo, ".relay")} exists but is not a folder. Move it away, then run relay init again.\n`,
  });
  expect(readFileSync(join(scratch.repo, ".relay"), "utf8")).toBe("mine\n");
});

test.each([["--title"], ["the branch name"]])("a token in %s stops relay init with exit code 4 before anything is written", async (where) => {
  scratch = makeScratchRepo();
  const token = fakeGithubToken();
  const exclude = readFileSync(excludeFile(), "utf8");
  if (where !== "--title") scratch.git("switch", "-q", "-c", `fix-${token}`);
  const result = await init(where === "--title" ? ["--title", `Use ${token}`] : []);
  expect(result.code).toBe(4);
  expect(result.stderr.split("\n")).toContain("Stopped: possible secret in .relay/task.md line 1 (github-pat).");
  expect(result.stderr).toEndWith("Nothing was set up. Remove the secret from the title or the branch name, then run relay init again.\n");
  expect(result.stdout + result.stderr).not.toContain(token);
  expectNothingCreated();
  expect(readFileSync(excludeFile(), "utf8")).toBe(exclude);
  expect(filesContaining(scratch.relayHome, token)).toEqual([]);
});

test("control characters are removed from the title", async () => {
  scratch = makeScratchRepo();
  await init(["--title", "Fix\tthe \u001b[31mlogin\u0007\u009b"]);
  expect(state().title).toBe("Fixthe [31mlogin");
});

// Starts relay init as its own process and sends it SIGINT once `ready` holds.
async function interruptInit(env: Record<string, string>, ready: () => boolean): Promise<number> {
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "init"], {
    cwd: scratch.repo,
    env: { ...process.env, RELAY_HOME: scratch.relayHome, ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(2);
  child.kill("SIGINT");
  return await child.exited;
}

test("an interrupt during the secret scan removes the scan files and creates nothing", async () => {
  scratch = makeScratchRepo();
  const tmp = join(scratch.relayHome, "tmp");
  const scanFiles = () => (existsSync(tmp) ? readdirSync(tmp) : []);
  const code = await interruptInit({ RELAY_GITLEAKS: FAKE_GITLEAKS, FAKE_GITLEAKS_SLEEP: "15000" }, () => scanFiles().some((name) => name.endsWith(".scan")));
  expect(code).toBe(130);
  await Bun.sleep(300);
  expect(scanFiles()).toEqual([]);
  expectNothingCreated();
});

test("an interrupt after .relay was created removes what relay init created", async () => {
  scratch = makeScratchRepo();
  const code = await interruptInit({}, () => existsSync(join(scratch.repo, ".relay")));
  expect(code).toBe(130);
  expect(existsSync(join(scratch.repo, ".relay"))).toBe(false);
  const jobs = join(scratch.relayHome, "jobs");
  expect(existsSync(jobs) ? readdirSync(jobs) : []).toEqual([]);
  expect((await init()).code).toBe(0);
});

test("a relative RELAY_GITLEAKS is found from the folder relay started in, also by the scan", async () => {
  scratch = makeScratchRepo();
  mkdirSync(join(scratch.repo, "tools"));
  symlinkSync(FAKE_GITLEAKS, join(scratch.repo, "tools", "gitleaks"));
  const result = await runRelay(["init"], {
    cwd: scratch.repo,
    env: { RELAY_HOME: scratch.relayHome, RELAY_GITLEAKS: "./tools/gitleaks", FAKE_GITLEAKS_RECORD: join(scratch.root, "record.json") },
  });
  expect([result.code, result.stderr]).toEqual([0, ""]);
  expect(JSON.parse(readFileSync(join(scratch.root, "record.json"), "utf8")).args[0]).toBe("stdin");
});

const show = (spec: string) => scratch.git("show", spec);
const trailer = (commit: string, key: string) =>
  scratch.git("for-each-ref", `--format=%(trailers:key=${key},valueonly=true)`, commit).trim();

test("the baseline checkpoint holds the person's uncommitted work", async () => {
  scratch = makeScratchRepo();
  await init();
  const ref = `refs/relay/jobs/${state().job_id}/checkpoints/1`;
  expect(trailer(ref, "Relay-Kind")).toBe("baseline");
  expect(show(`${ref}:src/app.ts`)).toBe("export const answer = 3;\n");
  expect(show(`${ref}:notes.txt`)).toBe("untracked\n");
  expect(show(`${ref}:staged.txt`)).toBe("staged\n");
  expect(scratch.git("rev-parse", `${ref}^`).trim()).toBe(scratch.git("rev-parse", "HEAD").trim());
});

test("when the secret scan stops the baseline, the job stays set up and the next checkpoint is the baseline", async () => {
  scratch = makeScratchRepo();
  const token = fakeGithubToken();
  scratch.write("src/config.ts", `export const a = 1;\nexport const token = "${token}";\n`);
  const result = await init();
  const id = state().job_id;
  expect(result).toEqual({
    code: 4,
    stdout: "",
    stderr: [
      `relay is set up (job ${id}), but the baseline checkpoint was not saved.`,
      "Stopped: possible secret in src/config.ts line 2 (github-pat).",
      "Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.",
      "",
    ].join("\n"),
  });
  expect(readdirSync(join(scratch.repo, ".relay")).sort()).toEqual(FILES);
  expect(scratch.git("for-each-ref", "refs/relay/")).toBe("");
  expect(state().latest_checkpoint).toBeNull();

  scratch.write("src/config.ts", "export const a = 1;\n");
  const next = await runRelayInProcess(["checkpoint"], { cwd: scratch.repo, relayHome: scratch.relayHome });
  expect(next.code).toBe(0);
  expect(next.stdout.split("\n").slice(0, 2)).toEqual([
    `Saved checkpoint 1 · ${scratch.git("rev-parse", "--short=7", `refs/relay/jobs/${id}/latest`).trim()}`,
    `6 files differ from commit ${scratch.git("rev-parse", "--short=7", "HEAD").trim()}`,
  ]);
  expect(trailer(`refs/relay/jobs/${id}/checkpoints/1`, "Relay-Kind")).toBe("baseline");
  expect(state().latest_checkpoint.kind).toBe("baseline");
});
