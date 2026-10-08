// Task 9.1: relay switch (and relay run, through the same ensureDaemon) starts the daemon before it
// starts an agent: a detached daemon in its own session that outlives the command, the version
// notice once for a daemon of another version, and a switch that still completes when the daemon
// cannot start. With the fake agents only.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../src/core/version";
import { runRelay } from "../helpers/cli";
import { stopStartedDaemon, testSocket } from "../helpers/relay-home";
import { relayIn, relayProcess, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";
import { jobEvents } from "../run/helpers";

setDefaultTimeout(120_000);

let fixture: SwitchFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) await stopStartedDaemon(fixture.relayHome);
  await fixture?.cleanup();
  fixture = undefined;
});

// A job whose headless Claude Code worker finished, and a Codex scenario that finishes its turn, so
// relay switch ends once Codex has worked.
async function jobReadyToSwitch(): Promise<SwitchFixture> {
  const f = (fixture = await switchFixture());
  f.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/auth.ts", content: "export const auth = 1;\n" }, { say: "Done." }] }] } });
  expect((await relayIn(f, ["run", "claude:work", "--headless", "--prompt", "Add auth."])).code).toBe(0);
  f.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: { turns: [{ steps: [{ say: "Continuing." }] }] } });
  return f;
}

async function relaySwitch(f: SwitchFixture) {
  const run = relayProcess(f, ["switch", "codex:personal"], { RELAY_TEST_START_DAEMON: "1" });
  return { code: await run.exited, stdout: run.stdout(), stderr: run.stderr(), pid: run.child.pid! };
}

const ps = (field: string, pid: number) =>
  Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();

test("with no daemon, relay switch leaves a running daemon that is not its child or the test's", async () => {
  const f = await jobReadyToSwitch();
  const result = await relaySwitch(f);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const { pid } = JSON.parse(readFileSync(join(f.relayHome, "run", "daemon.pid"), "utf8")) as { pid: number };
  const parent = Number(ps("ppid", pid));
  expect(parent).not.toBe(process.pid);
  expect(parent).not.toBe(result.pid);
  // It leads its own session, so closing the terminal does not end it.
  expect(ps("sid", pid)).toBe(String(pid));
  const status = await runRelay(["daemon", "status"], { env: { RELAY_HOME: f.relayHome } });
  expect(status.code).toBe(0);
  expect(status.stdout).toStartWith(`Running   pid ${pid} · version ${VERSION}`);
});

test("a daemon of another version gets the restart notice once, and the switch goes on", async () => {
  const f = await jobReadyToSwitch();
  mkdirSync(join(f.relayHome, "run"), { mode: 0o700 });
  const server = Bun.serve({
    unix: testSocket(f.relayHome),
    fetch: (request) => new URL(request.url).pathname === "/v1/version"
      ? Response.json({ api: "v1", daemon_version: "0.0.1", pid: process.pid, started_at: new Date().toISOString(), agents_running: [] })
      : Response.json({ accepted: true }, { status: 202 }),
  });
  try {
    const result = await relaySwitch(f);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`The relay daemon is running version 0.0.1; this command is version ${VERSION}. Restart it with: relay daemon restart\n`);
  } finally {
    server.stop(true);
  }
});

test("when the daemon cannot start, relay switch says so and still completes the switch", async () => {
  const f = await jobReadyToSwitch();
  const dir = join(f.relayHome, "run");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o755);
  const result = await relaySwitch(f);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe(
    `relay will not use ${dir}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}\n` +
      `relay could not start its background service. Details are in ${join(f.relayHome, "logs", "daemon.log")}.\n`,
  );
  expect(result.stdout).toContain("Continuing on Codex.");
  expect(jobEvents(f).some((event) => event.type === "handoff")).toBe(true);
});
