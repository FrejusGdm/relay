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
const CLAUDE_LIMIT = "You've hit your session limit · resets 1:00pm (Europe/Berlin)";

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

async function setUp(threads: FakeThread[], settings = 'accounts = ["claude:personal"]') {
  fake = await startFakeT3({ token: TOKEN, threads, projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/project" }] });
  const relayHome = tempRelayHome();
  const { config, problems } = validateConfig(parseToml(`${CONFIG}[t3.resume_at_reset]\n${settings}\n`), { relayHome, homedir: "/home/person" });
  expect(problems).toEqual([]);
  const env = { ...process.env, ...fakeEnv() };
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
  failNewest("You've hit your session limit · resets 2:00pm (Europe/Berlin)");
  await watcher.tick();
  clock = new Date(2026, 9, 13, 14, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(2);
  failNewest("You've hit your session limit · resets 3:00pm (Europe/Berlin)");
  await watcher.tick();
  clock = new Date(2026, 9, 13, 15, 2, 0);
  await watcher.tick();
  expect(sends()).toHaveLength(2);
  expect(events(relayHome).at(-1)).toMatchObject({ type: "gave_up", reason: "limit_again", sends_in_a_row: 2 });
});

test("an unknown reset time is checked 15 minutes later, then the thread is continued", async () => {
  const { relayHome, resumer, sends } = await setUp([limitedThread("thread-1", "claude", "Claude API rate limit reached. Try again later.")]);
  const watcher = resumer();
  await watcher.tick();
  expect(events(relayHome)[1]).toMatchObject({ type: "waiting", reset_at: null, next_check_at: new Date(NOON.getTime() + 15 * 60_000).toISOString() });
  clock = new Date(NOON.getTime() + 14 * 60_000);
  await watcher.tick();
  expect(sends()).toHaveLength(0);
  clock = new Date(NOON.getTime() + 15 * 60_000);
  await watcher.tick();
  expect(sends()).toHaveLength(1);
  expect(events(relayHome).map((event) => [event.type, event.result ?? null])).toEqual([
    ["limit_seen", null], ["waiting", null], ["checked", "resuming"], ["sent", null],
  ]);
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
  expect(classifyFailure("You're out of included usage · /usage-credits to continue", after)).toEqual({ kind: "credits" });
  expect(classifyFailure("Claude API is overloaded (529). Try again shortly.", after)).toEqual({ kind: "other" });
});
