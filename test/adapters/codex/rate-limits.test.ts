import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { availabilityPath, readAvailability } from "../../../src/accounts/availability";
import { createCodexAdapter } from "../../../src/adapters/codex/adapter";
import { readCodexSession } from "../../../src/adapters/codex/session";
import type { AvailabilityState } from "../../../src/adapters/types";
import type { Scenario } from "../../fakes/scenario";
import { codexTest } from "./helpers/worker";

const RESET = new Date(Date.now() + 86_400_000).toISOString();
const WEEKLY_RESET = new Date(Date.now() + 7 * 86_400_000).toISOString();
const primary = { used_percent: 62, window_minutes: 300, resets_at: RESET };
const secondary = { used_percent: 100, window_minutes: 10080, resets_at: WEEKLY_RESET };

for (const [label, rateLimits, state, retryAt] of [
  ["allowed", { primary, ordinary_usage_allowed: true }, "available", undefined],
  ["null", { primary, ordinary_usage_allowed: null }, "unknown", undefined],
  ["reached", { primary: { ...primary, used_percent: 100 }, reached: "usage_limit", ordinary_usage_allowed: true }, "quota_exhausted", RESET],
  ["credits depleted", { primary, reached: "workspace_member_credits_depleted", ordinary_usage_allowed: true }, "quota_exhausted", undefined],
  ["weekly full", { primary, secondary, ordinary_usage_allowed: false }, "quota_exhausted", WEEKLY_RESET],
  ["false", { primary, ordinary_usage_allowed: false }, "quota_exhausted", undefined],
] as [string, Scenario["rate_limits"], AvailabilityState, string | undefined][]) {
  test(`availability reads ${label} and records the reading`, async () => {
    const fixture = codexTest([], { rate_limits: rateLimits });
    try {
      const reading = await fixture.adapter.availability(fixture.account, fixture.env);
      expect(reading.state).toBe(state);
      expect(reading.source).toBe("provider_api");
      expect(reading.windows[0]).toMatchObject({ name: "five_hour", windowMinutes: 300, usedPercent: rateLimits?.primary?.used_percent });
      expect(reading.retryAt?.toISOString()).toBe(retryAt === undefined ? undefined : new Date(Math.floor(Date.parse(retryAt) / 1000) * 1000).toISOString());
      if (label === "null") expect(reading.detail).toBe("Codex did not say whether usage is allowed.");
      expect(readAvailability(fixture.relayHome, fixture.account)).toEqual(reading);
      expect(JSON.parse(readFileSync(availabilityPath(fixture.relayHome, fixture.account), "utf8"))).toMatchObject({ state, source: "provider_api" });
      expect(fixture.messages().map((message) => message.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    } finally { await fixture.cleanup(); }
  });
}

test("not signed in is unavailable with the login instruction", async () => {
  const fixture = codexTest([], { auth: { signed_in: false } });
  try {
    const reading = await fixture.adapter.availability(fixture.account, fixture.env);
    expect(reading).toMatchObject({ state: "unavailable", windows: [], source: "provider_api",
      detail: "Codex is not signed in on this account. Run relay account login codex:test." });
    expect(readAvailability(fixture.relayHome, fixture.account)).toEqual(reading);
  } finally { await fixture.cleanup(); }
});

test("a missing program gives unknown availability and keeps the earlier reading", async () => {
  const fixture = codexTest();
  try {
    const adapter = createCodexAdapter({ PATH: "" });
    const reading = await adapter.availability(fixture.account, fixture.env);
    expect(reading).toMatchObject({ state: "unknown", windows: [], source: "none", detail: "relay could not read Codex's rate limits." });
    expect(readAvailability(fixture.relayHome, fixture.account).source).toBe("none");
  } finally { await fixture.cleanup(); }
});

test("a short session with no answer stops within its total deadline", async () => {
  const fixture = codexTest([], { app_server: "no_answer" });
  try {
    const started = performance.now();
    expect(await readCodexSession(fixture.account, fixture.env, fixture.root, "account/rateLimits/read", undefined, fixture.env, 200)).toEqual({ status: "unknown" });
    expect(performance.now() - started).toBeLessThan(1500);
  } finally { await fixture.cleanup(); }
});

test("a usage-limit turn reads reset windows once before it closes input", async () => {
  const fixture = codexTest([{ limit: { window: "primary", resets_at: RESET } }], { rate_limits: { primary, secondary, ordinary_usage_allowed: true } });
  try {
    await fixture.start();
    await fixture.finished();
    const failure = fixture.events.find((event) => event.kind === "turn_failed");
    expect(failure).toMatchObject({ kind: "turn_failed", reason: "usage_limit", source: "provider_api" });
    expect(failure?.kind === "turn_failed" ? failure.retryAt?.getTime() : undefined).toBe(Math.floor(Date.parse(WEEKLY_RESET) / 1000) * 1000);
    expect(fixture.messages().filter((message) => message.method === "account/rateLimits/read")).toHaveLength(1);
    expect(fixture.events.at(-1)?.kind).toBe("exited");
    expect(readAvailability(fixture.relayHome, fixture.account).retryAt?.getTime()).toBe(Math.floor(Date.parse(WEEKLY_RESET) / 1000) * 1000);
  } finally { await fixture.cleanup(); }
});
