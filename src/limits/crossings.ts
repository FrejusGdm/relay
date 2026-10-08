import type { AccountId, LimitAction, LimitWindow } from "../core/config/types";
import type { LimitRule } from "./rules";

export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface WindowReading { name: string; usedPercent: number; resetsAt: number | null }
export interface UsageReading { account: AccountId; measuredAt: number; windows: WindowReading[] }
export interface Crossing {
  account: AccountId;
  window: LimitWindow;
  usedPercent: number;
  threshold: number;
  action: LimitAction;
  switchTo: AccountId | null;
  resetsAt: number | null;
  startedAt: number;
}
export type CrossingState = ReadonlyMap<string, Crossing>;
export interface CrossingChange {
  state: CrossingState;
  started: Crossing[];
  ended: { crossing: Crossing; reason: "below_threshold" | "reset_passed" }[];
}

export function applyReading(
  state: CrossingState, reading: UsageReading, rules: readonly LimitRule[], now: number,
): CrossingChange {
  if (now - reading.measuredAt > STALE_AFTER_MS) return { state, started: [], ended: [] };
  const expired = expireCrossings(state, now);
  const next = new Map(expired.state);
  const started: Crossing[] = [];
  const ended = [...expired.ended];
  for (const rule of rules) {
    if (rule.account !== reading.account) continue;
    const window = reading.windows.find((item) => item.name === rule.window);
    // A window whose reset has passed describes a period that is over, even if the reading is fresh.
    if (window === undefined || (window.resetsAt !== null && window.resetsAt <= now)) continue;
    const key = `${rule.account} ${rule.window}`;
    const active = next.get(key);
    if (window.usedPercent >= rule.threshold && active !== undefined) {
      // Same period: keep the crossing, but learn a reset time that was unknown or has moved, so
      // expireCrossings can end it.
      if (window.resetsAt !== null && window.resetsAt !== active.resetsAt) {
        next.set(key, { ...active, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
      }
    } else if (window.usedPercent >= rule.threshold) {
      const crossing: Crossing = {
        account: rule.account, window: rule.window, usedPercent: window.usedPercent,
        threshold: rule.threshold, action: rule.action, switchTo: rule.switchTo,
        resetsAt: window.resetsAt, startedAt: now,
      };
      next.set(key, crossing);
      started.push(crossing);
    } else if (window.usedPercent < rule.threshold && active !== undefined) {
      next.delete(key);
      ended.push({ crossing: active, reason: "below_threshold" });
    }
  }
  return { state: next, started, ended };
}

export function expireCrossings(state: CrossingState, now: number): CrossingChange {
  const next = new Map(state);
  const ended: CrossingChange["ended"] = [];
  for (const [key, crossing] of state) {
    if (crossing.resetsAt !== null && crossing.resetsAt <= now) {
      next.delete(key);
      ended.push({ crossing, reason: "reset_passed" });
    }
  }
  return { state: next, started: [], ended };
}
