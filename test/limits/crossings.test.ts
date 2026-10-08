import { describe, expect, test } from "bun:test";
import type { AccountId } from "../../src/core/config/types";
import {
  STALE_AFTER_MS, applyReading, expireCrossings, type Crossing, type CrossingState, type UsageReading,
} from "../../src/limits/crossings";
import type { LimitRule } from "../../src/limits/rules";

const now = 1_000_000;
const rule: LimitRule = {
  account: "claude:personal", window: "seven_day", threshold: 90, action: "notify",
  switchTo: null, switchToIgnored: false,
};
const reading = (
  usedPercent: number, resetsAt: number | null = now + 10_000,
  measuredAt = now, account: AccountId = rule.account,
): UsageReading => ({ account, measuredAt, windows: [{ name: "seven_day", usedPercent, resetsAt }] });

describe("Crossing a threshold", () => {
  test("90, 92 and 93 percent start only one crossing", () => {
    let state: CrossingState = new Map();
    const started: Crossing[] = [];
    for (const usedPercent of [90, 92, 93]) {
      const change = applyReading(state, reading(usedPercent), [rule], now);
      started.push(...change.started);
      expect(change.ended).toEqual([]);
      state = change.state;
    }
    expect(started).toEqual([{
      account: "claude:personal", window: "seven_day", usedPercent: 90, threshold: 90,
      action: "notify", switchTo: null, resetsAt: now + 10_000, startedAt: now,
    }]);
    expect(state.size).toBe(1);
    expect(state.get("claude:personal seven_day")).toEqual(started[0]);
  });

  test("a reset passing before a 4 percent reading ends the old week, then 95 starts again", () => {
    const first = applyReading(new Map(), reading(90), [rule], now);
    const reset = now + 10_000;
    const low = applyReading(first.state, reading(4, reset + 10_000, reset), [rule], reset);
    expect(low.started).toEqual([]);
    expect(low.ended).toEqual([{ crossing: first.started[0]!, reason: "reset_passed" }]);
    expect(low.state.size).toBe(0);
    const next = applyReading(low.state, reading(95, reset + 10_000, reset + 1), [rule], reset + 1);
    expect(next.started).toHaveLength(1);
    expect(next.started[0]!.startedAt).toBe(reset + 1);
    expect(next.started[0]!.resetsAt).toBe(reset + 10_000);
  });

  test("without a reset time the crossing remains until a below-threshold reading", () => {
    const first = applyReading(new Map(), reading(95, null), [rule], now);
    const later = now + 100_000;
    const expired = expireCrossings(first.state, later);
    expect(expired.ended).toEqual([]);
    expect(expired.state).toEqual(first.state);
    const high = applyReading(expired.state, reading(96, null, later), [rule], later);
    expect(high.started).toEqual([]);
    const low = applyReading(high.state, reading(89, null, later + 1), [rule], later + 1);
    expect(low.state.size).toBe(0);
    expect(low.ended).toEqual([{ crossing: first.started[0]!, reason: "below_threshold" }]);
  });

  test("a stale reading changes nothing, including a reset that has passed", () => {
    const first = applyReading(new Map(), reading(95, now + 1), [rule], now);
    const later = now + STALE_AFTER_MS + 1;
    const change = applyReading(first.state, reading(4), [rule], later);
    expect(change).toEqual({ state: first.state, started: [], ended: [] });
    expect(change.state).toBe(first.state);
    expect(applyReading(new Map(), reading(95), [rule], later).started).toEqual([]);
  });

  test("a reading exactly 15 minutes old is fresh", () => {
    expect(applyReading(new Map(), reading(95, null), [rule], now + STALE_AFTER_MS).started).toHaveLength(1);
  });

  test("readings of two accounts do not alter each other's crossings", () => {
    const other: LimitRule = { ...rule, account: "codex:personal" };
    const rules = [rule, other];
    const first = applyReading(new Map(), reading(95, null), rules, now);
    const second = applyReading(first.state, reading(96, null, now, other.account), rules, now);
    expect(second.started.map((crossing) => crossing.account)).toEqual([other.account]);
    expect(second.state.size).toBe(2);
    expect(second.state.get("claude:personal seven_day")).toBe(first.started[0]);
    const low = applyReading(second.state, reading(4, null), rules, now);
    expect(low.ended.map(({ crossing }) => crossing.account)).toEqual([rule.account]);
    expect(low.state.get("codex:personal seven_day")).toBe(second.started[0]);
  });

  test("a missing or unknown window changes nothing", () => {
    const first = applyReading(new Map(), reading(95, null), [rule], now);
    const missing = applyReading(first.state, { account: rule.account, measuredAt: now, windows: [] }, [rule], now);
    expect(missing).toEqual({ state: first.state, started: [], ended: [] });
    const unknown = applyReading(first.state, {
      account: rule.account, measuredAt: now, windows: [{ name: "monthly", usedPercent: 4, resetsAt: null }],
    }, [rule], now);
    expect(unknown).toEqual({ state: first.state, started: [], ended: [] });
  });

  test("expiry ends every crossing whose reset is at or before now", () => {
    const other = { ...rule, account: "codex:personal" as const };
    const first = applyReading(new Map(), reading(95, now + 1), [rule], now);
    const second = applyReading(first.state, reading(96, now + 2, now, other.account), [other], now);
    const expired = expireCrossings(second.state, now + 2);
    expect(expired.state.size).toBe(0);
    expect(expired.started).toEqual([]);
    expect(expired.ended).toEqual([
      { crossing: first.started[0]!, reason: "reset_passed" },
      { crossing: second.started[0]!, reason: "reset_passed" },
    ]);
  });

  test("applyReading and expireCrossings never modify the input maps or crossings", () => {
    const empty: CrossingState = new Map();
    const first = applyReading(empty, reading(95), [rule], now);
    expect(empty.size).toBe(0);
    const crossing = Object.freeze(first.started[0]!);
    const input: CrossingState = new Map([["claude:personal seven_day", crossing]]);
    const snapshot = [...input];
    applyReading(input, reading(4), [rule], now);
    expect([...input]).toEqual(snapshot);
    applyReading(input, reading(96), [rule], now);
    expect([...input]).toEqual(snapshot);
    expireCrossings(input, now + 10_000);
    expect([...input]).toEqual(snapshot);
    expect(crossing.usedPercent).toBe(95);
  });

  test("a switch crossing carries its target", () => {
    const switchRule: LimitRule = { ...rule, action: "switch", switchTo: "codex:personal" };
    expect(applyReading(new Map(), reading(95), [switchRule], now).started[0]).toEqual({
      account: rule.account, window: "seven_day", usedPercent: 95, threshold: 90,
      action: "switch", switchTo: "codex:personal", resetsAt: now + 10_000, startedAt: now,
    });
  });
});

