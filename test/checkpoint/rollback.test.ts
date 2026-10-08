// relay rollback when it changes files (tasks.md 7.2, design.md decision 9 steps 7 to 11): the
// undo checkpoint, deletions, writing through a temporary index, the result check, the event and
// state.json. Every test checks that nothing of the person's other than working-tree files changed.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchGitCalls } from "../../src/git/run";
import { tryLock } from "../../src/platform/file-lock";
import { MAIN } from "../helpers/cli";
import { captureState } from "../helpers/invariants";
import {
  events, eventsText, personGitState, personState, ref, relay, relayRefs, setUpJob, sha, state,
} from "../helpers/job";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

const MB = 1024 * 1024;
let scratch: ScratchRepo;

setDefaultTimeout(60_000);
beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

const files = () => captureState(scratch.repo).files;
const short = (n: number) => sha(scratch, ref(scratch, n)).slice(0, 7);
const append = (path: string, text: string) => scratch.write(path, `${readFileSync(join(scratch.repo, path), "utf8")}${text}`);

// The git command in an argument list from the runner, after its -c settings.
function commandOf(argv: string[]): string {
  let i = 1;
  while (argv[i] === "-c") i += 2;
  return argv[i]!;
}

test("rolling back restores checkpoint 2 exactly, and rolling back to the undo checkpoint restores the files before", async () => {
  scratch = await setUpJob("full", 1);
  scratch.write("lib/a.ts", "export const a = 1;\n");
  scratch.write("lib/b.ts", "export const b = 1;\n");
  expect((await relay(scratch, ["checkpoint", "-m", "Login form done"], { quiet: true })).code).toBe(0);
  const atTwo = files();

  scratch.write("src/app.ts", "export const answer = 4;\n");
  scratch.write("src/new.ts", "export const fresh = 1;\n");
  unlinkSync(join(scratch.repo, "lib/a.ts"));
  chmodSync(join(scratch.repo, "run.sh"), 0o644);
  unlinkSync(join(scratch.repo, "link-to-readme"));
  scratch.write("link-to-readme", "now a regular file\n");
  scratch.write("gone/only.txt", "only file of a new folder\n");
  scratch.write("keep/new.txt", "new file next to an ignored one\n");
  scratch.write("keep/ignored.log", "ignored\n");
  scratch.write("ignored.log", "ignored, changed after checkpoint 2\n");
  writeFileSync(join(scratch.repo, "big.bin"), Buffer.alloc(2 * MB, 3));
  scratch.write(".env.local", "NOT_A_SECRET=1\n");
  writeFileSync(join(scratch.repo, ".relay", "task.md"), "# Changed after checkpoint 2\n");
  const beforeRollback = files();
  const gitBefore = personGitState(scratch.repo);
  const eventsBefore = eventsText(scratch);

  const watch = watchGitCalls();
  const result = await relay(scratch, ["rollback", "2", "--yes"]);
  watch.stop();
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const [plan, done] = result.stdout.split("\n\nSaved");
  expect(plan!.split("\n").slice(2, 9)).toEqual([
    "  delete  gone/only.txt",
    "  delete  keep/new.txt",
    "  add     lib/a.ts",
    "  modify  link-to-readme",
    "  modify  run.sh",
    "  modify  src/app.ts",
    "  delete  src/new.ts",
  ]);
  expect(`Saved${done}`).toBe(
    `Saved checkpoint 3 · ${short(3)} (before rollback)\nRolled back to checkpoint 2 · ${short(2)}\n7 files changed\nTo undo: relay rollback 3\n`,
  );

  // Every file of checkpoint 2 is back; unsaved files and ignored files are as they were.
  const unsaved = ["ignored.log", "big.bin", ".env.local", "keep/ignored.log"];
  expect(files()).toEqual({ ...atTwo, ...Object.fromEntries(unsaved.map((path) => [path, beforeRollback[path]!])) });
  expect(lstatSync(join(scratch.repo, "run.sh")).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(scratch.repo, "link-to-readme")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(scratch.repo, "gone"))).toBe(false);
  expect(readdirSync(join(scratch.repo, "keep"))).toEqual(["ignored.log"]);
  expect(personGitState(scratch.repo)).toEqual(gitBefore);

  // The job files stay, and the event log only grows.
  expect(readFileSync(join(scratch.repo, ".relay", "task.md"), "utf8")).toBe("# Changed after checkpoint 2\n");
  expect(eventsText(scratch).startsWith(eventsBefore)).toBe(true);
  const added = events(scratch).slice(eventsBefore.split("\n").length - 1);
  expect(added.map((event) => event.type)).toEqual(["checkpoint_saved", "rollback"]);
  expect(added[0].data).toMatchObject({ number: 3, kind: "pre_rollback", message: "Before rolling back to checkpoint 2" });
  expect(added[0].data.left_out).toEqual(["big.bin", ".env.local"]);
  const data = { to_checkpoint: 2, to_commit: sha(scratch, ref(scratch, 2)), undo_checkpoint: 3, files_written: 4, files_deleted: 3 };
  expect(added[1].data).toEqual(data);
  expect(state(scratch).last_rollback).toEqual({ ...data, rolled_back_at: expect.any(String) });
  expect(eventsText(scratch)).not.toContain("export const");

  // relay wrote through its own index and never ran a git command that changes the person's files.
  const commands = watch.calls.map(commandOf);
  expect(commands).toContain("read-tree");
  expect(commands).toContain("checkout-index");
  for (const name of ["checkout", "reset", "restore", "clean", "stash", "switch", "update-index"]) expect(commands).not.toContain(name);

  const undo = await relay(scratch, ["rollback", "3", "--yes"]);
  expect(undo.code).toBe(0);
  expect(files()).toEqual(beforeRollback);
  expect(personGitState(scratch.repo)).toEqual(gitBefore);
});

