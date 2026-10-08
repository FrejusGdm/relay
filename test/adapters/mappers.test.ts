import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClaudeStreamMapper } from "../../src/adapters/claude/stream";
import { availabilityFromRateLimits, createAppServerMapper, windowsFromSnapshot } from "../../src/adapters/codex/app-server";
import { createExecMapper } from "../../src/adapters/codex/exec-stream";
import type { MapperContext, StreamMapper } from "../../src/adapters/mapper";
import { setClock } from "../../src/platform/clock";
import { FIXTURES_ROOT, listFixtures, loadFixture, replayFixture } from "./fixtures";
import { MAPPERS } from "./mappers";

for (const [provider, folder, transport] of [
  ["claude", "print", "claude-print"], ["codex", "app-server", "codex-app-server"], ["codex", "exec", "codex-exec"],
] as const) {
  for (const path of listFixtures(FIXTURES_ROOT, provider, folder)) {
    const fixture = loadFixture(path);
    test(`${transport} fixtures: ${fixture.name}`, () => replayFixture(fixture, MAPPERS[transport]));
  }
}

let previousTimezone: string | undefined;
beforeEach(() => {
  previousTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  setClock(() => new Date("2026-10-08T12:00:00.000Z"));
});
afterEach(() => {
  setClock(null);
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
});

function assistant(text: string, error?: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, ...(error !== undefined ? { error } : {}) };
}
function failedTurn(info: string, message = "Failure.") {
  return { method: "turn/completed", params: { turn: { status: "failed", error: { codexErrorInfo: info, message } } } };
}
function snapshot(percent = 62, reached: string | null = null) {
  return { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1791474300 }, secondary: null, rateLimitReachedType: reached };
}

test("Claude reads milliseconds in resetsAt", () => {
  const mapper = createClaudeStreamMapper({ interruptSent: false });
  expect(mapper.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rate_limit_type: "five_hour", utilization: 1, resetsAt: 1791387900000 } })).toEqual([
    { kind: "limit_update", windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 100, resetsAt: new Date("2026-10-07T15:45:00Z"), source: "stream_event" }], state: "quota_exhausted", retryAt: new Date("2026-10-07T15:45:00Z"), source: "stream_event" },
  ]);
});

test("Claude weekly text gives the next Monday in local time", () => {
  process.env.TZ = "Europe/Paris";
  setClock(() => new Date(2026, 9, 10, 12));
  const mapper = createClaudeStreamMapper({ interruptSent: false });
  const text = "You've hit your weekly limit · resets Mon 12:00am";
  mapper.push(assistant(text, "rate_limit"));
  expect(mapper.push({ type: "result", is_error: true, result: text })).toEqual([
    { kind: "turn_failed", reason: "usage_limit", message: text, retryAt: new Date(2026, 9, 12, 0), source: "message_text" },
  ]);
  expect(mapper.end()).toEqual([]);
});

test("Claude overload is a turn failure", () => {
  const mapper = createClaudeStreamMapper({ interruptSent: false });
  mapper.push(assistant("API Error: Repeated 529 Overloaded errors", "overloaded"));
  expect(mapper.push({ type: "result", is_error: true })).toEqual([
    { kind: "turn_failed", reason: "overloaded", message: "API Error: Repeated 529 Overloaded errors", source: "stream_event" },
  ]);
});

test("Claude reads the live interrupt context when the result arrives", () => {
  const context = { interruptSent: false };
  const mapper = createClaudeStreamMapper(context);
  mapper.push(assistant("Working."));
  context.interruptSent = true;
  expect(mapper.push({ type: "result", is_error: true })).toEqual([
    { kind: "turn_failed", reason: "interrupted", message: "Interrupted.", source: "stream_event" },
  ]);
  expect(mapper.end()).toEqual([]);
});

test("Claude rate-limit state does not leak into the next turn", () => {
  const mapper = createClaudeStreamMapper({ interruptSent: false });
  mapper.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rate_limit_type: "five_hour", resetsAt: 1791474300 } });
  mapper.push(assistant("Limit reached.", "rate_limit"));
  mapper.push({ type: "result", is_error: true });
  mapper.push(assistant("Temporary rate limit.", "rate_limit"));
  expect(mapper.push({ type: "result", is_error: true })).toEqual([
    { kind: "turn_failed", reason: "rate_limit", message: "Temporary rate limit.", source: "stream_event" },
  ]);
});

test("Claude tool results retain metadata and parse Bash exit codes", () => {
  const mapper = createClaudeStreamMapper({ interruptSent: false });
  mapper.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "false" } }] } });
  expect(mapper.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: true, content: [{ type: "text", text: "Exit code 7" }] }] } })).toEqual([
    { kind: "tool", toolId: "tool", name: "Bash", command: "false", status: "failed", exitCode: 7 },
  ]);
  expect(mapper.push({ type: "result", is_error: false, permission_denials: [{ tool_name: "Bash" }], duration_ms: "bad", total_cost_usd: null })).toEqual([
    { kind: "permission_denied", tool: "Bash" }, { kind: "turn_completed" },
  ]);
});

