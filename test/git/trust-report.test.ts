// The refusal text of the git-safety spec, compared byte for byte.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRepository, type Repository } from "../../src/git/repo";
import { compareTrust, recordTrust, trustReport } from "../../src/git/trust";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

const LAST_LINES = [
  "relay will not run git here until you check this change.",
  "If you made it yourself, run relay accept-git-changes in your terminal.",
];

let scratch: ScratchRepo;
let repo: Repository;
let jobDir: string;

beforeEach(async () => {
  scratch = makeScratchRepo();
  scratch.git("remote", "add", "origin", "https://example.com/repo.git");
  repo = await openRepository(scratch.repo);
  jobDir = join(scratch.relayHome, "jobs", "3f9a2c1d");
  await recordTrust(repo, jobDir);
});
afterEach(() => scratch.cleanup());

async function report(): Promise<string> {
  return trustReport(await compareTrust(repo, jobDir), repo).join("\n") + "\n";
}

test("core.fsmonitor added after init", async () => {
  scratch.git("config", "core.fsmonitor", "touch /tmp/pwned");
  expect(await report()).toBe(
    "Stopped: .git/config changed since this job started.\n" +
      "  added  core.fsmonitor (can run commands)\n" +
      "relay will not run git here until you check this change.\n" +
      "If you made it yourself, run relay accept-git-changes in your terminal.\n",
  );
});

test("hook added after init", async () => {
  writeFileSync(join(scratch.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await report()).toBe(
    ["Stopped: the git hooks changed since this job started.", "  added  pre-commit", ...LAST_LINES].join("\n") + "\n",
  );
});

test("value changed without a new key", async () => {
  scratch.git("remote", "set-url", "origin", "https://example.com/other.git");
  expect(await report()).toBe(
    [
      "Stopped: .git/config changed since this job started.",
      "  changed  remote.origin.url",
      ...LAST_LINES,
    ].join("\n") + "\n",
  );
});

test("info/attributes created after init", async () => {
  writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "* filter=planted\n");
  expect(await report()).toBe(["Stopped: .git/info/attributes changed since this job started.", ...LAST_LINES].join("\n") + "\n");
});

test("global configuration changed names ~/.gitconfig", async () => {
  writeFileSync(join(scratch.home, ".gitconfig"), "[user]\n\tname = Someone\n");
  expect(await report()).toBe(
    ["Stopped: ~/.gitconfig changed since this job started.", "  added  user.name", ...LAST_LINES].join("\n") + "\n",
  );
});

test("several changes print one block for each file and the last two lines once", async () => {
  scratch.git("config", "core.fsmonitor", "touch /tmp/pwned");
  writeFileSync(join(scratch.repo, ".git", "info", "attributes"), "* filter=planted\n");
  writeFileSync(join(scratch.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await report()).toBe(
    [
      "Stopped: .git/config changed since this job started.",
      "  added  core.fsmonitor (can run commands)",
      "Stopped: .git/info/attributes changed since this job started.",
      "Stopped: the git hooks changed since this job started.",
      "  added  pre-commit",
      ...LAST_LINES,
    ].join("\n") + "\n",
  );
});