describe("Review findings", () => {
  test("a fresh reading of a window whose reset has passed starts nothing", () => {
    const first = applyReading(new Map(), reading(95, now + 1_000), [rule], now);
    expect(first.started).toHaveLength(1);
    const later = now + 2_000;
    const again = applyReading(first.state, reading(95, now + 1_000, now), [rule], later);
    expect(again.ended).toEqual([{ crossing: first.started[0]!, reason: "reset_passed" }]);
    expect(again.started).toEqual([]);
    const third = applyReading(again.state, reading(95, now + 1_000, now), [rule], later);
    expect(third.started).toEqual([]);
    expect(third.ended).toEqual([]);
  });

  test("a crossing that started without a reset time learns it and then expires", () => {
    const first = applyReading(new Map(), reading(95, null), [rule], now);
    const learned = applyReading(first.state, reading(96, now + 5_000), [rule], now + 1);
    expect(learned.started).toEqual([]);
    expect(learned.state.get(`${rule.account} ${rule.window}`)?.resetsAt).toBe(now + 5_000);
    expect(first.state.get(`${rule.account} ${rule.window}`)?.resetsAt).toBeNull();
    const expired = expireCrossings(learned.state, now + 5_000);
    expect(expired.ended.map((item) => item.reason)).toEqual(["reset_passed"]);
  });
});
