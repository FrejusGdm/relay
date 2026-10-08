// relay rollback before it changes anything (tasks.md 7.1, design.md decision 9 steps 1 to 6):
// the target, the plan, the preview, --dry-run, the question, and the refusal to touch files relay
// has not saved. In every case here relay must create no checkpoint, append no event and change
// nothing of the person's, which each test checks with captureState().
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "../../src/checkpoint/save";
import { openRepository } from "../../src/git/repo";
import type { RelayResult } from "../helpers/cli";
import { eventsText, jobId, personState, ref, relay, relayRefs, setUpJob, sha } from "../helpers/job";
import type { ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

const MB = 1024 * 1024;
let scratch: ScratchRepo;

setDefaultTimeout(30_000);
beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

// Checkpoint 2 "Login form done" holds src/auth.ts and src/session.ts. Afterwards src/auth.ts
// changed, src/session.ts was deleted and src/new-helper.ts was added.
async function threeChanges(): Promise<void> {
  scratch = await setUpJob();
  scratch.write("src/auth.ts", "export const login = 1;\n");
  scratch.write("src/session.ts", "export const session = 1;\n");
  expect((await relay(scratch, ["checkpoint", "-m", "Login form done"], { quiet: true })).code).toBe(0);
  scratch.write("src/auth.ts", "export const login = 2;\n");
  rmSync(join(scratch.repo, "src/session.ts"));
  scratch.write("src/new-helper.ts", "export const help = 1;\n");
}

const short = (n: number) => sha(scratch, ref(scratch, n)).slice(0, 7);

function preview(): string {
  return [
    `Roll back to checkpoint 2 · ${short(2)} (TIME, "Login form done")`,
    "",
    "  modify  src/auth.ts",
    "  delete  src/new-helper.ts",
    "  add     src/session.ts",
    "",
    "3 files will change. Your branch, commits and staged changes stay as they are.",
    "relay saves your current files as a checkpoint first, so you can undo this.",
    "",
  ].join("\n");
}

const withoutTime = (text: string) => text.replace(/\(\d+ seconds? ago/, "(TIME");

// Runs relay and checks that nothing of the person's, no ref and no event changed.
async function changesNothing(args: string[], options: { terminal?: { answer: string | null } } = {}): Promise<RelayResult> {
  const before = { person: personState(scratch.repo), refs: relayRefs(scratch), events: eventsText(scratch) };
  const result = await relay(scratch, args, options);
  expect({ person: personState(scratch.repo), refs: relayRefs(scratch), events: eventsText(scratch) }).toEqual(before);
  return result;
}

test("--dry-run prints the exact plan and exits 0", async () => {
  await threeChanges();
  const result = await changesNothing(["rollback", "2", "--dry-run"]);
  expect({ ...result, stdout: withoutTime(result.stdout) }).toEqual({ code: 0, stdout: preview(), stderr: "" });
});

test("without a terminal and without --yes, relay prints the plan and exits 7", async () => {
  await threeChanges();
  const result = await changesNothing(["rollback", "2"]);
  expect({ ...result, stdout: withoutTime(result.stdout) }).toEqual({
    code: 7,
    stdout: preview(),
    stderr: "Run again with --yes to roll back.\n",
  });
});

test("in a terminal, any answer other than y or yes cancels", async () => {
  await threeChanges();
  for (const answer of ["n", "", "nope", null]) {
    const result = await changesNothing(["rollback", "2"], { terminal: { answer } });
    expect({ ...result, stdout: withoutTime(result.stdout) }).toEqual({
      code: 7,
      stdout: `${preview()}Roll back? [y/N] `,
      stderr: "Cancelled. Nothing changed.\n",
    });
  }
});

test("without a checkpoint, relay uses the newest one that was not saved before a rollback", async () => {
  await threeChanges();
  await saveCheckpoint(await openRepository(scratch.repo), {
    relayHome: scratch.relayHome,
    command: "rollback",
    kind: "pre_rollback",
    maxFileSizeMb: 20,
    env: process.env,
    message: "Before rolling back to checkpoint 1",
  });
  scratch.write("src/auth.ts", "export const login = 3;\n");
  const byDefault = await changesNothing(["rollback", "--dry-run"]);
  expect(byDefault.stdout.split("\n")[0]).toStartWith(`Roll back to checkpoint 2 · ${short(2)} (`);
  // A pre_rollback checkpoint can still be named, to undo a rollback.
  const named = await changesNothing(["rollback", "3", "--dry-run"]);
  expect(named.stdout.split("\n")[0]).toStartWith(`Roll back to checkpoint 3 · ${short(3)} (`);
  expect(named.stdout).toContain(`"Before rolling back to checkpoint 1"`);
});

test("an unknown checkpoint, an ambiguous prefix and a wrong argument exit 2", async () => {
  await threeChanges();
  expect(await changesNothing(["rollback", "9"])).toEqual({
    code: 2,
    stdout: "",
    stderr: "Checkpoint 9 does not exist. See relay checkpoints.\n",
  });
  expect((await changesNothing(["rollback", "abc"])).stderr).toBe(
    'relay rollback needs a checkpoint number or a commit prefix of at least 7 hexadecimal characters, not "abc".\n',
  );
  // A unique commit prefix names its checkpoint.
  const byPrefix = await changesNothing(["rollback", short(2), "--dry-run"]);
  expect(byPrefix.stdout.split("\n")[0]).toStartWith(`Roll back to checkpoint 2 · ${short(2)} (`);
  // A second checkpoint ref on the same commit makes its prefix ambiguous.
  scratch.git("-c", "core.logAllRefUpdates=false", "update-ref", `refs/relay/jobs/${jobId(scratch)}/checkpoints/9`, sha(scratch, ref(scratch, 2)));
  expect(await changesNothing(["rollback", short(2)])).toEqual({
    code: 2,
    stdout: "",
    stderr: `${short(2)} matches more than one checkpoint. Use the checkpoint number.\n`,
  });
});

test("when the files already match, there is nothing to roll back", async () => {
  scratch = await setUpJob();
  scratch.write("notes.txt", "saved\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  expect(await changesNothing(["rollback", "2", "--yes"])).toEqual({
    code: 0,
    stdout: "Nothing to roll back. Your files already match checkpoint 2.\n",
    stderr: "",
  });
});

test("an ignored file where the checkpoint has a file stops the rollback with exit code 8", async () => {
  scratch = await setUpJob();
  scratch.write("config/local.json", '{"port":1}\n');
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write(".gitignore", `${readFileSync(join(scratch.repo, ".gitignore"), "utf8")}config/local.json\n`);
  scratch.write("config/local.json", '{"port":2}\n');
  for (const args of [["rollback", "2", "--yes"], ["rollback", "2", "--dry-run"]]) {
    expect(await changesNothing(args)).toEqual({
      code: 8,
      stdout: "",
      stderr:
        "Rolling back would overwrite files relay has not saved: config/local.json. Move them or delete them yourself, then try again.\n",
    });
  }
});

test("a file left out for its size and an unapproved secret-like file are protected", async () => {
  scratch = await setUpJob("full", 1);
  scratch.write("data.bin", "small\n");
  scratch.write("key.pem", "not a real key, version 1\n");
  scratch.git("add", "key.pem");
  scratch.git("commit", "-q", "-m", "add key.pem");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  // data.bin grows over the limit; key.pem stops being tracked, so its name now needs approval.
  writeFileSync(join(scratch.repo, "data.bin"), Buffer.alloc(2 * MB, 2));
  scratch.git("rm", "-q", "--cached", "key.pem");
  scratch.git("commit", "-q", "-m", "stop tracking key.pem");
  scratch.write("key.pem", "not a real key, version 2\n");
  const result = await changesNothing(["rollback", "2", "--yes"]);
  expect(result.code).toBe(8);
  expect(result.stderr).toBe(
    "Rolling back would overwrite files relay has not saved: data.bin, key.pem. Move them or delete them yourself, then try again.\n",
  );
});

test("a symbolic link to a folder outside the project is never followed", async () => {
  scratch = await setUpJob();
  scratch.write("out/file.txt", "inside\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  const outside = join(scratch.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside\n");
  rmSync(join(scratch.repo, "out"), { recursive: true });
  symlinkSync(outside, join(scratch.repo, "out"));
  scratch.write(".gitignore", `${readFileSync(join(scratch.repo, ".gitignore"), "utf8")}/out\n`);
  const result = await changesNothing(["rollback", "2", "--yes"]);
  expect(result.code).toBe(8);
  expect(result.stderr).toStartWith("Rolling back would overwrite files relay has not saved: out. ");
  expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("outside\n");
});

test("a file marked assume-unchanged, whose changes a checkpoint does not see, is protected", async () => {
  scratch = await setUpJob();
  scratch.write("tracked.txt", "version 1\n");
  scratch.git("add", "tracked.txt");
  scratch.git("commit", "-q", "-m", "add tracked.txt");
  scratch.write("tracked.txt", "version 2\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.git("update-index", "--assume-unchanged", "tracked.txt");
  scratch.write("tracked.txt", "version 3, saved nowhere\n");
  const result = await changesNothing(["rollback", "2", "--yes"]);
  expect(result.code).toBe(8);
  expect(result.stderr).toStartWith("Rolling back would overwrite files relay has not saved: tracked.txt. ");
  expect(readFileSync(join(scratch.repo, "tracked.txt"), "utf8")).toBe("version 3, saved nowhere\n");
});
