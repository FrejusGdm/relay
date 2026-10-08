import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAvailability, recordReading, RESET_PASSED } from "../../src/accounts/availability";
import { setClock } from "../../src/platform/clock";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";

const HOME = process.env.HOME!;
const WORK = { id: "claude:work" as const, provider: "claude" as const, name: "work" };
afterEach(() => setClock(null));

function relayWithWork(): string {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), '[accounts."claude:work"]\n');
  chmodSync(join(relayHome, "config.toml"), 0o600);
  return relayHome;
}

test("without a reading the account is unknown with source none", () => {
  const reading = readAvailability(mkdtempSync(join(HOME, "relay-")), WORK);
  expect(reading.state).toBe("unknown");
  expect(reading.source).toBe("none");
});

test("a limit reading is reported until its reset time passes, then unknown", () => {
  const relayHome = relayWithWork();
  const resets = new Date("2026-10-08T14:00:00");
  recordReading(relayHome, WORK, {
    state: "quota_exhausted", retryAt: resets, observedAt: new Date("2026-10-08T12:48:00"), source: "status_line",
    windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 100, resetsAt: resets, source: "status_line" }],
  });
  setClock(() => new Date("2026-10-08T13:00:00"));
  expect(readAvailability(relayHome, WORK).state).toBe("quota_exhausted");
  setClock(() => new Date("2026-10-08T14:01:00"));
  expect(readAvailability(relayHome, WORK)).toMatchObject({ state: "unknown", detail: RESET_PASSED, source: "status_line" });
});

test("readings merge: a newer state replaces, windows merge by name, an older reading keeps the state", () => {
  const relayHome = relayWithWork();
  const at = (time: string) => new Date(`2026-10-08T${time}:00Z`);
  recordReading(relayHome, WORK, {
    state: "available", observedAt: at("10:00"), source: "status_line",
    windows: [{ name: "five_hour", usedPercent: 40, source: "status_line" }, { name: "seven_day", usedPercent: 10, source: "status_line" }],
  });
  recordReading(relayHome, WORK, {
    state: "rate_limited", observedAt: at("11:00"), source: "hook", windows: [{ name: "five_hour", usedPercent: 90, source: "hook" }],
  });
  recordReading(relayHome, WORK, { state: "available", observedAt: at("09:00"), source: "user", windows: [] });
  setClock(() => at("11:30"));
  const reading = readAvailability(relayHome, WORK);
  expect(reading.state).toBe("rate_limited");
  expect(reading.source).toBe("hook");
  expect(reading.windows.map((window) => [window.name, window.usedPercent])).toEqual([["five_hour", 90], ["seven_day", 10]]);
});

test("relay account status shows sign-in, profile and the recorded availability with its source and age", async () => {
  const relayHome = relayWithWork();
  const resets = new Date("2026-10-08T14:00:00");
  recordReading(relayHome, WORK, {
    state: "quota_exhausted", retryAt: resets, observedAt: new Date("2026-10-08T12:48:00"), source: "status_line", windows: [],
  });
  setClock(() => new Date("2026-10-08T13:00:00"));
  const { code, stdout } = await runRelayInProcess(["account", "status", "claude:work"], { relayHome, env: fakeEnv() });
  expect(code).toBe(0);
  expect(stdout).toContain("claude:work\n");
  expect(stdout).toContain("  Signed in     yes (claude.ai)\n");
  expect(stdout).toContain("  Availability  limit, resets 14:00 (status line, 12 min ago)\n");
  expect(stdout).toContain("  Hooks         not installed\n");
  setClock(() => new Date("2026-10-08T14:05:00"));
  const later = await runRelayInProcess(["account", "status", "claude:work", "--json"], { relayHome, env: fakeEnv() });
  const json = JSON.parse(later.stdout);
  expect(json.availability).toMatchObject({ state: "unknown", source: "status_line", detail: RESET_PASSED });
  expect(json.signed_in).toBe(true);
});

test("relay account status for an unknown account exits 21", async () => {
  const result = await runRelayInProcess(["account", "status", "claude:nope"], { relayHome: relayWithWork(), env: fakeEnv() });
  expect(result).toEqual({ code: 21, stdout: "", stderr: "claude:nope is not one of your accounts. See relay account list.\n" });
});

test("relay account status reads a Codex account's rate limits live and records them", async () => {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), '[accounts."codex:personal"]\n', { mode: 0o600 });
  mkdirSync(join(relayHome, "profiles", "codex-personal"), { recursive: true, mode: 0o700 });
  const resets = new Date(Date.now() + 3600_000).toISOString();
  const env = fakeEnv({ rate_limits: { primary: { used_percent: 62, window_minutes: 300, resets_at: resets }, ordinary_usage_allowed: true } });
  const { code, stdout } = await runRelayInProcess(["account", "status", "codex:personal", "--json"], { relayHome, env });
  expect(code).toBe(0);
  const json = JSON.parse(stdout);
  expect(json.availability).toMatchObject({ state: "available", source: "provider_api" });
  expect(json.availability.windows[0]).toMatchObject({ name: "five_hour", window_minutes: 300, used_percent: 62 });
  const text = await runRelayInProcess(["account", "status", "codex:personal"], { relayHome, env });
  expect(text.stdout).toContain("  Availability  available (provider, just now)\n");
});