test("app-server retry errors do not fail a completed turn", () => {
  const mapper = createAppServerMapper({ interruptSent: false });
  expect(mapper.push({ method: "error", params: { willRetry: true, error: { message: "Retrying." } } })).toEqual([]);
  expect(mapper.push({ method: "turn/completed", params: { turn: { status: "completed" } } })).toEqual([{ kind: "turn_completed" }]);
  expect(mapper.end()).toEqual([]);
});

for (const [info, reason] of [
  ["rateLimitExceeded", "rate_limit"], ["serverOverloaded", "overloaded"], ["contextWindowExceeded", "context_full"],
] as const) {
  test(`app-server maps ${info}`, () => {
    const mapper = createAppServerMapper({ interruptSent: false });
    expect(mapper.push(failedTurn(info))).toEqual([{ kind: "turn_failed", reason, message: "Failure.", source: "stream_event" }]);
  });
}

test("app-server usage failure waits for the response and uses only full windows", () => {
  const mapper = createAppServerMapper({ interruptSent: false });
  expect(mapper.push(failedTurn("usageLimitExceeded"))).toEqual([]);
  expect(mapper.push({ id: 1, error: { code: -1, message: "No reading." } })).toEqual([]);
  expect(mapper.push({ id: 2, result: { rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791474300 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791820800 },
  } } })).toEqual([
    { kind: "turn_failed", reason: "usage_limit", message: "Failure.", source: "provider_api", retryAt: new Date(1791820800 * 1000) },
  ]);
  expect(mapper.end()).toEqual([]);
  expect(mapper.push(failedTurn("usageLimitExceeded"))).toEqual([]);
  expect(mapper.push({ id: 3, result: { rateLimits: snapshot() } })).toEqual([
    { kind: "turn_failed", reason: "usage_limit", message: "Failure.", source: "provider_api" },
  ]);
});

test("app-server ends a held usage failure without guessing a reset", () => {
  const mapper = createAppServerMapper({ interruptSent: false });
  mapper.push(failedTurn("usageLimitExceeded"));
  expect(mapper.end()).toEqual([{ kind: "turn_failed", reason: "usage_limit", message: "Failure.", source: "provider_api" }]);
  expect(mapper.end()).toEqual([]);
});

test("app-server uses tokenUsage.last and clears it between turns", () => {
  const mapper = createAppServerMapper({ interruptSent: false });
  mapper.push({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 999 }, last: { inputTokens: 12, reasoningOutputTokens: 3 } } } });
  const completed = { method: "turn/completed", params: { turn: { status: "completed" } } };
  expect(mapper.push(completed)).toEqual([{ kind: "turn_completed", usage: { inputTokens: 12, reasoningOutputTokens: 3 } }]);
  expect(mapper.push(completed)).toEqual([{ kind: "turn_completed" }]);
});

for (const [text, date] of [
  ["You've hit your usage limit. Please try again at 3:45 PM.", "2026-10-08T15:45:00.000Z"],
  ["You’ve hit your usage limit. Please try again at Oct 9th, 2026 3:45 PM.", "2026-10-09T15:45:00.000Z"],
] as const) {
  test(`exec parses reset text: ${text}`, () => {
    const mapper = createExecMapper({ interruptSent: false });
    expect(mapper.push({ type: "error", message: text })).toEqual([]);
    expect(mapper.push({ type: "turn.failed", error: { message: text } })).toEqual([
      { kind: "turn_failed", reason: "usage_limit", message: text, retryAt: new Date(date), source: "message_text" },
    ]);
    expect(mapper.end()).toEqual([]);
  });
}

test("availability reports allowed usage and five-hour windows", () => {
  expect(availabilityFromRateLimits({ rateLimits: snapshot(), ordinaryUsageAllowed: true }, "codex:test")).toEqual({
    account: "codex:test", state: "available", windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 62, resetsAt: new Date("2026-10-08T15:45:00Z"), source: "provider_api" }], source: "provider_api", observedAt: new Date("2026-10-08T12:00:00Z"),
  });
});

test("availability reports null as unknown and preserves windows", () => {
  const result = availabilityFromRateLimits({ rateLimits: snapshot(), ordinaryUsageAllowed: null }, "codex:test");
  expect(result.state).toBe("unknown");
  expect(result.detail).toBe("Codex did not say whether usage is allowed.");
  expect(result.windows).toHaveLength(1);
  expect(result).not.toHaveProperty("retryAt");
});

