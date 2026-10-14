// Resume at reset for T3 Code threads (add-resume-at-reset, task 4.2), with the fake T3 server and
// the injectable clock: relay finds a thread stopped at a usage limit, waits for the reset, and
// sends the continue message to that same thread once, only when it is idle.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterRegistry } from "../../src/adapters/registry";
import { validateConfig } from "../../src/core/config/validate";
import { setClock } from "../../src/platform/clock";
import { parseToml } from "../../src/platform/toml";
import type { Timing } from "../../src/resume/timing";
import { createT3Client } from "../../src/t3/client";
import { classifyFailure, T3Resumer } from "../../src/t3/resume";
import { cancelT3Wait, readT3State, readT3Waits, t3WaitLine } from "../../src/t3/resume-state";
import { startFakeT3, type FakeT3, type FakeThread } from "../fakes/fake-t3";
import { fakeEnv } from "../helpers/fake-programs";
import { tempRelayHome } from "../helpers/relay-home";

const TOKEN = "fake-token-for-resume-tests";
const TIMING: Timing = { tickMs: 1000, checkMs: 15 * 60_000, checkJitterMs: 0, marginMs: 60_000, resetJitterMs: 0, maxUnknownMs: 7 * 86_400_000 };
const CONFIG = `[accounts."claude:personal"]
[accounts."codex:personal"]
[t3.instances.claude]
account = "claude:personal"
[t3.instances.codex]
account = "codex:personal"
`;
// 2026-10-13 12:00 on this computer's clock; limit messages give local times.
const NOON = new Date(2026, 9, 13, 12, 0, 0);
// Claude Code names the person's time zone; here it is the zone the tests run in.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CLAUDE_LIMIT = `You've hit your session limit · resets 1:00pm (${ZONE})`;

let clock = NOON;
let fake: FakeT3 | undefined;
beforeEach(() => {
  clock = NOON;
  setClock(() => clock);
});
afterEach(async () => {
  setClock(null);
  await fake?.stop();
  fake = undefined;
});

function limitedThread(threadId: string, instance = "claude", text = CLAUDE_LIMIT): FakeThread {
  return {
    threadId, projectId: "project-1", title: "A private title", providerInstanceId: instance, model: "sonnet", runtimeMode: "full-access",
    runs: [{ runId: `${threadId}-run-1`, status: "failed", startedAt: NOON.toISOString(), completedAt: NOON.toISOString() }],
    items: [
      { type: "user_message", runId: `${threadId}-run-1`, text: "Do the work." },
      { type: "error", runId: `${threadId}-run-1`, text },
    ],
  };
}

