// The checkpoint commit and its refs (tasks.md 5.2): message and trailers, message cleaning,
// identity, no signing, and the ref transaction when two saves run at once.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { cleanMessage, commitCheckpoint, gitFailed, readJobRefs, type CommitInput } from "../../src/checkpoint/commit";
import { VERSION } from "../../src/core/version";
import { openRepository } from "../../src/git/repo";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

const JOB = "3f9a2c1d";
const PREFIX = `refs/relay/jobs/${JOB}/`;

let scratch: ScratchRepo;
afterEach(() => scratch.cleanup());

function input(tree: string, extra: Partial<CommitInput> = {}): CommitInput {
  return { jobId: JOB, tree, kind: "manual", message: null, leftOut: [], trailers: [], ...extra };
}

const headTree = () => scratch.git("rev-parse", "HEAD^{tree}").trim();
const trailers = (ref: string) =>
  scratch.git("for-each-ref", "--format=%(trailers:unfold,separator=%x0a)", ref).trim().split("\n");
const subject = (ref: string) => scratch.git("for-each-ref", "--format=%(contents:subject)", ref).trim();

async function save(extra: Partial<CommitInput> = {}) {
  const repo = await openRepository(scratch.repo);
  return await commitCheckpoint(repo, input(headTree(), extra), await readJobRefs(repo, JOB));
}

test("the message has the subject and the trailers in order, read back with for-each-ref", async () => {
  scratch = makeScratchRepo();
  const head = scratch.git("rev-parse", "HEAD").trim();
  const saved = await save({ message: "OAuth callback works", leftOut: ["assets/demo.mov"] });
  expect(saved).toEqual({ number: 1, commit: saved.commit, ref: `${PREFIX}checkpoints/1`, parent: head });
  expect(subject(saved.ref)).toBe("relay checkpoint 1: OAuth callback works");
  expect(trailers(saved.ref)).toEqual([
    `Relay-Job: ${JOB}`,
    "Relay-Checkpoint: 1",
    "Relay-Kind: manual",
    `Relay-Head: ${head}`,
    "Relay-Branch: main",
    "Relay-Left-Out: assets/demo.mov",
    `Relay-Version: ${VERSION}`,
  ]);
  expect(scratch.git("for-each-ref", "--format=%(trailers:key=Relay-Kind,valueonly=true)", saved.ref).trim()).toBe("manual");
  expect(scratch.git("rev-parse", `${PREFIX}latest`).trim()).toBe(saved.commit);
  expect(scratch.git("rev-parse", `${saved.ref}^{tree}`).trim()).toBe(headTree());

  const second = await save({ kind: "handoff", trailers: [["Relay-Worker", "5d2e8f01"], ["Relay-Target", "claude:personal"]] });
  expect(second.number).toBe(2);
  expect(second.parent).toBe(saved.commit);
  expect(subject(second.ref)).toBe("relay checkpoint 2");
  expect(trailers(second.ref)).toContain("Relay-Kind: handoff");
  expect(trailers(second.ref).slice(-3)).toEqual(["Relay-Worker: 5d2e8f01", "Relay-Target: claude:personal", `Relay-Version: ${VERSION}`]);
  expect(scratch.git("rev-parse", `${PREFIX}latest`).trim()).toBe(second.commit);
});

test("a message loses newlines and invisible characters and is cut to 200 characters", () => {
  expect(cleanMessage("Login\nform​ done")).toBe("Login form done");
  expect(cleanMessage("a\r\nb")).toBe("a b");
  expect(cleanMessage(`${"é".repeat(250)}`)).toBe("é".repeat(200));
  expect(cleanMessage("​ \n")).toBeNull();
  expect(cleanMessage(undefined)).toBeNull();
});

test("more than 50 left-out files give 49 trailers and one that counts the rest", async () => {
  scratch = makeScratchRepo();
  const leftOut = Array.from({ length: 60 }, (_, i) => `big/${i}.bin`);
  const lines = trailers((await save({ leftOut })).ref).filter((line) => line.startsWith("Relay-Left-Out: "));
  expect(lines).toHaveLength(50);
  expect(lines.at(-2)).toBe("Relay-Left-Out: big/48.bin");
  expect(lines.at(-1)).toBe("Relay-Left-Out: and 11 more");
});