test("availability reports reached or disallowed usage as exhausted", () => {
  for (const [rateLimits, ordinaryUsageAllowed] of [[snapshot(100, "rate_limit_reached"), true], [snapshot(100), false]] as const) {
    const result = availabilityFromRateLimits({ rateLimits, ordinaryUsageAllowed }, "codex:test");
    expect(result.state).toBe("quota_exhausted");
    expect(result.retryAt).toEqual(new Date("2026-10-08T15:45:00Z"));
  }
});

test("availability takes the weekly full window's reset", () => {
  const result = availabilityFromRateLimits({ ordinaryUsageAllowed: false, rateLimits: {
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1791387900 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791820800 }, rateLimitReachedType: null,
  } }, "codex:test");
  expect(result.retryAt).toEqual(new Date(1791820800 * 1000));
  expect(result.windows.map((window) => window.name)).toEqual(["five_hour", "seven_day"]);
});

test("snapshot windows keep other durations and omit absent optional fields", () => {
  expect(windowsFromSnapshot({ primary: { windowDurationMins: 60, usedPercent: null, resetsAt: null }, secondary: null })).toEqual([
    { name: "60_minutes", windowMinutes: 60, source: "provider_api" },
  ]);
});

for (const [name, factory, start] of [
  ["Claude", createClaudeStreamMapper, { type: "system", subtype: "init", session_id: "session" }],
  ["app-server", createAppServerMapper, { method: "turn/started", params: { turn: { status: "inProgress" } } }],
  ["exec", createExecMapper, { type: "turn.started" }],
] as const) {
  test(`${name} counts unknown types and tolerates malformed messages`, () => {
    const mapper = factory({ interruptSent: false });
    for (const message of [null, [], 17, "text", {}, { type: 17, method: 17 }, { type: "assistant", message: null }, { method: "item/completed", params: { item: null } }]) {
      expect(mapper.push(message)).toEqual([]);
    }
    const before = mapper.unknown;
    expect(mapper.push({ type: "new-type", method: "new-method", extra: true })).toEqual([]);
    expect(mapper.unknown).toBe(before + 1);
    expect(mapper.end()).toEqual([]);
  });
  test(`${name} reads the live interrupt context at end and ends only once`, () => {
    const context: MapperContext = { interruptSent: false };
    const mapper: StreamMapper = factory(context);
    mapper.push(start);
    context.interruptSent = true;
    expect(mapper.end()).toEqual([{ kind: "turn_failed", reason: "interrupted", message: "The agent stopped before the turn ended.", source: "none" }]);
    expect(mapper.end()).toEqual([]);
  });
}

test("all mappers cut failure messages to 300 characters", () => {
  const text = "x".repeat(400);
  const cases = [
    [createClaudeStreamMapper, { type: "result", is_error: true, result: text }],
    [createAppServerMapper, failedTurn("other", text)],
    [createExecMapper, { type: "turn.failed", error: { message: text } }],
  ] as const;
  for (const [factory, message] of cases) {
    const event = factory({ interruptSent: false }).push(message)[0];
    expect(event?.kind).toBe("turn_failed");
    if (event?.kind !== "turn_failed") throw new Error("Expected a turn failure.");
    expect(event.message).toBe(text.slice(0, 300));
  }
});

for (const [name, factory, message] of [
  ["Claude", createClaudeStreamMapper, { type: "assistant", message: { content: [{ type: "text", text: 17 }, { type: "tool_use", id: null, name: "Bash", input: {} }] } }],
  ["app-server", createAppServerMapper, { method: "item/completed", params: { item: { type: "commandExecution", id: 17, command: false, status: "completed" } } }],
  ["exec", createExecMapper, { type: "item.completed", item: { type: "file_change", id: "tool", status: "completed", changes: [{ path: 17 }] } }],
] as const) {
  test(`${name} ignores malformed event fields without opening a turn`, () => {
    const mapper = factory({ interruptSent: false });
    expect(mapper.push(message)).toEqual([]);
    expect(mapper.end()).toEqual([]);
  });
}

test("a message before the session ID is emitted in its original order", () => {
  for (const [factory, message, session] of [
    [createClaudeStreamMapper, assistant("Early."), { type: "system", subtype: "init", session_id: "session" }],
    [createAppServerMapper, { method: "item/agentMessage/delta", params: { delta: "Early." } }, { id: 1, result: { thread: { id: "session" } } }],
    [createExecMapper, { type: "item.completed", item: { type: "agent_message", text: "Early." } }, { type: "thread.started", thread_id: "session" }],
  ] as const) {
    const mapper = factory({ interruptSent: false });
    expect(mapper.push(message)[0]?.kind).toBe("message");
    expect(mapper.push(session)).toEqual([{ kind: "session_started", providerSessionId: "session", source: "stream" }]);
    expect(mapper.end()).toEqual([{ kind: "turn_failed", reason: "crashed", message: "The agent stopped before the turn ended.", source: "none" }]);
  }
});
