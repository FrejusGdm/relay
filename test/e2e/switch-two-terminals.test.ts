// relay run in terminal A and relay switch in terminal B (task 7.6): the lines in both terminals and
// Codex in A; terminal B closed after the request was taken; and a relay run that does not answer.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { until } from "../run/helpers";
import { relayProcess, relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const requests = () => join(fixture.relayHome, "jobs", fixture.jobId, "requests");
const LINES = [
  "Stopping Claude Code · personal", "Wrote .relay/checkpoint.md", "Starting Codex · personal", "Continuing on Codex.",
];

async function terminalA() {
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-edits-two-files.json"), codex: Scenarios.fixture("codex-starts.json") });
  const a = relayTerminal(fixture, ["run", "claude:personal"]);
  await until(() => a.output().includes("The callback is done."), 30_000);
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
  return a;
}

test("the lines appear in both terminals, and Codex starts in terminal A", async () => {
  fixture = await e2eFixture();
  const a = await terminalA();
  try {
    const b = relayTerminal(fixture, ["switch", "codex:personal"]);
    expect(await b.child.exited).toBe(0);
    for (const line of LINES) {
      expect(b.output()).toContain(line);
      expect(a.output()).toContain(line);
    }
    await until(() => a.output().includes("Reading .relay/checkpoint.md"));
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});

test("relay run completes the switch when terminal B is closed after the request was taken", async () => {
  fixture = await e2eFixture();
  const a = await terminalA();
  try {
    const b = relayProcess(fixture, ["switch", "codex:personal", "--yes"]);
    await until(() => { try { return readdirSync(requests()).some((name) => name.endsWith(".taken")); } catch { return false; } });
    process.kill(-b.child.pid!, "SIGKILL");
    await b.exited;
    await until(() => a.output().includes("Reading .relay/checkpoint.md"), 60_000);
    expect(a.output()).toContain("Continuing on Codex.");
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});

test("a relay run that does not answer: exit 33, and the request is removed", async () => {
  fixture = await e2eFixture();
  const a = await terminalA();
  try {
    process.kill(a.child.pid, "SIGSTOP");
    const b = relayProcess(fixture, ["switch", "codex:personal"]);
    expect(await b.exited).toBe(33);
    expect(b.stderr()).toBe(`relay: The relay run for this job (process ${a.child.pid}) did not answer within 5 seconds. Nothing changed.\n`);
    expect(readdirSync(requests())).toEqual([]);
  } finally {
    process.kill(a.child.pid, "SIGCONT");
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});
