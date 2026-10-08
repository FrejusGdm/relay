// Task 11.1: the whole path on a scratch repository with the fake agents. relay init (the
// fixture), relay run on claude:work in a terminal, which starts the daemon; the fake Claude Code
// agent reaches a rate limit and its StopFailure hook runs relay hook; relay switch codex:personal
// in a second terminal; then relay status, the event stream, relay daemon stop, relay status from
// the saved files, and the person's branch, index, stash and files.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runRelay } from "../helpers/cli";
import { relayBin } from "../helpers/relay-bin";
import { stopStartedDaemon, testSocket, waitForDaemon } from "../helpers/relay-home";
import { relayIn, relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { jobEvents, until } from "../run/helpers";
import { e2eFixture, expectPersonUnchanged, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

const ACCOUNTS = '[accounts."claude:work"]\n\n[accounts."codex:personal"]\n';
let fixture: E2eFixture | undefined;
let bin: string | undefined;
afterEach(async () => {
  if (fixture !== undefined) await stopStartedDaemon(fixture.relayHome);
  await fixture?.cleanup();
  if (bin !== undefined) rmSync(dirname(bin), { recursive: true, force: true });
  fixture = undefined;
});

interface Frame {
  event: string;
  data: Record<string, any>;
}

// The frames of an event stream, as they arrive.
function frames(response: Response): Frame[] {
  const seen: Frame[] = [];
  const reader = response.body!.getReader();
  let text = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += new TextDecoder().decode(value);
      let end: number;
      while ((end = text.indexOf("\n\n")) !== -1) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event !== undefined && data !== undefined) seen.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  return seen;
}

test("run, rate limit, switch, status with and without the daemon", async () => {
  const f = (fixture = await e2eFixture({ accounts: ACCOUNTS, allow: ["claude:work", "codex:personal"] }));
  bin = relayBin();
  const env = { RELAY_BIN: bin, RELAY_TEST_START_DAEMON: "1" };
  expect((await relayIn(f, ["hooks", "install", "claude:work", "--yes"], { env })).code).toBe(0);
  f.scenarios.set({
    claude: {
      turns: [
        { steps: [{ write: "src/auth/callback.ts", content: "export const callback = 1;\n" }, { say: "The callback is done." }] },
        { steps: [{ limit: { window: "five_hour", resets_at: "2099-01-01T00:00:00Z", kind: "rate" } }] },
      ],
    },
  });

  const a = relayTerminal(f, ["run", "claude:work"], env);
  try {
    await until(() => a.output().includes("The callback is done."), 30_000);
    // relay run started the daemon before it started the agent.
    await waitForDaemon(f.relayHome);
    const stream = frames(await fetch(`http://relay/v1/events?job=${f.jobId}`, { unix: testSocket(f.relayHome) }));

    // The second turn reaches the rate limit; the StopFailure hook reaches the daemon.
    a.type("Keep going.\n");
    await until(() => jobEvents(f).some((event) => event.type === "availability" && event.data.source === "hook" && event.data.status === "rate_limited"), 15_000);

    f.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
    const b = relayTerminal(f, ["switch", "codex:personal"], env);
    expect({ code: await b.child.exited, output: b.output() }).toMatchObject({ code: 0 });
    await until(() => a.output().includes("Reading .relay/checkpoint.md"), 30_000);

    const status = async () => {
      const result = await runRelay(["status"], { cwd: f.scratch.repo, env: { RELAY_HOME: f.relayHome, TZ: "UTC" } });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout.split("\n");
    };
    const live = await status();
    const commit = f.scratch.git("rev-parse", `refs/relay/jobs/${f.jobId}/latest`).trim().slice(0, 6);
    expect(live[0]).toMatch(new RegExp(`   job ${f.jobId} · checkpoint ${commit} · (just now|\\d+ min ago)$`));
    expect(live.slice(1, 4)).toEqual([
      "",
      "claude:work      ────────────┐      limit reached · reset unknown",
      "                             │",
    ]);
    expect(live[4]).toStartWith("codex:personal   ━━━━━━━━━━━━┷━━━   running");
    expect(live.slice(5)).toEqual(["", "Continuing on Codex.", ""]);

    // The stream saw the limit, then the handoff's checkpoint, then the new worker.
    await until(() => stream.some((frame) => frame.event === "worker" && frame.data.target === "codex:personal"));
    const limit = stream.findIndex((frame) => frame.event === "availability" && frame.data.target === "claude:work" && frame.data.availability.status === "rate_limited");
    const checkpoint = stream.findIndex((frame, index) => index > limit && frame.event === "checkpoint");
    const worker = stream.findIndex((frame, index) => index > checkpoint && frame.event === "worker" && frame.data.target === "codex:personal");
    expect([limit, checkpoint, worker].every((index) => index >= 0)).toBe(true);
    expect(limit < checkpoint && checkpoint < worker).toBe(true);

    // The agents belong to relay run in the terminal, so relay daemon stop refuses nothing.
    expect(await runRelay(["daemon", "stop"], { env: { RELAY_HOME: f.relayHome } })).toEqual({ code: 0, stdout: "relay daemon stopped\n", stderr: "" });
    await until(() => stream.at(-1)?.event === "shutdown");

    const saved = await status();
    expect(saved.slice(1)).toEqual([...live.slice(1, -1), "", "Showing saved state. The relay daemon is not running.", ""]);
    expect(existsSync(join(f.relayHome, "run", "daemon.pid"))).toBe(false);
    expectPersonUnchanged(f, ["src/auth/callback.ts"]);
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});
