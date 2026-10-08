// The start check of a headless agent that a handoff starts: an agent that reported its session keeps
// working past 60 seconds, and an agent that shows no sign of starting is stopped with the reason.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { relayIn, relayProcess, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";

setDefaultTimeout(150_000);

const fixtures: SwitchFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function claudeWorked(): Promise<SwitchFixture> {
  const fixture = await switchFixture();
  fixtures.push(fixture);
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
  return fixture;
}

// One command takes 61 seconds, longer than the start check.
const LONG_TURN = { turns: [{ steps: [
  { say: "Reading .relay/checkpoint.md." }, { run: "bun test", delay_ms: 61_000 },
  { write: ".relay/verify.md", content: "| Claim | Holds | Evidence |\n" }, { say: "Verified." },
] }] };

test("a headless Codex and Claude Code that reported their session keep working after 60 seconds", async () => {
  const [codex, claude] = await Promise.all([claudeWorked(), claudeWorked()]);
  codex.scenarios.set({ codex: LONG_TURN });
  claude.scenarios.set({ claude: LONG_TURN });
  const runs = [
    relayProcess(codex, ["run", "codex:personal", "--headless", "--prompt", "Continue.", "--no-summary"]),
    relayProcess(claude, ["run", "claude:work", "--headless", "--prompt", "Continue.", "--no-summary"]),
  ];
  for (const run of runs) {
    const code = await run.exited;
    expect({ code, stderr: run.stderr() }).toEqual({ code: 0, stderr: "" });
    expect(run.stdout()).toContain("  changed .relay/verify.md\nTurn finished");
  }
});

test("a headless agent that shows no sign of starting is stopped, and relay says why", async () => {
  const fixture = await claudeWorked();
  fixture.scenarios.set({ claude: { startup_delay_ms: 8_000, turns: [{ steps: [{ say: "Too late." }] }] } });
  const result = await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Continue.", "--no-summary"], {
    env: { RELAY_TEST_HEADLESS_START_MS: "2000" },
  });
  expect(result.code).toBe(31);
  expect(result.stderr).toStartWith("Claude Code · work did not start: Claude Code did not report a session within 2 seconds.\n");
});
