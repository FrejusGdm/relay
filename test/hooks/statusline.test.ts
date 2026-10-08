import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAvailability } from "../../src/accounts/availability";
import { setClock } from "../../src/platform/clock";
import { runRelayInProcess } from "../helpers/cli";

const HOME = process.env.HOME!;
afterEach(() => setClock(null));
const WORK = { id: "claude:work" as const, provider: "claude" as const, name: "work" };

function setup(original?: unknown, config = '[accounts."claude:work"]\n\n[accounts."claude:home"]\n') {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), config, { mode: 0o600 });
  const profile = join(relayHome, "profiles", "claude-work");
  if (original !== undefined) {
    mkdirSync(join(relayHome, "accounts", "claude-work"), { recursive: true, mode: 0o700 });
    writeFileSync(join(relayHome, "accounts", "claude-work", "statusline-original.json"), JSON.stringify({ v: 1, original, profile }));
  }
  return { relayHome, profile };
}
const INPUT = JSON.stringify({
  session_id: "s1", model: { id: "m" },
  rate_limits: { five_hour: { used_percentage: 20, resets_at: 1791387900 }, seven_day: { used_percentage: 100, resets_at: 1791820800 } },
});

test("the reading is recorded for the account of CLAUDE_CONFIG_DIR", async () => {
  const { relayHome, profile } = setup();
  setClock(() => new Date("2026-10-07T12:00:00Z"));
  const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT, env: { CLAUDE_CONFIG_DIR: profile } });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  const reading = readAvailability(relayHome, WORK);
  expect(reading.state).toBe("quota_exhausted");
  expect(reading.retryAt?.getTime()).toBe(1791820800 * 1000);
  expect(reading.source).toBe("status_line");
  expect(reading.windows.map((window) => [window.name, window.usedPercent])).toEqual([["five_hour", 20], ["seven_day", 100]]);
  expect(readAvailability(relayHome, { ...WORK, id: "claude:home", name: "home" }).source).toBe("none");
});

test("RELAY_TARGET wins, and a reading below 100 percent is available", async () => {
  const { relayHome } = setup();
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 62, resets_at: 1791387900 } } });
  await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: input, env: { RELAY_TARGET: "claude:work", CLAUDE_CONFIG_DIR: "/elsewhere" } });
  expect(readAvailability(relayHome, WORK).state).toBe("available");
});

test("the original status line gets the same input; its output and exit code pass through", async () => {
  const folder = mkdtempSync(join(HOME, "status-"));
  const script = join(folder, "my-status.sh");
  writeFileSync(script, `#!/bin/sh\ncat > '${join(folder, "input")}'\nprintf 'Opus | 20%%'\nexit 3\n`, { mode: 0o755 });
  const { relayHome, profile } = setup({ type: "command", command: script });
  const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT, env: { CLAUDE_CONFIG_DIR: profile } });
  expect(result).toEqual({ code: 3, stdout: "Opus | 20%", stderr: "" });
  expect(readFileSync(join(folder, "input"), "utf8")).toBe(INPUT);
});

test("without an original and without rate limits, nothing is printed", async () => {
  const { relayHome, profile } = setup();
  const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: '{"session_id":"s"}', env: { CLAUDE_CONFIG_DIR: profile } });
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(readAvailability(relayHome, WORK).source).toBe("none");
});

test("the original starts less than 50 ms after relay starts, on the median of 20 runs", async () => {
  const folder = mkdtempSync(join(HOME, "status-"));
  const mark = join(folder, "started");
  const { relayHome, profile } = setup({ type: "command", command: `date +%s%N > '${mark}'` });
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = Date.now() * 1_000_000;
    await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT, env: { CLAUDE_CONFIG_DIR: profile } });
    times.push((Number(readFileSync(mark, "utf8").trim()) - started) / 1_000_000);
  }
  times.sort((a, b) => a - b);
  expect(times[10]!).toBeLessThan(50);
});

test("at the 2-second limit relay kills everything the original started and shows what it printed", async () => {
  const folder = mkdtempSync(join(HOME, "status-"));
  const pidFile = join(folder, "pid");
  // The background sleep keeps standard output open after sh is killed.
  const { relayHome, profile } = setup({ type: "command", command: `sleep 30 & echo $! > '${pidFile}'; printf 'partial'; wait` });
  const started = performance.now();
  const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT, env: { CLAUDE_CONFIG_DIR: profile } });
  expect(performance.now() - started).toBeLessThan(4000);
  expect(result).toEqual({ code: 0, stdout: "partial", stderr: "" });
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise<void>((done) => setTimeout(done, 200));
  expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);

test("relay shows at most 1 MiB of the original's output", async () => {
  const { relayHome, profile } = setup({ type: "command", command: "head -c 3000000 /dev/zero | tr '\\0' a" });
  const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT, env: { CLAUDE_CONFIG_DIR: profile } });
  expect(result.stdout).toBe("a".repeat(1024 * 1024));
});

for (const [label, config] of [["config.toml is invalid", "[accounts.\"claude:work\"\nbroken = \n"], ["the account was removed", ""]]) {
  for (const env of ["CLAUDE_CONFIG_DIR", "RELAY_TARGET"]) {
    test(`the person's status line still shows when ${label} (found by ${env})`, async () => {
      const { relayHome, profile } = setup({ type: "command", command: "printf 'Opus | 20%%'" }, config);
      const result = await runRelayInProcess(["statusline", "claude"], { relayHome, stdin: INPUT,
        env: env === "RELAY_TARGET" ? { RELAY_TARGET: "claude:work", CLAUDE_CONFIG_DIR: "/elsewhere" } : { CLAUDE_CONFIG_DIR: profile } });
      expect(result).toEqual({ code: 0, stdout: "Opus | 20%", stderr: "" });
      expect(readAvailability(relayHome, WORK).source).toBe("none");
    });
  }
}
