// The handoff scan with the real gitleaks: a GitHub token planted in the notes is found, and no
// output or file keeps it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { scanHandoff } from "../../src/handoff/scan";
import { fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

let relayHome: string;
beforeAll(() => {
  requireGitleaks();
  relayHome = mkdtempSync(join(realpathSync(tmpdir()), "relay-scan-"));
});
afterAll(() => rmSync(relayHome, { recursive: true, force: true }));

test("real gitleaks finds a planted GitHub token in the notes", async () => {
  const token = fakeGithubToken();
  const notes = `## Done\n- The login form.\n\n## Problems\n- The test account uses ${token}\n`;
  const error = await scanHandoff(
    { checkpointMd: `# Checkpoint\n\n${notes}`, checkOutput: { from: 0, to: 0 }, stateJson: "{}\n", events: "", instructions: "Instructions.\n", prompt: "Continue.\n", notes },
    { from: "claude", to: { id: "codex:personal", provider: "codex" }, checkpoint: "912ec1", env: { ...process.env, RELAY_HOME: relayHome, RELAY_GITLEAKS: "" } },
  ).then(() => null, (caught) => caught as CommandError);
  expect(error).toBeInstanceOf(CommandError);
  expect(error!.code).toBe(4);
  expect(error!.lines[0]).toBe("Stopped: possible secret in Claude Code's handoff notes, line 5 (github-pat).");
  expect(error!.lines.join("\n")).not.toContain(token);
  expect(filesContaining(relayHome, token)).toEqual([]);
});
