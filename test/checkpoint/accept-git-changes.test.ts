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
      "Stopped: the git hooks changed since this job started.",
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
        "Stopped: .git/config changed since this job started.",
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

test("a change made while relay waits for the answer is not trusted with the change shown", async () => {
  scratch = await setUpJob();
  addHook("pre-commit");
  const result = await relay(scratch, ["accept-git-changes"], {
    terminal: { answer: "yes", beforeAnswer: () => addHook("post-checkout") },
    quiet: true,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("post-checkout");
  scratch.write("notes.txt", "changed\n");
  expect(await relay(scratch, ["checkpoint"], { quiet: true })).toEqual({
    code: 5,
    stdout: "",
    stderr: ["Stopped: the git hooks changed since this job started.", "  added  post-checkout", ...CLOSING, ""].join("\n"),
  });
});

test("control characters in a hook name are shown escaped before the question", async () => {
  scratch = await setUpJob();
  addHook("pre-commit\u001b[2K\r ");
  const result = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "no" }, quiet: true });
  expect(result.stdout).toBe([
    "Stopped: the git hooks changed since this job started.",
    "  added  pre-commit\\x1B[2K\\x0D\\u{2028}",
    "Trust these changes? Type yes to continue: ",
  ].join("\n"));
});

test.each(["missing", "damaged"] as const)("a %s trust record can be written again after yes", async (problem) => {
  scratch = await setUpJob();
  if (problem === "missing") rmSync(trustFile());
  // A record cut short, as a full disk could leave it.
  else writeFileSync(trustFile(), trustBytes().slice(0, 100));
  const message = `The git trust record ${trustFile()} is ${problem}.`;
  scratch.write("notes.txt", "changed\n");
  expect(await relay(scratch, ["checkpoint"], { quiet: true })).toEqual({ code: 5, stdout: "", stderr: `${message}\n` });

  const declined = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "no" }, quiet: true });
  expect(declined).toEqual({
    code: 7,
    stdout: [
      message,
      "relay cannot tell what changed in the git configuration or hooks since this job started.",
      "Trust the current git configuration and hooks? Type yes to continue: ",
    ].join("\n"),
    stderr: "Cancelled. Nothing changed.\n",
  });
  if (problem === "missing") expect(() => statSync(trustFile())).toThrow();

  const accepted = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" }, quiet: problem === "damaged" });
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toEndWith("Type yes to continue: Trusted the current git configuration and hooks.\n");
  expect(JSON.parse(trustBytes())).toMatchObject({ schema_version: 1, job_id: jobId(scratch), worktree_root: scratch.repo });
  expect(statSync(trustFile()).mode & 0o777).toBe(0o600);
  expect(events(scratch).at(-1)).toMatchObject({ type: "git_changes_accepted", data: { changed: [], trust_record: problem } });
  expect(await checkpointCode()).toBe(0);
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