test("in a terminal, the answer y rolls back", async () => {
  scratch = await setUpJob();
  scratch.write("notes.txt", "at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint", "-m", "Notes done"], { quiet: true })).code).toBe(0);
  scratch.write("notes.txt", "changed\n");
  const result = await relay(scratch, ["rollback"], { terminal: { answer: "y" } });
  expect(result.code).toBe(0);
  expect(result.stdout).toEndWith(
    `Roll back? [y/N] Saved checkpoint 3 · ${short(3)} (before rollback)\nRolled back to checkpoint 2 · ${short(2)}\n1 file changed\nTo undo: relay rollback 3\n`,
  );
  expect(readFileSync(join(scratch.repo, "notes.txt"), "utf8")).toBe("at checkpoint 2\n");
});

test("commits made after the checkpoint stay on the branch, and the restored files show as changes", async () => {
  scratch = await setUpJob();
  scratch.write("notes.txt", "at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  for (const name of ["one.txt", "two.txt"]) {
    scratch.write(name, `${name}\n`);
    scratch.git("add", name);
    scratch.git("commit", "-q", "-m", `add ${name}`);
  }
  const head = sha(scratch, "HEAD");
  const result = await relay(scratch, ["rollback", "2", "--yes"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `\n2 files changed\nYour branch still points to ${head.slice(0, 7)}. The restored files show as uncommitted changes.\nTo undo: relay rollback 3\n`,
  );
  expect(sha(scratch, "refs/heads/main")).toBe(head);
  expect(existsSync(join(scratch.repo, "one.txt"))).toBe(false);
  expect(scratch.git("status", "--porcelain", "--", "one.txt", "two.txt")).toBe(" D one.txt\n D two.txt\n");
});

test("when the current files hold a secret, the undo checkpoint is refused and nothing changes", async () => {
  scratch = await setUpJob();
  scratch.write("notes.txt", "at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  const token = fakeGithubToken();
  scratch.write("src/config.ts", `export const token = "${token}";\n`);
  const before = { person: personState(scratch.repo), refs: relayRefs(scratch) };
  const result = await relay(scratch, ["rollback", "2", "--yes"], { quiet: true });
  expect(result.code).toBe(4);
  expect(result.stderr).toBe(
    [
      "relay could not save your current files before rolling back, so it changed nothing.",
      "Stopped: possible secret in src/config.ts line 1 (github-pat).",
      "Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.",
      "",
    ].join("\n"),
  );
  expect({ person: personState(scratch.repo), refs: relayRefs(scratch) }).toEqual(before);
  expect(events(scratch).at(-1)).toMatchObject({ type: "checkpoint_refused", data: { command: "rollback", reason: "secret_found" } });
  expect(result.stdout + result.stderr).not.toContain(token);
  expect(filesContaining(scratch.relayHome, token)).toEqual([]);
  expect(filesContaining(join(scratch.repo, ".relay"), token)).toEqual([]);
});

test("a symbolic link that replaced a saved folder is removed, never followed", async () => {
  scratch = await setUpJob();
  scratch.write("out/file.txt", "inside\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  const outside = join(scratch.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside\n");
  rmSync(join(scratch.repo, "out"), { recursive: true });
  symlinkSync(outside, join(scratch.repo, "out"));
  const before = files();

  expect((await relay(scratch, ["rollback", "2", "--yes"], { quiet: true })).code).toBe(0);
  expect(lstatSync(join(scratch.repo, "out")).isDirectory()).toBe(true);
  expect(readFileSync(join(scratch.repo, "out", "file.txt"), "utf8")).toBe("inside\n");
  expect(readdirSync(outside)).toEqual(["file.txt"]);
  expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("outside\n");

  expect((await relay(scratch, ["rollback", "3", "--yes"], { quiet: true })).code).toBe(0);
  expect(files()).toEqual(before);
  expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("outside\n");
});

test("a file that cannot be written is reported with the undo command and exit code 1", async () => {
  scratch = await setUpJob();
  scratch.write("locked/a.txt", "version 1\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write("locked/a.txt", "version 2\n");
  chmodSync(join(scratch.repo, "locked"), 0o555);
  try {
    const result = await relay(scratch, ["rollback", "2", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Rollback finished, but these files do not match checkpoint 2: locked/a.txt\nTo undo: relay rollback 3\n");
    expect(events(scratch).at(-1)).toMatchObject({ type: "rollback", data: { to_checkpoint: 2, undo_checkpoint: 3 } });
  } finally {
    chmodSync(join(scratch.repo, "locked"), 0o755);
  }
});

test("Control-C while files are written leaves a state the undo checkpoint restores, and no temporary file", async () => {
  // A smudge filter that hangs while the flag file exists, set before relay init so that the
  // trust record holds it.
  scratch = makeScratchRepo();
  const flag = join(scratch.root, "hang");
  const smudge = join(scratch.root, "smudge.sh");
  writeFileSync(smudge, `#!/bin/sh\nif [ -f '${flag}' ]; then echo $$ > '${join(scratch.root, "smudge.pid")}'; sleep 30; fi\nexec cat\n`, { mode: 0o755 });
  scratch.write(".gitattributes", "*.slow filter=slow\n");
  scratch.git("config", "filter.slow.clean", "cat");
  scratch.git("config", "filter.slow.smudge", smudge);
  expect((await relay(scratch, ["init"], { quiet: true })).code).toBe(0);
  const pidFile = join(scratch.root, "smudge.pid");
  scratch.write("a.slow", "one\n");
  scratch.write("b.txt", "one\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write("a.slow", "two\n");
  scratch.write("b.txt", "two\n");
  scratch.write("extra.txt", "deleted by the rollback\n");
  const before = files();
  const gitBefore = personGitState(scratch.repo);

  writeFileSync(flag, "");
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "rollback", "2", "--yes"], {
      cwd: scratch.repo,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 500 && !existsSync(pidFile); i++) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(await new Response(child.stderr).text()).toBe("relay was stopped before the rollback finished.\nTo undo: relay rollback 3\n");
  } finally {
    rmSync(flag, { force: true });
  }
  expect(readdirSync(join(scratch.relayHome, "tmp"))).toEqual([]);
  // The events lock is an flock lock whose file stays (add-daemon-api-and-status); no lock is held.
  const locks = readdirSync(join(scratch.relayHome, "locks"));
  expect(locks.filter((name) => !name.endsWith(".events.lock"))).toEqual([]);
  for (const name of locks) {
    const handle = tryLock(join(scratch.relayHome, "locks", name));
    expect(handle).not.toBeNull();
    handle!.release();
  }
  expect(existsSync(join(scratch.repo, "extra.txt"))).toBe(false);

  expect((await relay(scratch, ["rollback", "3", "--yes"], { quiet: true })).code).toBe(0);
  expect(files()).toEqual(before);
  expect(personGitState(scratch.repo)).toEqual(gitBefore);
});

test("in a linked worktree, a rollback changes only that worktree's files", async () => {
  scratch = await setUpJob();
  scratch.git("worktree", "add", "-q", "-b", "second", "../wt");
  const worktree = join(scratch.root, "wt");
  expect((await relay(scratch, ["init"], { cwd: worktree, quiet: true })).code).toBe(0);
  writeFileSync(join(worktree, "wt-only.txt"), "at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { cwd: worktree, quiet: true })).code).toBe(0);
  writeFileSync(join(worktree, "wt-only.txt"), "changed\n");
  const main = personState(scratch.repo);
  const gitBefore = personGitState(worktree);
  expect((await relay(scratch, ["rollback", "2", "--yes"], { cwd: worktree, quiet: true })).code).toBe(0);
  expect(readFileSync(join(worktree, "wt-only.txt"), "utf8")).toBe("at checkpoint 2\n");
  expect(personGitState(worktree)).toEqual(gitBefore);
  expect(personState(scratch.repo)).toEqual(main);
});

test("a file the target checkpoint left out for its size is not restored to an older version", async () => {
  scratch = await setUpJob("full", 1);
  scratch.write("data.bin", "version 1, committed\n");
  scratch.git("add", "data.bin");
  scratch.git("commit", "-q", "-m", "add data.bin");
  writeFileSync(join(scratch.repo, "data.bin"), Buffer.alloc(2 * MB, 7));
  scratch.write("notes.txt", "notes at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write("data.bin", "version 3, small again\n");
  scratch.write("notes.txt", "notes after checkpoint 2\n");
  const result = await relay(scratch, ["rollback", "2", "--yes"]);
  expect(result.code).toBe(0);
  expect(readFileSync(join(scratch.repo, "notes.txt"), "utf8")).toBe("notes at checkpoint 2\n");
  expect(readFileSync(join(scratch.repo, "data.bin"), "utf8")).toBe("version 3, small again\n");
});

test("a file that was ignored before the rollback does not make the result check fail", async () => {
  scratch = await setUpJob();
  scratch.write("notes.txt", "notes at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write(".gitignore", `${readFileSync(join(scratch.repo, ".gitignore"), "utf8")}cache.txt\n`);
  scratch.write("cache.txt", "ignored cache\n");
  scratch.write("notes.txt", "notes after checkpoint 2\n");
  const result = await relay(scratch, ["rollback", "2", "--yes"]);
  expect(result.code).toBe(0);
  expect(readFileSync(join(scratch.repo, "notes.txt"), "utf8")).toBe("notes at checkpoint 2\n");
  expect(readFileSync(join(scratch.repo, "cache.txt"), "utf8")).toBe("ignored cache\n");
});

// macOS file systems ignore case by default, so Guide.md and GUIDE.md are one file there. git
// sees the rename, and the file at the added path is the file the plan deletes.
test.skipIf(process.platform !== "darwin")("a rename that changes only the case of a name is rolled back", async () => {
  scratch = await setUpJob();
  scratch.write("Guide.md", "guide at checkpoint 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  renameSync(join(scratch.repo, "Guide.md"), join(scratch.repo, "GUIDE.md"));
  const result = await relay(scratch, ["rollback", "2", "--yes"]);
  expect(result.stderr).not.toContain("has not saved");
  expect(result.code).toBe(0);
  expect(readdirSync(scratch.repo)).toContain("Guide.md");
  expect(readdirSync(scratch.repo)).not.toContain("GUIDE.md");
  expect(readFileSync(join(scratch.repo, "Guide.md"), "utf8")).toBe("guide at checkpoint 2\n");
});
