// Task 2.5 of add-mac-menu-bar-app: the Mac app's JSON fixtures (mac/Tests/Fixtures/api/) have
// exactly the keys, at every depth, of the real daemon's answers and events after a handoff from
// claude:work, which reported a rate limit, to codex:personal. Values may differ.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runRelayInProcess } from "../helpers/cli";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, tempRelayHome, testSocket, waitForDaemon } from "../helpers/relay-home";
import { relayTerminal, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";
import { until, workers } from "../run/helpers";

setDefaultTimeout(120_000);

const FIXTURES = join(import.meta.dir, "..", "..", "mac", "Tests", "Fixtures", "api");
const FIXTURE_JOB = "3f9a2c1d";

let fixture: SwitchFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
afterAll(() => removeTempRelayHomes());

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Where the keys of `expected` (a fixture) and `actual` (the daemon) differ. A null or an empty
// list on either side has no keys to compare.
function differences(expected: unknown, actual: unknown, path = "$"): string[] {
  if (expected === null || actual === null) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length === 0 || actual.length === 0) return [];
    return expected.flatMap((item, index) => differences(item, actual[Math.min(index, actual.length - 1)], `${path}[${index}]`));
  }
  if (isObject(expected) && isObject(actual)) {
    const found: string[] = [];
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) found.push(`${path}.${key} is in the fixture but not in the daemon's answer`);
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) found.push(`${path}.${key} is in the daemon's answer but not in the fixture`);
      else found.push(...differences(expected[key], actual[key], `${path}.${key}`));
    }
    return found;
  }
  if (isObject(expected) !== isObject(actual) || Array.isArray(expected) !== Array.isArray(actual)) {
    return [`${path} is ${JSON.stringify(expected)?.slice(0, 40)} in the fixture and ${JSON.stringify(actual)?.slice(0, 40)} in the daemon's answer`];
  }
  return [];
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

async function get(relayHome: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://relay${path}`, { unix: testSocket(relayHome) });
  return { status: response.status, body: await response.json() };
}

// Follows GET /v1/events and keeps the data of the first event of each type.
function followEvents(relayHome: string) {
  const first = new Map<string, unknown>();
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch("http://relay/v1/events", { unix: testSocket(relayHome), signal: controller.signal });
    const reader = response.body!.getReader();
    let buffer = "";
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) return;
      buffer += new TextDecoder().decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        const type = field("event");
        const data = field("data");
        if (type !== undefined && data !== undefined && !first.has(type)) first.set(type, JSON.parse(data));
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  return { first, stop: async () => { controller.abort(); await done; } };
}

test("the Mac app's fixtures have the keys of the real daemon's answers and events", async () => {
  fixture = await switchFixture();
  const { relayHome, jobId } = fixture;
  const daemon = spawnDaemon(relayHome, fixture.env);
  await waitForDaemon(relayHome);
  const events = followEvents(relayHome);
  try {

    // relay run claude:work, then a rate limit reported by Claude Code's StopFailure hook.
    fixture.scenarios.set({ claude: Scenarios.fixture("claude-edits-two-files.json") });
    const run = relayTerminal(fixture, ["run", "claude:work"]);
    try {
      await until(() => run.output().includes("The callback is done."), 30_000);
      const claude = workers(fixture).find((entry) => entry.account === "claude:work")!;
      const hook = await runRelayInProcess(["hook", "claude", "StopFailure"], {
        relayHome,
        stdin: JSON.stringify({ session_id: "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f", hook_event_name: "StopFailure", error: "rate_limit" }),
        env: { ...fixture.env, RELAY_TARGET: "claude:work", RELAY_JOB: jobId, RELAY_WORKER: claude.worker_id },
      });
      expect(hook.code).toBe(0);
      await until(() => events.first.has("availability"), 10_000);

      // relay switch codex:personal.
      fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
      const handoff = relayTerminal(fixture, ["switch", "codex:personal"]);
      expect(await handoff.child.exited).toBe(0);
      await until(() => ["job", "worker", "checkpoint"].every((type) => events.first.has(type)), 10_000);

      const answers: [string, string, number][] = [
        ["GET_v1_version.json", "/v1/version", 200],
        ["GET_v1_accounts.json", "/v1/accounts", 200],
        ["GET_v1_jobs.handoff.json", "/v1/jobs", 200],
        [`GET_v1_jobs_${FIXTURE_JOB}.handoff.json`, `/v1/jobs/${jobId}`, 200],
        [`GET_v1_jobs_${FIXTURE_JOB}_workers.handoff.json`, `/v1/jobs/${jobId}/workers`, 200],
        ["GET_v1_jobs_ffffffff.job_not_found.json", "/v1/jobs/ffffffff", 404],
      ];
      const found: string[] = [];
      for (const [name, path, status] of answers) {
        const answer = await get(relayHome, path);
        expect(answer.status).toBe(status);
        found.push(...differences(readFixture(name), answer.body, name));
      }
      for (const name of readdirSync(join(FIXTURES, "events"))) {
        const type = name.replace(/\.json$/, "");
        expect(events.first.has(type)).toBe(true);
        found.push(...differences(readFixture(join("events", name)), events.first.get(type), `events/${name}`));
      }
      // The availability event carries the whole Account (design decision 7 of the change).
      expect(Object.keys(events.first.get("availability") as object).sort()).toEqual(
        ["account", "availability", "configured", "provider", "provider_name", "target", "usage"],
      );
      expect(found).toEqual([]);
    } finally {
      run.child.kill("SIGTERM");
      await run.child.exited;
    }
  } finally {
    await events.stop();
    await stopDaemon(daemon);
  }
});

test("the empty jobs list has the keys of a daemon without jobs", async () => {
  const relayHome = tempRelayHome();
  const daemon = spawnDaemon(relayHome);
  try {
    await waitForDaemon(relayHome);
    const answer = await get(relayHome, "/v1/jobs");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ jobs: [] });
    expect(differences(readFixture("GET_v1_jobs.empty.json"), answer.body)).toEqual([]);
  } finally {
    await stopDaemon(daemon);
  }
});

test("differences finds a key that only one side has, at any depth", () => {
  expect(differences({ a: { b: 1, c: [{ d: 1 }] } }, { a: { b: 2, c: [{ d: 2, e: 3 }] } })).toEqual([
    "$.a.c[0].e is in the daemon's answer but not in the fixture",
  ]);
  expect(differences({ a: 1, x: null }, { x: { y: 1 } })).toEqual(["$.a is in the fixture but not in the daemon's answer"]);
  expect(differences({ list: [] }, { list: [{ any: 1 }] })).toEqual([]);
});
