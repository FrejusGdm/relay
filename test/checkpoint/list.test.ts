// relay checkpoints (tasks.md 6.1): the checkpoints spec, "Listing checkpoints". Every test
// compares captureState() and events.jsonl before and after, because listing only reads.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listLines } from "../../src/cli/commands/checkpoints";
import { listCheckpoints } from "../../src/checkpoint/list";
import { saveCheckpoint } from "../../src/checkpoint/save";
import { openRepository } from "../../src/git/repo";
import { eventsText, jobId, personState, ref, relay, setUpJob, sha, state } from "../helpers/job";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

const MB = 1024 * 1024;
let scratch: ScratchRepo;

setDefaultTimeout(30_000);
beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

// Checkpoints 1 (baseline), 2 (manual, "Login form done", with a left-out file) and 3
// (pre_rollback, saved through saveCheckpoint as relay rollback saves it).
async function threeKinds(): Promise<void> {
  scratch = await setUpJob("full", 1);
  scratch.write("src/auth.ts", "export const login = 1;\n");
  writeFileSync(join(scratch.repo, "big.bin"), Buffer.alloc(2 * MB, 1));
  expect((await relay(scratch, ["checkpoint", "-m", "Login form done"], { quiet: true })).code).toBe(0);
  scratch.write("src/auth.ts", "export const login = 2;\n");
  await saveCheckpoint(await openRepository(scratch.repo), {
    relayHome: scratch.relayHome,
    command: "rollback",
    kind: "pre_rollback",
    maxFileSizeMb: 1,
    env: process.env,
    message: "Before rolling back to checkpoint 2",
  });
}

test("the text list shows one aligned row per checkpoint, newest first", async () => {
  await threeKinds();
  const list = await listCheckpoints(await openRepository(scratch.repo), jobId(scratch));
  // Times as in the spec's example: 5 minutes, 2 hours and 3 hours before now.
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = [5 * 60, 2 * 3600, 3 * 3600].map((seconds) => new Date(now.getTime() - seconds * 1000));
  const lines = listLines(jobId(scratch), "Build authentication", list.map((item, i) => ({ ...item, createdAt: ago[i]! })), now);
  const short = (n: number) => sha(scratch, ref(scratch, n)).slice(0, 7);
  expect(lines).toEqual([
    `Job ${jobId(scratch)} · Build authentication`,
    "",
    `3  ${short(3)}  before rollback  5 minutes ago  Before rolling back to checkpoint 2`,
    `2  ${short(2)}  manual           2 hours ago    Login form done`,
    `1  ${short(1)}  baseline         3 hours ago`,
  ]);

  const before = personState(scratch.repo);
  const events = eventsText(scratch);
  const result = await relay(scratch, ["checkpoints"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const rows = result.stdout.split("\n");
  expect(rows.slice(0, 2)).toEqual([`Job ${jobId(scratch)} · ${state(scratch).title}`, ""]);
  expect(rows[2]).toMatch(new RegExp(`^3  ${short(3)}  before rollback  \\d+ seconds? ago +Before rolling back to checkpoint 2$`));
  expect(rows[3]).toMatch(new RegExp(`^2  ${short(2)}  manual {11}\\d+ seconds? ago +Login form done$`));
  expect(rows[4]).toMatch(new RegExp(`^1  ${short(1)}  baseline {9}\\d+ seconds? ago$`));
  expect(rows.slice(5)).toEqual([""]);
  expect(personState(scratch.repo)).toEqual(before);
  expect(eventsText(scratch)).toBe(events);
});

test("the JSON list has the fields of the spec, newest first", async () => {
  await threeKinds();
  const before = personState(scratch.repo);
  const result = await relay(scratch, ["checkpoints", "--json"]);
  expect(result.code).toBe(0);
  const list = JSON.parse(result.stdout);
  expect(list.map((item: { number: number }) => item.number)).toEqual([3, 2, 1]);
  const head = sha(scratch, "HEAD");
  const expected = [
    { number: 3, kind: "pre_rollback", message: "Before rolling back to checkpoint 2", left_out: ["big.bin"] },
    { number: 2, kind: "manual", message: "Login form done", left_out: ["big.bin"] },
    { number: 1, kind: "baseline", message: null, left_out: [] },
  ];
  for (const [i, item] of list.entries()) {
    expect(Object.keys(item)).toEqual(["number", "commit", "ref", "kind", "message", "created_at", "head", "left_out"]);
    expect(item).toEqual({
      ...expected[i]!,
      commit: sha(scratch, ref(scratch, item.number)),
      ref: ref(scratch, item.number),
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/),
      head,
    });
    expect(Math.abs(Date.parse(item.created_at) - Date.now())).toBeLessThan(60_000);
  }
  expect(personState(scratch.repo)).toEqual(before);
});

test("a job with only a baseline lists one checkpoint; without commits its head is null", async () => {
  scratch = makeScratchRepo("empty");
  scratch.write("first.txt", "first\n");
  expect((await relay(scratch, ["init", "--title", "First steps"], { quiet: true })).code).toBe(0);
  const before = personState(scratch.repo);
  const text = await relay(scratch, ["checkpoints"]);
  expect(text.stdout).toMatch(
    new RegExp(`^Job ${jobId(scratch)} · First steps\\n\\n1  ${sha(scratch, ref(scratch, 1)).slice(0, 7)}  baseline  \\d+ seconds? ago\\n$`),
  );
  const json = JSON.parse((await relay(scratch, ["checkpoints", "--json"])).stdout);
  expect(json).toHaveLength(1);
  expect(json[0]).toMatchObject({ number: 1, kind: "baseline", message: null, head: null, left_out: [] });
  expect(personState(scratch.repo)).toEqual(before);
  expect(state(scratch).checkpoint_count).toBe(1);
});

test("a job whose baseline was not saved lists no checkpoint", async () => {
  scratch = makeScratchRepo("empty");
  const lines = listLines("3f9a2c1d", "Demo", [], new Date());
  expect(lines).toEqual(["Job 3f9a2c1d · Demo", "", "No checkpoints yet. Save one with relay checkpoint."]);
});

test("without a job relay checkpoints exits 3; after a git setting changed it exits 5 and appends no event", async () => {
  scratch = makeScratchRepo();
  expect(await relay(scratch, ["checkpoints"])).toEqual({
    code: 3,
    stdout: "",
    stderr: "relay is not set up here. Run relay init first.\n",
  });
  expect((await relay(scratch, ["init"], { quiet: true })).code).toBe(0);
  const marker = join(scratch.root, "fsmonitor-ran");
  scratch.git("config", "core.fsmonitor", `touch ${marker}`);
  const events = eventsText(scratch);
  const result = await relay(scratch, ["checkpoints"]);
  expect(result.code).toBe(5);
  expect(result.stderr.split("\n")[0]).toBe("Stopped: .git/config changed since this job started.");
  expect(eventsText(scratch)).toBe(events);
  expect(await Bun.file(marker).exists()).toBe(false);
});
