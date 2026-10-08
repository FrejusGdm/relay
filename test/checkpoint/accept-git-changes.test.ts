// relay accept-git-changes (tasks.md 8.1, the git-safety spec): only the person at a terminal can
// trust a change to the git settings or hooks, and only by typing yes. Terminals are simulated
// through the io of runRelayInProcess. With RELAY_DOC_SAMPLES=1 the tests print each command and
// its exact output, for docs/checkpoints.md.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventsText, events, jobId, relay, relayRefs, setUpJob } from "../helpers/job";
import type { ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

let scratch: ScratchRepo;

setDefaultTimeout(30_000);
beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

const CLOSING = [
  "relay will not run git here until you check this change.",
  "If you made it yourself, run relay accept-git-changes in your terminal.",
];
const trustFile = () => join(scratch.relayHome, "jobs", jobId(scratch), "git-trust.json");
const trustBytes = () => readFileSync(trustFile(), "utf8");
const hook = (name: string) => join(scratch.repo, ".git", "hooks", name);
const addHook = (name: string) => writeFileSync(hook(name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

async function checkpointCode(): Promise<number> {
  scratch.write("notes.txt", `changed ${relayRefs(scratch).length}\n`);
  return (await relay(scratch, ["checkpoint"], { quiet: true })).code;
}

test("without a terminal, relay accept-git-changes exits 7 and changes nothing", async () => {
  scratch = await setUpJob();
  addHook("pre-commit");
  const before = { trust: trustBytes(), events: eventsText(scratch) };
  expect(await relay(scratch, ["accept-git-changes"])).toEqual({
    code: 7,
    stdout: "",
    stderr: "relay accept-git-changes must be run by you in a terminal.\n",
  });
  expect({ trust: trustBytes(), events: eventsText(scratch) }).toEqual(before);
  expect(await checkpointCode()).toBe(5);
});

test("at a terminal, yes rewrites the trust record, appends git_changes_accepted, and checkpoints work again", async () => {
  scratch = await setUpJob();
  addHook("pre-commit");
  const refused = await relay(scratch, ["checkpoint"]);
  expect(refused).toEqual({
    code: 5,
    stdout: "",
    stderr: ["Stopped: the git hooks changed since this job started.", "  added  pre-commit", ...CLOSING, ""].join("\n"),
  });
  const before = trustBytes();
  expect(await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" } })).toEqual({
    code: 0,
    stdout: [
      "The git hooks changed since this job started.",
      "  added  pre-commit",
      "Trust these changes? Type yes to continue: Trusted the current git configuration and hooks.",
      "",
    ].join("\n"),
    stderr: "",
  });
  expect(trustBytes()).not.toBe(before);
  expect(statSync(trustFile()).mode & 0o777).toBe(0o600);
  expect(events(scratch).at(-1)).toMatchObject({ type: "git_changes_accepted", data: { changed: [hook("pre-commit")] } });
  expect(await checkpointCode()).toBe(0);
});

test("any answer other than yes changes nothing", async () => {
  scratch = await setUpJob();
  scratch.git("config", "core.fsmonitor", "touch pwned");
  for (const answer of ["no", "y", "YES", "yes please", "", null]) {
    const before = { trust: trustBytes(), events: eventsText(scratch) };
    const result = await relay(scratch, ["accept-git-changes"], { terminal: { answer }, quiet: answer !== "no" });
    expect(result).toEqual({
      code: 7,
      stdout: [
        ".git/config changed since this job started.",
        "  added  core.fsmonitor (can run commands)",
        "Trust these changes? Type yes to continue: ",
      ].join("\n"),
      stderr: "Cancelled. Nothing changed.\n",
    });
    expect({ trust: trustBytes(), events: eventsText(scratch) }).toEqual(before);
  }
  expect(await checkpointCode()).toBe(5);
});

test("when nothing changed, relay says so and changes nothing", async () => {
  scratch = await setUpJob();
  const before = { trust: trustBytes(), events: eventsText(scratch) };
  expect(await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" } })).toEqual({
    code: 0,
    stdout: "Nothing changed in the git configuration or hooks.\n",
    stderr: "",
  });
  expect({ trust: trustBytes(), events: eventsText(scratch) }).toEqual(before);
});

const WAITED = "The git settings or hooks changed while relay was waiting. Nothing was trusted. Run relay accept-git-changes again.\n";

test("a hook added while relay waits for the answer makes yes trust nothing", async () => {
  scratch = await setUpJob();
  addHook("pre-commit");
  const before = { trust: trustBytes(), events: eventsText(scratch) };
  const result = await relay(scratch, ["accept-git-changes"], {
    terminal: { answer: "yes", beforeAnswer: () => addHook("post-checkout") },
  });
  expect(result).toEqual({
    code: 7,
    stdout: ["The git hooks changed since this job started.", "  added  pre-commit", "Trust these changes? Type yes to continue: "].join("\n"),
    stderr: WAITED,
  });
  expect({ trust: trustBytes(), events: eventsText(scratch) }).toEqual(before);
  expect(await checkpointCode()).toBe(5);
});

test("a hook shown as harmless, then changed back while relay waits, is not trusted", async () => {
  scratch = await setUpJob();
  // The hook as the report reads it, and the content an agent puts back during the wait.
  writeFileSync(hook("pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const before = { trust: trustBytes(), events: eventsText(scratch) };
  const result = await relay(scratch, ["accept-git-changes"], {
    terminal: { answer: "yes", beforeAnswer: () => writeFileSync(hook("pre-commit"), "#!/bin/sh\ntouch pwned\n") },
    quiet: true,
  });
  expect(result.code).toBe(7);
  expect(result.stderr).toBe(WAITED);
  expect({ trust: trustBytes(), events: eventsText(scratch) }).toEqual(before);
  expect(await checkpointCode()).toBe(5);
});

test("control characters in a hook name are shown escaped before the question", async () => {
  scratch = await setUpJob();
  addHook("pre-commit\u001b[2K\r ");
  const result = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "no" }, quiet: true });
  expect(result.stdout).toBe([
    "The git hooks changed since this job started.",
    "  added  pre-commit\\x1B[2K\\x0D\\u{2028}",
    "Trust these changes? Type yes to continue: ",
  ].join("\n"));
});

