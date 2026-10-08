import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandError } from "../../src/cli/errors";
import { scanHandoff, type HandoffTexts } from "../../src/handoff/scan";
import { FAKE_GITLEAKS } from "./job";

// Lines 1-3 facts, 4-5 files, 6 fence, 7-9 notes, 10-12 check output, 13-15 commits, 16-18 events.
const TEXTS: HandoffTexts = {
  checkpointMd: ["# Checkpoint 912ec1", "", "facts", "    file.ts | 1 +", "", "<<<fence", "", "## Notes", "",
    "## Output of failing checks", "excerpt", "", "## Commits", "    a1b2c3d subject", "", "## Recent events", "- 14:02 ran `x`", ""].join("\n"),
  sections: [
    { name: "the facts relay checked", from: 1, to: 3 },
    { name: "the list of changed files", from: 4, to: 5 },
    { name: "the notes", from: 7, to: 9 },
    { name: "the output of failing checks", from: 10, to: 12 },
    { name: "the commit messages", from: 13, to: 15 },
    { name: "the recent events", from: 16, to: 18 },
  ],
  stateJson: "{}\n", events: "{\"type\":\"handoff\"}\n", instructions: "Instructions.\n", prompt: "Continue.\n",
  notes: "## Done\n- a\n",
};
const CONTEXT = { from: "claude" as const, to: { id: "codex:personal", provider: "codex" as const }, checkpoint: "912ec1" };

beforeEach(() => { process.env.RELAY_GITLEAKS = FAKE_GITLEAKS; });
afterEach(() => {
  for (const name of ["RELAY_GITLEAKS", "FAKE_GITLEAKS_EXIT", "FAKE_GITLEAKS_STDERR"]) delete process.env[name];
});

async function refused(texts: Partial<HandoffTexts>): Promise<CommandError> {
  const error = await scanHandoff({ ...TEXTS, ...texts }, CONTEXT).then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

const NOT_SENT = "Nothing was written or sent. Claude Code is stopped, and your work is saved in checkpoint 912ec1.";
const OTHER_HINT = "Remove the secret from the file named above, then run relay switch codex:personal again.";

describe("Secret scan before anything is written or sent", () => {
  test("clean texts pass", async () => {
    await scanHandoff(TEXTS, CONTEXT);
    await scanHandoff({ ...TEXTS, notes: null }, CONTEXT);
  });

  test("a secret in the agent's notes names the notes and suggests --no-summary", async () => {
    const notes = `${"line\n".repeat(11)}key FAKE-SECRET:generic-api-key\n`;
    const error = await refused({ notes, checkpointMd: `${TEXTS.checkpointMd}${notes}` });
    expect([error.code, error.lines]).toEqual([4, [
      "Stopped: possible secret in Claude Code's handoff notes, line 12 (generic-api-key).",
      NOT_SENT,
      'Run "relay switch codex:personal --no-summary" to hand off without Claude Code\'s notes.',
    ]]);
  });

  test.each([
    ["excerpt", 11, "the output of failing checks", "Fix the output of the check, or change the checks with --check."],
    ["a1b2c3d subject", 14, "the commit messages", "Remove the secret from the commit message that holds it, then run relay switch codex:personal again."],
    ["file.ts | 1 +", 4, "the list of changed files", "Rename the file whose name holds the secret, then run relay switch codex:personal again."],
    ["ran `x`", 17, "the recent events", "Remove the secret from the command recorded in .relay/events.jsonl, then run relay switch codex:personal again."],
    ["facts", 3, "the facts relay checked", "Remove the secret from the job title, the branch name or the file it came from, then run relay switch codex:personal again."],
  ] as const)("a secret in checkpoint.md near %p names %s and gives its hint", async (text, line, section, hint) => {
    const error = await refused({ checkpointMd: TEXTS.checkpointMd.replace(text, `${text} FAKE-SECRET:aws-access-token`) });
    expect(error.lines).toEqual([`Stopped: possible secret in the new .relay/checkpoint.md, line ${line}, in ${section} (aws-access-token).`, NOT_SENT, hint]);
  });

  test.each([
    ["stateJson", "the new .relay/state.json", "FAKE-SECRET\n"],
    ["events", "the new events", "FAKE-SECRET\n"],
    ["instructions", "the instructions for Codex", "FAKE-SECRET\n"],
    ["prompt", "the prompt for Codex", "FAKE-SECRET\n"],
  ] as const)("a secret in %s names %p", async (part, label, text) => {
    const error = await refused({ [part]: text });
    expect(error.lines).toEqual([`Stopped: possible secret in ${label}, line 1 (fake-rule).`, NOT_SENT, OTHER_HINT]);
  });

  test("a scan that cannot finish stops with exit code 1", async () => {
    Object.assign(process.env, { FAKE_GITLEAKS_EXIT: "2", FAKE_GITLEAKS_STDERR: "failed to load config\nmore\n" });
    const error = await refused({});
    expect([error.code, error.lines]).toEqual([1, ["The secret scan did not finish: failed to load config. Nothing was written or sent."]]);
  });
});