async function setUp(
  threads: FakeThread[], settings = 'accounts = ["claude:personal"]', scenario: Parameters<typeof fakeEnv>[0] = {},
  beforeCall?: (tool: string, args: Record<string, unknown>) => Promise<void> | void,
) {
  fake = await startFakeT3({ token: TOKEN, threads, beforeCall, projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/project" }] });
  const relayHome = tempRelayHome();
  const { config, problems } = validateConfig(parseToml(`${CONFIG}[t3.resume_at_reset]\n${settings}\n`), { relayHome, homedir: "/home/person" });
  expect(problems).toEqual([]);
  const env = { ...process.env, ...fakeEnv(scenario) };
  const resumer = () => new T3Resumer({
    relayHome, env, timing: TIMING, random: () => 0, config: () => config, registry: () => createAdapterRegistry({}, env),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    client: async () => createT3Client({
      url: fake!.url, token: async () => TOKEN, version: "0.1.0", fetch: fake!.fetch, sleep: async () => {}, logger: { info: () => {}, warn: () => {} },
    }),
  });
  return { relayHome, resumer, fake: fake!, sends: () => fake!.calls.filter((call) => call.tool === "t3_thread_send") };
}

function events(relayHome: string): Record<string, unknown>[] {
  const path = join(relayHome, "t3", "actions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

test("a Claude limit with a reset time: relay waits, then sends continue to the same thread once", async () => {
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1")]);
  const watcher = resumer();
  await watcher.tick();
  const reset = new Date(2026, 9, 13, 13, 0, 0);
  expect(events(relayHome).map((event) => event.type)).toEqual(["limit_seen", "waiting"]);
  expect(events(relayHome)[1]).toMatchObject({
    thread_id: "thread-1", run_id: "thread-1-run-1", account: "claude:personal", reset_at: reset.toISOString(), source: "message_text",
    next_check_at: new Date(reset.getTime() + 60_000).toISOString(),
  });
  expect(t3WaitLine(readT3Waits(relayHome)[0]!)).toBe("T3 thread thread-1 on claude:personal: waiting for the limit to reset at 13:00, then continuing.");

  // Before the reset nothing is sent.
  clock = new Date(reset.getTime() + 30_000);
  await watcher.tick();
  expect(sends()).toHaveLength(0);

  clock = new Date(reset.getTime() + 61_000);
  await watcher.tick();
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  expect(sends()[0]!.args).toEqual({
    threadId: "thread-1", message: "The usage limit has reset. Continue the task from where you stopped.", mode: "queue",
    clientRequestId: "relay-resume-thread-1-thread-1-run-1",
  });
  expect(events(relayHome).map((event) => event.type)).toEqual(["limit_seen", "waiting", "sent"]);
  // No event holds a message text or the title.
  expect(readFileSync(join(relayHome, "t3", "actions.jsonl"), "utf8")).not.toMatch(/session limit|private title|Do the work/);
  expect(readFileSync(join(relayHome, "t3", "resume-at-reset.json"), "utf8")).not.toMatch(/session limit|private title/);
});

test("another failure is read once and left alone", async () => {
  const { relayHome, resumer, sends, fake } = await setUp([limitedThread("thread-1", "claude", "Claude API is overloaded (529). Try again shortly.")]);
  const watcher = resumer();
  await watcher.tick();
  await watcher.tick();
  clock = new Date(NOON.getTime() + 86_400_000);
  await watcher.tick();
  expect(sends()).toHaveLength(0);
  expect(events(relayHome)).toEqual([]);
  // One short read and one read of the last items, once.
  expect(fake.calls.filter((call) => call.tool === "t3_thread_read")).toHaveLength(2);
});

test("a thread that moved on before the reset is not sent anything", async () => {
  const { relayHome, resumer, sends, fake } = await setUp([limitedThread("thread-1")]);
  const watcher = resumer();
  await watcher.tick();
  // The person, or T3's own resume, continued the thread.
  fake.threads[0]!.runs.unshift({ runId: "thread-1-run-2", status: "running", startedAt: NOON.toISOString(), completedAt: null });
  clock = new Date(2026, 9, 13, 13, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(0);
  expect(events(relayHome).at(-1)).toMatchObject({ type: "skipped", reason: "thread_moved_on", thread_id: "thread-1" });
  expect(readT3Waits(relayHome)).toEqual([]);
});

test("a daemon restart after relay marked the send never sends twice", async () => {
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1")]);
  await resumer().tick();
  clock = new Date(2026, 9, 13, 13, 2, 0);
  await resumer().tick();
  expect(sends()).toHaveLength(1);
  // A new daemon, with the state file on disk.
  await resumer().tick();
  await resumer().tick();
  expect(sends()).toHaveLength(1);
  expect(readT3State(relayHome).threads["thread-1"]).toMatchObject({ state: "sent", sent_run_id: expect.any(String) });
});

test("a send that hits the limit again counts, and relay gives up after max_resumes", async () => {
  const { relayHome, resumer, sends, fake } = await setUp([limitedThread("thread-1")], 'accounts = ["claude:personal"]\nmax_resumes = 2');
  const watcher = resumer();
  const failNewest = (resetText: string) => {
    const thread = fake.threads[0]!;
    const run = thread.runs[0]!;
    run.status = "failed";
    run.completedAt = clock.toISOString();
    thread.items!.push({ type: "error", runId: run.runId, text: resetText });
  };
  await watcher.tick();
  clock = new Date(2026, 9, 13, 13, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  failNewest(`You've hit your session limit · resets 2:00pm (${ZONE})`);
  await watcher.tick();
  clock = new Date(2026, 9, 13, 14, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(2);
  failNewest(`You've hit your session limit · resets 3:00pm (${ZONE})`);
  await watcher.tick();
  clock = new Date(2026, 9, 13, 15, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(2);
  expect(events(relayHome).at(-1)).toMatchObject({ type: "gave_up", reason: "limit_again", sends_in_a_row: 2 });
});

test("without any reading, an unknown reset time is checked every 15 minutes and the thread is continued after 5 hours", async () => {
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1", "claude", "Claude usage limit reached. Send the message again once the limit resets.")]);
  const watcher = resumer();
  await watcher.tick();
  expect(events(relayHome)[1]).toMatchObject({ type: "waiting", reset_at: null, next_check_at: new Date(NOON.getTime() + 15 * 60_000).toISOString() });
  clock = new Date(NOON.getTime() + 14 * 60_000);
  await watcher.tick();
  expect(sends()).toHaveLength(0);
  clock = new Date(NOON.getTime() + 15 * 60_000);
  await watcher.tick();
  expect(sends()).toHaveLength(0);
  expect(events(relayHome).at(-1)).toMatchObject({ type: "checked", result: "no_reading", next_check_at: new Date(NOON.getTime() + 30 * 60_000).toISOString() });
  clock = new Date(NOON.getTime() + 5 * 3_600_000 + 60_000);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  expect(events(relayHome).slice(-2).map((event) => [event.type, event.result ?? null])).toEqual([["checked", "resuming"], ["sent", null]]);
});

test("an unknown reset time is learned from Claude's /usage command", async () => {
  const usage = "Current session: 100% used · resets 2:00pm (Asia/Tokyo)\nCurrent week (all models): 40% used · resets Oct 18, 9:00am (Asia/Tokyo)\n";
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1", "claude", "Claude stopped: a usage limit blocked the request.")], undefined, { usage_text: usage });
  const watcher = resumer();
  await watcher.tick();
  // 2:00pm in Tokyo is 05:00 UTC on 2026-10-14 or 2026-10-13, whichever comes first after noon here.
  const waiting = events(relayHome)[1]!;
  expect(waiting).toMatchObject({ type: "waiting", source: "usage_command" });
  const reset = new Date(waiting.reset_at as string);
  expect(reset.getUTCHours()).toBe(5);
  expect(reset > NOON && reset.getTime() - NOON.getTime() <= 86_400_000).toBe(true);
  clock = new Date(reset.getTime() + 61_000);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
});

test("T3's own limit text with Claude's message in the same run gives the reset time", async () => {
  const thread = limitedThread("thread-1", "claude", "Claude usage limit reached. Send the message again once the limit resets.");
  thread.items!.splice(1, 0, { type: "assistant_message", runId: "thread-1-run-1", text: CLAUDE_LIMIT });
  const { relayHome, resumer } = await setUp([thread]);
  await resumer().tick();
  expect(events(relayHome)[1]).toMatchObject({ type: "waiting", source: "message_text", reset_at: new Date(2026, 9, 13, 13, 0).toISOString() });
});

test("after max_resumes relay stays away from the thread until one of its runs completes", async () => {
  const { relayHome, resumer, sends, fake } = await setUp([limitedThread("thread-1")], 'accounts = ["claude:personal"]\nmax_resumes = 1');
  const watcher = resumer();
  const thread = fake.threads[0]!;
  const failNewest = (text: string) => {
    const run = thread.runs[0]!;
    run.status = "failed";
    run.completedAt = clock.toISOString();
    thread.items!.push({ type: "error", runId: run.runId, text });
  };
  await watcher.tick();
  clock = new Date(2026, 9, 13, 13, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  failNewest(`You've hit your session limit · resets 2:00pm (${ZONE})`);
  await watcher.tick();
  expect(events(relayHome).at(-1)).toMatchObject({ type: "gave_up", reason: "limit_again" });
  // The person tries again by hand and hits the limit again: relay still stays away.
  thread.runs.unshift({ runId: "thread-1-run-9", status: "failed", startedAt: clock.toISOString(), completedAt: clock.toISOString() });
  thread.items!.push({ type: "error", runId: "thread-1-run-9", text: `You've hit your session limit · resets 3:00pm (${ZONE})` });
  clock = new Date(2026, 9, 13, 16, 0, 0);
  await watcher.tick();
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  expect(readT3State(relayHome).threads["thread-1"]).toMatchObject({ state: "gave_up" });
  // A run completes: relay watches the thread again.
  thread.runs.unshift({ runId: "thread-1-run-10", status: "completed", startedAt: clock.toISOString(), completedAt: clock.toISOString() });
  await watcher.tick();
  expect(readT3State(relayHome).threads["thread-1"]).toBeUndefined();
  expect(events(relayHome).at(-1)).toMatchObject({ type: "watching_again", thread_id: "thread-1" });
});

test("threads that are not chosen, and threads of an unmapped instance, are untouched", async () => {
  const { relayHome, resumer, fake } = await setUp([limitedThread("thread-1", "codex", "You’ve hit your usage limit. Upgrade to Pro or try again at 1:00 PM."), limitedThread("thread-2", "cursor")]);
  await resumer().tick();
  expect(events(relayHome)).toEqual([]);
  expect(fake.calls.filter((call) => call.tool === "t3_thread_read")).toHaveLength(0);
});

test("chosen threads are watched on any mapped account, and relay resume-at-reset off cancels a wait", async () => {
  const { relayHome, resumer, sends } = await setUp(
    [limitedThread("thread-1", "codex", "You’ve hit your usage limit. Upgrade to Pro or try again at 1:00 PM.")], 'threads = ["thread-1"]',
  );
  await resumer().tick();
  expect(events(relayHome)[1]).toMatchObject({ type: "waiting", account: "codex:personal" });
  expect(await cancelT3Wait(relayHome, "thread-1")).toBe(true);
  clock = new Date(2026, 9, 13, 13, 5, 0);
  await resumer().tick();
  expect(sends()).toHaveLength(0);
  expect(events(relayHome).at(-1)).toMatchObject({ type: "cancelled", thread_id: "thread-1", reason: "person" });
  expect(await cancelT3Wait(relayHome, "thread-1")).toBe(false);
});

test("the limit messages T3 shows are read with their reset times", () => {
  const after = NOON;
  expect(classifyFailure(CLAUDE_LIMIT, after)).toEqual({ kind: "limit", reset: { at: new Date(2026, 9, 13, 13, 0), source: "message_text" } });
  expect(classifyFailure("You've hit your weekly limit · resets Mon 12:00am", after)).toMatchObject({ kind: "limit", reset: { at: new Date(2026, 9, 19, 0, 0) } });
  expect(classifyFailure("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.", after))
    .toMatchObject({ kind: "limit", reset: { at: new Date(2026, 9, 13, 15, 45) } });
  expect(classifyFailure("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 15th, 2026 3:45 PM.", after))
    .toMatchObject({ kind: "limit", reset: { at: new Date(2026, 9, 15, 15, 45) } });
  expect(classifyFailure("Claude API rate limit reached. Try again later.", after)).toEqual({ kind: "limit", reset: null });
  expect(classifyFailure("Claude usage limit reached. Send the message again once the limit resets.", after)).toEqual({ kind: "limit", reset: null });
  expect(classifyFailure("Claude stopped: a usage limit blocked the request.", after)).toEqual({ kind: "limit", reset: null });
  // A named zone is honoured: 1:00pm in Tokyo (UTC+9) is 04:00 UTC.
  expect(classifyFailure("You've hit your session limit · resets 1:00pm (Asia/Tokyo)", new Date("2026-10-13T00:00:00Z")))
    .toEqual({ kind: "limit", reset: { at: new Date("2026-10-13T04:00:00Z"), source: "message_text" } });
  expect(classifyFailure("You've hit your session limit · resets 1:00pm (Asia/Tokyo)", new Date("2026-10-13T05:00:00Z")))
    .toEqual({ kind: "limit", reset: { at: new Date("2026-10-14T04:00:00Z"), source: "message_text" } });
  expect(classifyFailure("You're out of included usage · /usage-credits to continue", after)).toEqual({ kind: "credits" });
  expect(classifyFailure("Claude API is overloaded (529). Try again shortly.", after)).toEqual({ kind: "other" });
});

test("a stop found after its reset time is due at once, not a day later", async () => {
  clock = new Date(2026, 9, 13, 14, 0, 0);
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1")]);
  await resumer().tick();
  expect(events(relayHome)[1]).toMatchObject({ type: "waiting", reset_at: new Date(2026, 9, 13, 13, 0).toISOString() });
  expect(sends()).toHaveLength(1);
});

test("cancelling while relay reads a thread that stopped again is not undone", async () => {
  let cancelOnRead = false;
  let relayHomeRef = "";
  const { relayHome, resumer, sends, fake } = await setUp([limitedThread("thread-1")], undefined, {}, async (tool, args) => {
    if (cancelOnRead && tool === "t3_thread_read" && args.threadId === "thread-1") {
      cancelOnRead = false;
      expect(await cancelT3Wait(relayHomeRef, "thread-1")).toBe(true);
    }
  });
  relayHomeRef = relayHome;
  const watcher = resumer();
  await watcher.tick();
  clock = new Date(2026, 9, 13, 13, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  // The run relay started stops at the limit again; the person cancels while relay reads it.
  const thread = fake.threads[0]!;
  thread.runs[0]!.status = "failed";
  thread.runs[0]!.completedAt = clock.toISOString();
  thread.items!.push({ type: "error", runId: thread.runs[0]!.runId, text: `You've hit your session limit · resets 2:00pm (${ZONE})` });
  cancelOnRead = true;
  await watcher.tick();
  clock = new Date(2026, 9, 13, 14, 5, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  expect(readT3State(relayHome).threads["thread-1"]).toBeUndefined();
  expect(events(relayHome).filter((event) => event.type === "waiting")).toHaveLength(1);
});
