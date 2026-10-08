import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandError } from "../../src/cli/errors";
import { scanHandoff, type HandoffTexts } from "../../src/handoff/scan";
import { FAKE_GITLEAKS } from "./job";

const TEXTS: HandoffTexts = {
  checkpointMd: "# Checkpoint 912ec1\n\nfacts\n\n## Output of failing checks\n\nexcerpt\n\n## Commits since the job started\n",
  checkOutput: { from: 5, to: 8 },
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

  test("a secret in a check's output inside checkpoint.md", async () => {
    const error = await refused({ checkpointMd: TEXTS.checkpointMd.replace("excerpt", "FAKE-SECRET:aws-access-token") });
    expect(error.lines).toEqual([
      "Stopped: possible secret in the new .relay/checkpoint.md, line 7 (aws-access-token).",
      NOT_SENT,
      "Fix the output of the check, or change the checks with --check.",
    ]);
  });

  test.each([
    ["checkpointMd", "the new .relay/checkpoint.md", "facts FAKE-SECRET\n"],
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