test("commit signing in the person's settings is ignored and its program never starts", async () => {
  scratch = makeScratchRepo();
  const marker = join(scratch.root, "signed");
  const program = join(scratch.root, "fake-gpg");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(program, 0o755);
  scratch.git("config", "commit.gpgSign", "true");
  scratch.git("config", "gpg.program", program);
  const saved = await save();
  expect(scratch.git("cat-file", "commit", saved.commit)).not.toContain("gpgsig");
  expect(existsSync(marker)).toBe(false);
});

test("without user.email, the commit uses relay@localhost", async () => {
  scratch = makeScratchRepo();
  scratch.git("config", "user.name", "Pat Person");
  const saved = await save();
  expect(scratch.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", saved.commit).trim()).toBe(
    "Pat Person <relay@localhost>|Pat Person <relay@localhost>",
  );
  scratch.git("config", "user.email", "pat@example.com");
  const next = await save();
  expect(scratch.git("log", "-1", "--format=%an <%ae>", next.commit).trim()).toBe("Pat Person <pat@example.com>");
});

test("in a repository with no commits, the first checkpoint has no parent and Relay-Head none", async () => {
  scratch = makeScratchRepo("empty");
  const repo = await openRepository(scratch.repo);
  const emptyTree = scratch.git("hash-object", "-t", "tree", "/dev/null").trim();
  const saved = await commitCheckpoint(repo, input(emptyTree), await readJobRefs(repo, JOB));
  expect(saved.parent).toBeNull();
  expect(scratch.git("rev-list", "--parents", "-1", saved.commit).trim()).toBe(saved.commit);
  expect(trailers(saved.ref)).toContain("Relay-Head: none");
});

test("two saves at the same time get numbers 1 and 2, or one stops with exit code 6, and no ref is overwritten", async () => {
  scratch = makeScratchRepo();
  const repo = await openRepository(scratch.repo);
  const refs = await readJobRefs(repo, JOB);
  const results = await Promise.allSettled([0, 1].map(() => commitCheckpoint(repo, input(headTree()), refs)));
  const saved = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  for (const result of results) {
    if (result.status === "rejected") expect((result.reason as CommandError).code).toBe(6);
  }
  expect(saved.map((one) => one.number).sort()).toEqual(saved.length === 2 ? [1, 2] : [1]);
  for (const one of saved) {
    expect(scratch.git("rev-parse", one.ref).trim()).toBe(one.commit);
    expect(trailers(one.ref)).toContain(`Relay-Checkpoint: ${one.number}`);
  }
  const newest = saved.sort((a, b) => b.number - a.number)[0]!;
  expect(scratch.git("rev-parse", `${PREFIX}latest`).trim()).toBe(newest.commit);
  expect(await readJobRefs(repo, JOB)).toEqual({ highest: saved.length, count: saved.length, latest: newest.commit });
});

test("a ref that already holds the next number is never overwritten", async () => {
  scratch = makeScratchRepo();
  const repo = await openRepository(scratch.repo);
  const first = await save();
  // Another command took number 2 after these refs were read.
  const stale = await readJobRefs(repo, JOB);
  scratch.git("update-ref", `${PREFIX}checkpoints/2`, first.commit);
  scratch.git("update-ref", `${PREFIX}latest`, first.commit);
  const saved = await commitCheckpoint(repo, input(headTree()), stale);
  expect(saved.number).toBe(3);
  expect(scratch.git("rev-parse", `${PREFIX}checkpoints/2`).trim()).toBe(first.commit);
});

test("a git error is printed one line at a time, each line escaped", () => {
  const error = gitFailed("relay could not build the checkpoint: git add failed", "fatal: one\nhint: two \u001b[31m\n");
  expect(error.code).toBe(1);
  expect(error.lines).toEqual(["relay could not build the checkpoint: git add failed.", "  fatal: one", "  hint: two \\u001b[31m"]);
});
