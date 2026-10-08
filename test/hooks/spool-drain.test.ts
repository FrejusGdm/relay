// Task 8.2: the daemon empties the hook spool when it starts (design.md decision 18, "Spool
// draining"). A rate limit spooled while the daemon was down shows after it starts; files left by
// an earlier daemon are processed first; spool lines are checked again before they are used.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spoolPath } from "../../src/hooks/spool";
import { runRelay } from "../helpers/cli";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, tempRelayHome, testSocket, waitForDaemon } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

const FIXTURES = join(import.meta.dir, "..", "fixtures", "hooks");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

function relayFolder(): string {
  const relayHome = tempRelayHome();
  writeFileSync(join(relayHome, "config.toml"), '[accounts."claude:work"]\n[accounts."codex:personal"]\n', { mode: 0o600 });
  return relayHome;
}

async function availability(relayHome: string, target: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://relay/v1/accounts/${target}`, { unix: testSocket(relayHome) });
  return ((await response.json()) as { account: { availability: Record<string, unknown> } }).account.availability;
}

// Polls until the account's availability has this status, for at most 5 seconds.
async function waitForStatus(relayHome: string, target: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = await availability(relayHome, target);
    if (current.status === status) return current;
    if (Date.now() > deadline) throw new Error(`${target} is ${String(current.status)}, not ${status}`);
    await Bun.sleep(100);
  }
}

const spoolFiles = (relayHome: string) => readdirSync(join(relayHome, "spool")).sort();

test("a StopFailure rate_limit spooled while the daemon was down shows as rate_limited after it starts", async () => {
  const relayHome = relayFolder();
  const hook = await runRelay(["hook", "claude", "StopFailure"], {
    env: { RELAY_HOME: relayHome, RELAY_TARGET: "claude:work" },
    stdin: fixture("claude-stop-failure-rate-limit.json"),
  });
  expect(hook).toEqual({ code: 0, stdout: "", stderr: "" });
  const spooled = JSON.parse(readFileSync(spoolPath(relayHome), "utf8"));

  const daemon = spawnDaemon(relayHome);
  await waitForDaemon(relayHome);
  expect(await waitForStatus(relayHome, "claude:work", "rate_limited")).toEqual({
    status: "rate_limited",
    reason: "Claude Code reported a rate limit",
    retry_at: null,
    measured_at: spooled.received_at,
    source: "hook",
  });
  const deadline = Date.now() + 3000;
  while (spoolFiles(relayHome).length > 0 && Date.now() < deadline) await Bun.sleep(50);
  expect(spoolFiles(relayHome)).toEqual([]);
  const record = JSON.parse(readFileSync(join(relayHome, "accounts", "claude-work", "availability.json"), "utf8"));
  expect(record).toMatchObject({ state: "rate_limited", source: "hook", detail: "Claude Code reported a rate limit" });
  expect(await stopDaemon(daemon)).toBe(0);
}, 30_000);

test("files left by an earlier daemon are processed and removed, and lines that are not hook events are skipped", async () => {
  const relayHome = relayFolder();
  mkdirSync(join(relayHome, "spool"), { mode: 0o700 });
  const line = (received: Date, event: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1, received_at: received.toISOString(), provider: "claude", event, relay_job: null,
      relay_target: "claude:work", relay_worker: null, profile: "default", fields, ...extra,
    });
  const earlier = new Date(Date.now() - 60_000);
  writeFileSync(
    join(relayHome, "spool", "hooks.4242.draining"),
    [
      "not json",
      line(earlier, "StopFailure", { error: "rate_limit" }, { relay_job: "../../x" }),
      line(earlier, "StopFailure", { error: "authentication_failed", tool_input: { command: "cat secrets.txt" } }),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const daemon = spawnDaemon(relayHome);
  await waitForDaemon(relayHome);
  expect(await waitForStatus(relayHome, "claude:work", "unavailable")).toMatchObject({
    reason: "Claude Code is signed out of this account",
    measured_at: earlier.toISOString(),
  });
  const deadline = Date.now() + 3000;
  while (existsSync(join(relayHome, "spool", "hooks.4242.draining")) && Date.now() < deadline) await Bun.sleep(50);
  expect(spoolFiles(relayHome)).toEqual([]);
  expect(await stopDaemon(daemon)).toBe(0);
  const log = readFileSync(join(relayHome, "logs", "daemon.log"), "utf8");
  expect(log).toContain('"msg":"spool_drained"');
  expect(log).toContain('"skipped":2');
  expect(log).not.toContain("secrets.txt");
}, 30_000);

test("a line spooled while the daemon runs is drained without waiting for the next start", async () => {
  const relayHome = relayFolder();
  const daemon = spawnDaemon(relayHome);
  await waitForDaemon(relayHome);
  await Bun.sleep(1500);
  // A hook that wrote to the spool because the daemon was slow to answer.
  for (const [error, status] of [["billing_error", "unavailable"], ["rate_limit", "rate_limited"]] as const) {
    mkdirSync(join(relayHome, "spool"), { recursive: true, mode: 0o700 });
    writeFileSync(spoolPath(relayHome), `${JSON.stringify({
      v: 1, received_at: new Date().toISOString(), provider: "claude", event: "StopFailure", relay_job: null,
      relay_target: "claude:work", relay_worker: null, profile: "default", fields: { error },
    })}\n`, { flag: "a", mode: 0o600 });
    if (error === "rate_limit") {
      // The next hook that reaches the daemon also starts a drain.
      const hook = await runRelay(["hook", "codex", "Stop"], { env: { RELAY_HOME: relayHome, RELAY_TARGET: "codex:personal" }, stdin: fixture("codex-stop.json") });
      expect(hook.code).toBe(0);
    }
    await waitForStatus(relayHome, "claude:work", status);
  }
  expect(await availability(relayHome, "codex:personal")).toMatchObject({ status: "available" });
  expect(await stopDaemon(daemon)).toBe(0);
}, 30_000);
