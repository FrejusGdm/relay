import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { EventQueue, recordWorkerReading, textForAgent, unsupportedOperation } from "../../../src/adapters/worker";
import type { FailureReason, WorkerEvent } from "../../../src/adapters/types";
import { recordReading, readAvailability } from "../../../src/accounts/availability";
import { spoolLine } from "../../../src/hooks/fields";
import { now } from "../../../src/platform/clock";
import { claudeHookEvents } from "../../../src/adapters/claude/hooks";
import { claudeTest } from "./helpers/worker";

test("the event queue keeps unread events and ends after exit", async () => {
  const queue = new EventQueue();
  const first: WorkerEvent = { kind: "message", text: "First.", partial: false };
  queue.push(first);
  const iterator = queue.events()[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: first });
  const waiting = iterator.next();
  queue.push({ kind: "exited", code: 0, signal: null });
  queue.push({ kind: "message", text: "Too late.", partial: false });
  expect(await waiting).toEqual({ done: false, value: { kind: "exited", code: 0, signal: null } });
  expect((await iterator.next()).done).toBe(true);
  expect(() => queue.events()).toThrow("only be read once");
});

test("queued events remain ordered when the consumer arrives after exit", async () => {
  const queue = new EventQueue();
  const expected: WorkerEvent[] = [{ kind: "turn_completed" }, { kind: "exited", code: 0, signal: null }];
  for (const event of expected) queue.push(event);
  const actual: WorkerEvent[] = [];
  for await (const event of queue) actual.push(event);
  expect(actual).toEqual(expected);
});

for (const [error, reason] of [
  ["rate_limit", "rate_limit"], ["overloaded", "overloaded"], ["authentication_failed", "auth"],
  ["oauth_org_not_allowed", "auth"], ["billing_error", "billing"], ["server_error", "other"],
] as const) {
  test(`StopFailure maps ${error}`, () => {
    expect(claudeHookEvents(spoolLine("claude", "StopFailure", { error }, {}, now()))).toEqual([
      { kind: "turn_failed", reason, message: `Claude Code stopped: ${error}.`, source: "hook" },
    ]);
  });
}

test("only Stop and the reset notification produce other hook events", () => {
  expect(claudeHookEvents(spoolLine("claude", "Stop", {}, {}, now()))).toEqual([{ kind: "turn_completed" }]);
  expect(claudeHookEvents(spoolLine("claude", "Notification", { notification_type: "quota_auto_resume_fired" }, {}, now())))
    .toEqual([{ kind: "limit_update", windows: [], state: "available", source: "hook" }]);
  expect(claudeHookEvents(spoolLine("claude", "Notification", { notification_type: "permission_prompt" }, {}, now()))).toEqual([]);
  expect(claudeHookEvents(spoolLine("claude", "SessionStart", {}, {}, now()))).toEqual([]);
});

for (const [reason, state] of [
  ["usage_limit", "quota_exhausted"], ["rate_limit", "rate_limited"], ["auth", "unavailable"], ["billing", "unavailable"],
] as const) {
  test(`${reason} updates availability with its source and time`, async () => {
    const fixture = claudeTest();
    try {
      const retryAt = new Date(now().getTime() + 86_400_000);
      recordWorkerReading(fixture.relayHome, fixture.account, { kind: "turn_failed", reason, retryAt, message: "Stopped.", source: "hook" });
      expect(readAvailability(fixture.relayHome, fixture.account)).toMatchObject({ state, retryAt, source: "hook" });
    } finally { await fixture.cleanup(); }
  });
}

for (const reason of ["overloaded", "interrupted", "crashed", "other", "context_full"] satisfies FailureReason[]) {
  test(`${reason} leaves recorded availability alone`, async () => {
    const fixture = claudeTest();
    try {
      recordReading(fixture.relayHome, fixture.account, { state: "available", windows: [], observedAt: now(), source: "user" });
      const previous = readAvailability(fixture.relayHome, fixture.account);
      recordWorkerReading(fixture.relayHome, fixture.account, { kind: "turn_failed", reason, message: "Stopped.", source: "hook" });
      expect(readAvailability(fixture.relayHome, fixture.account)).toEqual(previous);
    } finally { await fixture.cleanup(); }
  });
}

test("limit readings infer exhaustion, respect explicit state, and merge windows", async () => {
  const fixture = claudeTest();
  try {
    recordWorkerReading(fixture.relayHome, fixture.account, { kind: "limit_update", windows: [
      { name: "five_hour", usedPercent: 101, source: "stream_event" },
    ], source: "stream_event" });
    expect(readAvailability(fixture.relayHome, fixture.account).state).toBe("quota_exhausted");
    recordWorkerReading(fixture.relayHome, fixture.account, { kind: "limit_update", windows: [
      { name: "seven_day", usedPercent: 50, source: "hook" },
    ], source: "hook" });
    expect(readAvailability(fixture.relayHome, fixture.account)).toMatchObject({ state: "available", windows: [
      { name: "five_hour", usedPercent: 101 }, { name: "seven_day", usedPercent: 50 },
    ] });
    recordWorkerReading(fixture.relayHome, fixture.account, { kind: "limit_update", windows: [], state: "unavailable", source: "hook" });
    expect(readAvailability(fixture.relayHome, fixture.account).state).toBe("unavailable");
    const file = join(fixture.root, "not-a-folder");
    writeFileSync(file, "blocked");
    expect(() => recordWorkerReading(file, fixture.account, { kind: "turn_completed" })).not.toThrow();
  } finally { await fixture.cleanup(); }
});

test("text boundaries use UTF-8 bytes and transport refusals name the mode", () => {
  expect(textForAgent("é".repeat(51_200))).toHaveLength(51_200);
  expect(textForAgent("Clean\u200b\u202e text.")).toBe("Clean text.");
  expect(() => textForAgent("é".repeat(51_201))).toThrow("The prompt is too long");
  expect(unsupportedOperation("Codex", "codex-app-server", "receive a message while it runs").message)
    .toBe("Codex in app server mode cannot receive a message while it runs.");
});
