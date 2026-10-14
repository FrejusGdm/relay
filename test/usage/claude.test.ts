// Claude Code's /usage reading (add-resume-at-reset, with the usage-readings spec of
// add-t3-limit-rules): the recorded output, a full window, other text, and the command relay runs.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAvailability } from "../../src/accounts/availability";
import type { Account } from "../../src/core/config/types";
import { parseClaudeUsage, readClaudeUsage } from "../../src/usage/claude";
import { fakeEnv } from "../helpers/fake-programs";
import { tempRelayHome } from "../helpers/relay-home";

const RECORDED = readFileSync(join(import.meta.dir, "..", "fixtures", "usage", "claude-usage.txt"), "utf8");

test("the recorded output gives the session and weekly windows, and the account is available", () => {
  const reading = parseClaudeUsage(RECORDED, new Date("2026-10-08T09:00:00Z"))!;
  expect(reading.state).toBe("available");
  expect(reading.source).toBe("usage_command");
  expect(reading.windows.map((window) => [window.name, window.windowMinutes, window.usedPercent])).toEqual([["five_hour", 300, 34], ["seven_day", 10080, 91]]);
  expect(reading.windows[0]!.resetsAt).toEqual(new Date("2026-10-08T13:49:00Z"));
  expect(reading.windows[1]!.resetsAt).toEqual(new Date("2026-10-12T07:59:00Z"));
});

test("a full window makes the account limited until its reset", () => {
  const reading = parseClaudeUsage("Current session: 100% used · resets 1:49pm (UTC)\nCurrent week (all models): 50% used · resets Oct 12, 7:59am (UTC)\n", new Date("2026-10-08T09:00:00Z"))!;
  expect(reading).toMatchObject({ state: "quota_exhausted", retryAt: new Date("2026-10-08T13:49:00Z") });
});

test("text without a usage line gives no reading", () => {
  expect(parseClaudeUsage("Something else happened.")).toBeNull();
});

test("relay runs claude -p /usage with the account's profile and records the reading", async () => {
  const relayHome = tempRelayHome();
  const account: Account = { id: "claude:work", provider: "claude", name: "work", profileDir: join(relayHome, "profile"), profileDirIsDefault: false, credentialEnv: [], kind: null };
  const env = { ...process.env, ...fakeEnv({ usage_text: "Current session: 100% used · resets 11:59pm (UTC)\n" }), RELAY_HOME: relayHome };
  const reading = await readClaudeUsage(account, env, relayHome);
  expect(reading).toMatchObject({ account: "claude:work", state: "quota_exhausted", source: "usage_command" });
  expect(readAvailability(relayHome, account)).toMatchObject({ state: "quota_exhausted", source: "usage_command" });
});