const BROKEN: [string, "missing" | "damaged", () => void][] = [
  ["missing", "missing", () => rmSync(trustFile())],
  // A record cut short, as a full disk could leave it.
  ["cut short", "damaged", () => writeFileSync(trustFile(), trustBytes().slice(0, 100))],
  ["{}", "damaged", () => writeFileSync(trustFile(), "{}\n")],
  ["null", "damaged", () => writeFileSync(trustFile(), "null\n")],
];

test.each(BROKEN)("a trust record that is %s can be written again after yes", async (name, problem, breakRecord) => {
  scratch = await setUpJob();
  scratch.git("config", "core.fsmonitor", "touch pwned");
  addHook("pre-commit");
  breakRecord();
  const message = `The git trust record ${trustFile()} is ${problem}.`;
  scratch.write("notes.txt", "changed\n");
  expect(await relay(scratch, ["checkpoint"], { quiet: true })).toEqual({ code: 5, stdout: "", stderr: `${message}\n` });

  const declined = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "no" }, quiet: name !== "missing" });
  expect(declined).toEqual({
    code: 7,
    stdout: [
      message,
      "relay cannot tell what changed in the git configuration or hooks since this job started.",
      "These settings can run commands or change where git writes files:",
      "  core.fsmonitor (can run commands)",
      "These hooks exist:",
      "  pre-commit",
      "Trust the current git configuration and hooks? Type yes to continue: ",
    ].join("\n"),
    stderr: "Cancelled. Nothing changed.\n",
  });
  if (problem === "missing") expect(() => statSync(trustFile())).toThrow();

  const accepted = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" }, quiet: true });
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toEndWith("Type yes to continue: Trusted the current git configuration and hooks.\n");
  expect(JSON.parse(trustBytes())).toMatchObject({ schema_version: 1, job_id: jobId(scratch), worktree_root: scratch.repo });
  expect(statSync(trustFile()).mode & 0o777).toBe(0o600);
  expect(events(scratch).at(-1)).toMatchObject({ type: "git_changes_accepted", data: { changed: [], trust_record: problem } });
  expect(await checkpointCode()).toBe(0);
});

test("without a record, an empty list says none", async () => {
  scratch = await setUpJob();
  rmSync(trustFile());
  const result = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "no" }, quiet: true });
  expect(result.stdout.split("\n").slice(2, 6)).toEqual([
    "These settings can run commands or change where git writes files:",
    "  none",
    "These hooks exist:",
    "  none",
  ]);
});

test("a readable trust record of another checkout is refused with exit code 3", async () => {
  scratch = await setUpJob();
  writeFileSync(trustFile(), trustBytes().replace(JSON.stringify(scratch.repo), JSON.stringify(join(scratch.root, "other"))));
  const before = trustBytes();
  const result = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" }, quiet: true });
  expect(result.code).toBe(3);
  expect(result.stderr).toEndWith("which relay init did not set up in this checkout. relay changed nothing.\n");
  expect(trustBytes()).toBe(before);
});

test("outside a job, relay accept-git-changes exits 3", async () => {
  scratch = await setUpJob();
  rmSync(join(scratch.repo, ".relay"), { recursive: true });
  expect(await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" }, quiet: true })).toEqual({
    code: 3,
    stdout: "",
    stderr: "relay is not set up here. Run relay init first.\n",
  });
});
