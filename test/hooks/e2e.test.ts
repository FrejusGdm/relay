// End to end: relay's hooks and status line in a fake Claude profile, a session that reaches its
// limit, then the spool line and the account's availability.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSpool } from "../../src/hooks/spool";
import { runRelayInProcess } from "../helpers/cli";
import { FAKE_CLAUDE, fakeEnv } from "../helpers/fake-programs";
import { relayBin } from "../helpers/relay-bin";

const HOME = process.env.HOME!;

test("a limit in a session with relay's hooks reaches the spool and the account's availability", async () => {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), '[accounts."claude:work"]\n', { mode: 0o600 });
  const env = { ...fakeEnv(), RELAY_BIN: relayBin(), RELAY_HOME: relayHome };
  expect((await runRelayInProcess(["account", "add", "claude", "other", "--no-login", "--yes"], { relayHome, env })).code).toBe(0);
  const login = await runRelayInProcess(["account", "login", "claude:work"], { relayHome, env });
  expect(login.code).toBe(0);
  expect((await runRelayInProcess(["hooks", "install", "claude:work", "--status-line", "--yes"], { relayHome, env })).code).toBe(0);

  const resets = new Date(Date.now() + 3 * 3600_000);
  resets.setUTCSeconds(0, 0);
  const scenario = join(mkdtempSync(join(HOME, "scenario-")), "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    version: 1, session_id: "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f",
    turns: [{ steps: [{ say: "Working." }, { status_line: { five_hour: 100, resets_at: resets.toISOString() } }, { limit: { window: "five_hour", resets_at: resets.toISOString() } }] }],
  }));
  const profile = join(relayHome, "profiles", "claude-work");
  const project = mkdtempSync(join(HOME, "project-"));
  const child = Bun.spawn([process.execPath, FAKE_CLAUDE, "Fix the bug."], {
    cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: profile, RELAY_TARGET: "claude:work", RELAY_JOB: "3f9a2c1d", RELAY_WORKER: "5d2e8f01", RELAY_FAKE_SCENARIO: scenario },
  });
  expect(await child.exited).toBe(0);

  const lines = readSpool(relayHome);
  const failure = lines.find((line) => line.event === "StopFailure");
  expect(failure).toMatchObject({
    provider: "claude", relay_target: "claude:work", relay_job: "3f9a2c1d", relay_worker: "5d2e8f01", profile,
    fields: { session_id: "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f", hook_event_name: "StopFailure", error: "rate_limit" },
  });
  expect(JSON.stringify(lines)).not.toContain("429 Too Many Requests");
  expect(lines.map((line) => line.event)).toEqual(["SessionStart", "StopFailure", "SessionEnd"]);

  const status = await runRelayInProcess(["account", "status", "claude:work", "--json"], { relayHome, env });
  const json = JSON.parse(status.stdout);
  expect(json.availability).toMatchObject({ state: "rate_limited", source: "hook", retry_at: resets.toISOString() });
  expect(json.availability.windows).toContainEqual({ name: "five_hour", window_minutes: 300, used_percent: 100, resets_at: resets.toISOString(), source: "status_line" });
  expect(json.hooks_installed).toBe(true);
  expect(json.status_line_installed).toBe(true);
  const other = JSON.parse((await runRelayInProcess(["account", "status", "claude:other", "--json"], { relayHome, env })).stdout);
  expect(other.availability.source).toBe("none");
});
