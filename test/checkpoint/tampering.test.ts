// Tampering between checkpoints (tasks.md 8.2, the git-safety spec). Part one: a change to the git
// settings, the hooks, info/attributes or ~/.gitconfig after relay init stops relay checkpoint and
// relay rollback with exit code 5, before any planted program can run. Part two: once the person
// has accepted such changes, relay works again and still runs none of the planted programs.
// With RELAY_DOC_SAMPLES=1 the tests print each command and its exact output, for
// docs/checkpoints.md.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, personState, relay, relayRefs, setUpJob } from "../helpers/job";
import { plainGit, type ScratchRepo } from "../helpers/scratch-repo";
import { requireGitleaks } from "../helpers/secrets";

let scratch: ScratchRepo;

setDefaultTimeout(60_000);
beforeEach(() => requireGitleaks());
afterEach(() => scratch.cleanup());

const CLOSING = [
  "relay will not run git here until you check this change.",
  "If you made it yourself, run relay accept-git-changes in your terminal.",
];
const markers = () => join(scratch.root, "markers");
const markersMade = () => readdirSync(markers()).sort();

// A program that leaves the marker file `name` when it runs, and the path to start it.
function planted(name: string): string {
  mkdirSync(markers(), { recursive: true });
  const path = join(scratch.root, `plant-${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ntouch '${join(markers(), name)}'\n`, { mode: 0o755 });
  return path;
}

function plantHook(name: string): void {
  writeFileSync(join(scratch.repo, ".git", "hooks", name), `#!/bin/sh\nexec '${planted(name)}'\n`, { mode: 0o755 });
}

// Runs plain git, without relay's protections, and checks that it runs the planted program
// `marker`; then removes the marker, so a later check sees only what relay runs.
function provePlantedRuns(marker: string, args: string[], env: Record<string, string> = {}): void {
  plainGit(scratch.repo, args, env);
  expect(markersMade()).toContain(marker);
  rmSync(markers(), { recursive: true });
  mkdirSync(markers());
}

// git 2.54 and newer run hooks defined in the settings; older versions ignore those keys.
const runsConfigHooks = () => !/^git version 2\.([0-4]\d|5[0-3])\./.test(scratch.git("version").trim());

// A job with checkpoint 2, and a file changed since, so both a checkpoint and a rollback have
// work to do.
async function jobWithWork(): Promise<void> {
  scratch = await setUpJob();
  mkdirSync(markers());
  scratch.write("src/auth.ts", "export const login = 1;\n");
  expect((await relay(scratch, ["checkpoint"], { quiet: true })).code).toBe(0);
  scratch.write("src/auth.ts", "export const login = 2;\n");
}

// Each change, the report relay prints, and the plain git command that shows the planted
// program runs (none for info/attributes, which only names a filter).
const TAMPERING: [string, () => void, string[], [string, string[]] | null][] = [
  [
    "core.fsmonitor set in .git/config",
    () => scratch.git("config", "core.fsmonitor", planted("fsmonitor")),
    ["Stopped: .git/config changed since this job started.", "  added  core.fsmonitor (can run commands)"],
    ["fsmonitor", ["status"]],
  ],
  [
    "a pre-commit hook added",
    () => plantHook("pre-commit"),
    ["Stopped: the git hooks changed since this job started.", "  added  pre-commit"],
    ["pre-commit", ["hook", "run", "pre-commit"]],
  ],
  [
    "info/attributes created",
    () => writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "* filter=planted\n"),
    ["Stopped: .git/info/attributes changed since this job started."],
    null,
  ],
  [
    "~/.gitconfig changed",
    () => writeFileSync(join(scratch.home, ".gitconfig"), `[core]\n\tfsmonitor = ${planted("global-fsmonitor")}\n`),
    ["Stopped: ~/.gitconfig changed since this job started.", "  added  core.fsmonitor (can run commands)"],
    ["global-fsmonitor", ["status"]],
  ],
];

test.each(TAMPERING)("%s stops relay checkpoint and relay rollback with exit code 5", async (_name, tamper, report, proof) => {
  await jobWithWork();
  tamper();
  if (proof !== null) provePlantedRuns(...proof);
  const before = { person: personState(scratch.repo), refs: relayRefs(scratch) };
  const refusal = { code: 5, stdout: "", stderr: [...report, ...CLOSING, ""].join("\n") };
  expect(await relay(scratch, ["checkpoint"])).toEqual(refusal);
  expect(await relay(scratch, ["rollback", "--yes"], { quiet: true })).toEqual(refusal);
  expect({ person: personState(scratch.repo), refs: relayRefs(scratch) }).toEqual(before);
  expect(events(scratch).slice(-2).map((event) => [event.type, event.data.command, event.data.reason])).toEqual([
    ["checkpoint_refused", "checkpoint", "git_changed"],
    ["checkpoint_refused", "rollback", "git_changed"],
  ]);
  expect(markersMade()).toEqual([]);
});

test("after the person accepts planted hooks and settings, checkpoints and rollbacks work and run none of them", async () => {
  await jobWithWork();
  scratch.git("config", "core.fsmonitor", planted("fsmonitor"));
  writeFileSync(join(scratch.home, ".gitconfig"), `[core]\n\tfsmonitor = ${planted("global-fsmonitor")}\n`);
  writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "* filter=planted\n");
  for (const name of ["pre-commit", "post-checkout", "post-index-change", "reference-transaction"]) plantHook(name);
  // Hooks defined in the settings (git 2.54 and newer); older versions ignore these keys.
  for (const event of ["reference-transaction", "post-index-change"]) {
    scratch.git("config", `hook.planted-${event}.command`, planted(`config-${event}`));
    scratch.git("config", `hook.planted-${event}.event`, event);
  }
  // Plain git runs every planted program.
  provePlantedRuns("fsmonitor", ["status"]);
  provePlantedRuns("pre-commit", ["hook", "run", "pre-commit"]);
  const otherTree = mkdtempSync(join(scratch.root, "tree-"));
  const otherIndex = { GIT_INDEX_FILE: join(scratch.root, "proof.index") };
  provePlantedRuns("post-checkout", ["--work-tree", otherTree, "checkout", "HEAD", "--", "README.md"], otherIndex);
  provePlantedRuns("post-index-change", ["add", "-A"], otherIndex);
  if (runsConfigHooks()) provePlantedRuns("config-post-index-change", ["add", "-A"], otherIndex);
  provePlantedRuns("reference-transaction", ["update-ref", "refs/proof/one", "HEAD"]);
  if (runsConfigHooks()) provePlantedRuns("config-reference-transaction", ["update-ref", "refs/proof/two", "HEAD"]);
  provePlantedRuns("reference-transaction", ["update-ref", "-d", "refs/proof/one"]);
  if (runsConfigHooks()) provePlantedRuns("reference-transaction", ["update-ref", "-d", "refs/proof/two"]);

  const accepted = await relay(scratch, ["accept-git-changes"], { terminal: { answer: "yes" } });
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toEndWith("Trusted the current git configuration and hooks.\n");

  const saved = await relay(scratch, ["checkpoint"], { quiet: true });
  expect(saved.code).toBe(0);
  expect(saved.stdout).toStartWith("Saved checkpoint 3 · ");
  scratch.write("src/auth.ts", "export const login = 3;\n");
  const rolledBack = await relay(scratch, ["rollback", "--yes"], { quiet: true });
  expect(rolledBack.code).toBe(0);
  expect(rolledBack.stdout).toContain("Rolled back to checkpoint 3 · ");
  expect(markersMade()).toEqual([]);
});
