import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { availabilityPath, recordReading } from "../../../src/accounts/availability";
import { now } from "../../../src/platform/clock";
import { claudeTest } from "./helpers/worker";

test("availability reads a recorded reading without calling a provider or the network", async () => {
  const fixture = claudeTest();
  const fetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Availability made a network request."); }) as unknown as typeof fetch;
  try {
    expect(await fixture.adapter.availability(fixture.account, fixture.env)).toMatchObject({ state: "unknown", source: "none", windows: [] });
    const observedAt = now();
    const retryAt = new Date(observedAt.getTime() + 86_400_000);
    recordReading(fixture.relayHome, fixture.account, { state: "quota_exhausted", retryAt, observedAt, source: "user", windows: [] });
    expect(await fixture.adapter.availability(fixture.account, fixture.env)).toEqual({ account: fixture.account.id,
      state: "quota_exhausted", retryAt, observedAt, source: "user", windows: [] });
    expect(fixture.hasRecord()).toBe(false);
  } finally { globalThis.fetch = fetch; await fixture.cleanup(); }
});

test("a usage limit records the exhausted quota and reset time", async () => {
  const reset = new Date(now().getTime() + 86_400_000);
  reset.setMilliseconds(0);
  const fixture = claudeTest([{ limit: { window: "primary", resets_at: reset.toISOString() } }]);
  try {
    await fixture.start();
    await fixture.finished();
    expect(await fixture.adapter.availability(fixture.account, fixture.env)).toMatchObject({
      state: "quota_exhausted", retryAt: reset, source: "stream_event",
      windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 100, resetsAt: reset, source: "stream_event" }],
    });
    expect(JSON.parse(readFileSync(availabilityPath(fixture.relayHome, fixture.account), "utf8"))).toMatchObject({ state: "quota_exhausted", retry_at: reset.toISOString() });
  } finally { await fixture.cleanup(); }
});

test("a successful turn records availability", async () => {
  const fixture = claudeTest();
  try {
    await fixture.start();
    await fixture.finished();
    expect(await fixture.adapter.availability(fixture.account, fixture.env)).toMatchObject({
      state: "available", source: "stream_event", detail: "The last turn finished normally",
    });
  } finally { await fixture.cleanup(); }
});
