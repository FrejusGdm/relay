import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readSpool, spoolPath } from "../../src/hooks/spool";
import { makeRelayHome } from "../helpers/home";
import { MAIN, runRelay, runRelayInProcess } from "../helpers/cli";

const STOP_FAILURE = {
  session_id: "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f", transcript_path: "/tmp/t.jsonl", cwd: "/srv/app",
  hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 Too Many Requests",
  last_assistant_message: "Here is the plan.", tool_input: { command: "cat secrets" },
};

test("StopFailure: one spool line with the allowed fields and the relay variables", async () => {
  const relayHome = makeRelayHome();
  const result = await runRelayInProcess(["hook", "claude", "StopFailure"], {
    relayHome, stdin: JSON.stringify(STOP_FAILURE),
    env: { RELAY_TARGET: "claude:work", RELAY_JOB: "3f9a2c1d", RELAY_WORKER: "5d2e8f01", CLAUDE_CONFIG_DIR: "/p/claude-work" },
  });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  const lines = readSpool(relayHome);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    v: 1, provider: "claude", event: "StopFailure", relay_job: "3f9a2c1d", relay_target: "claude:work",
    relay_worker: "5d2e8f01", profile: "/p/claude-work",
    fields: { session_id: STOP_FAILURE.session_id, cwd: "/srv/app", hook_event_name: "StopFailure", error: "rate_limit" },
  });
  const text = readFileSync(spoolPath(relayHome), "utf8");
  for (const dropped of ["error_details", "last_assistant_message", "tool_input", "transcript_path", "429 Too Many", "cat secrets"]) {
    expect(text).not.toContain(dropped);
  }
});

test("a session relay did not start: no relay variables and the default profile", async () => {
  const relayHome = makeRelayHome();
  await runRelayInProcess(["hook", "codex", "Stop"], {
    relayHome, stdin: JSON.stringify({ session_id: "s", hook_event_name: "Stop", turn_id: "turn_1" }),
    env: { RELAY_TARGET: "not an account", RELAY_JOB: "../x", RELAY_WORKER: "" },
  });
  expect(readSpool(relayHome)[0]).toMatchObject({ relay_job: null, relay_target: null, relay_worker: null, profile: "default", fields: { turn_id: "turn_1" } });
});

test("an unknown provider, a bad event name and input that is not JSON record nothing and stay silent", async () => {
  const relayHome = makeRelayHome();
  for (const [args, stdin] of [[["hook", "cursor", "Stop"], "{}"], [["hook", "claude", "Stop;rm"], "{}"], [["hook", "claude", "Stop"], "not json"], [["hook", "claude", "Stop"], "[1]"]] as const) {
    expect(await runRelayInProcess([...args], { relayHome, stdin })).toEqual({ code: 0, stdout: "", stderr: "" });
  }
  expect(readSpool(relayHome)).toEqual([]);
  const log = readFileSync(join(relayHome, "logs", "hook.log"), "utf8");
  expect(log).toContain('"outcome":"the provider is not supported"');
  expect(log).toContain('"outcome":"the input is not a JSON object"');
  expect(log).not.toContain("not json");
});

test("nothing is appended once the spool is larger than 10 MB", async () => {
  const relayHome = makeRelayHome();
  mkdirSync(join(relayHome, "spool"), { mode: 0o700 });
  writeFileSync(spoolPath(relayHome), "x".repeat(10 * 1024 * 1024 + 1), { mode: 0o600 });
  await runRelayInProcess(["hook", "claude", "Stop"], { relayHome, stdin: "{}" });
  expect(readFileSync(spoolPath(relayHome), "utf8").endsWith("x")).toBe(true);
});

test("a hook whose input never closes exits 0 within 500 ms of starting to read", async () => {
  const relayHome = makeRelayHome();
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "hook", "claude", "Stop"], {
    env: { ...process.env, RELAY_HOME: relayHome }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write('{"session_id":"s"');
  child.stdin.flush();
  const started = performance.now();
  const code = await child.exited;
  expect(performance.now() - started).toBeLessThan(500);
  expect(code).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe("");
  child.stdin.end();
});

test("relay hook as its own process records the line", async () => {
  const relayHome = makeRelayHome();
  const result = await runRelay(["hook", "claude", "SessionStart"], {
    env: { RELAY_HOME: relayHome }, stdin: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }),
  });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(readSpool(relayHome)[0]?.fields).toEqual({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" });
});
