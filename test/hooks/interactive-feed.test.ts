// design.md decision 18, "Hook events for interactive workers": an interactive Claude Code worker
// (the fake agent, started through the adapter in a driver process) sees its StopFailure rate_limit
// hook whether the event went to a running daemon, which wrote it to the job's events.jsonl, or to
// the spool because no daemon ran; and the feed hands out an event that moved from the spool to
// events.jsonl only once.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildAgentEnv } from "../../src/accounts/environment";
import type { StartRequest, WorkerEvent } from "../../src/adapters/types";
import type { Account } from "../../src/core/config/types";
import { HookFeed } from "../../src/hooks/feed";
import { spoolLine } from "../../src/hooks/fields";
import { appendSpoolLine, readSpool } from "../../src/hooks/spool";
import { until } from "../adapters/claude/helpers/worker";
import { FAKE_CLAUDE } from "../helpers/fake-programs";
import { events, jobId, setUpJob } from "../helpers/job";
import { relayBin } from "../helpers/relay-bin";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const WORKER = "5678abcd";
const DRIVER = resolve(import.meta.dir, "..", "adapters", "claude", "helpers", "interactive-driver.ts");

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRelayHomes();
});

// Starts an interactive worker on the scratch job with relay's hooks installed in the fake
// agent's profile, has the agent hit a rate limit, and returns the worker's events.
async function limitInInteractiveWorker(scratch: ScratchRepo): Promise<WorkerEvent[]> {
  const root = join(scratch.root, "worker");
  const profile = join(root, "profile");
  mkdirSync(profile, { recursive: true });
  const bin = relayBin();
  cleanups.push(() => rmSync(dirname(bin), { recursive: true, force: true }));
  const hooks = Object.fromEntries(["StopFailure", "Stop", "Notification", "SessionStart"].map((event) => [event,
    [{ hooks: [{ type: "command", command: `'${bin}' hook claude ${event}`, timeout: 5 }] }],
  ]));
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ hooks }));
  const scenario = join(root, "scenario.json");
  const resetsAt = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(scenario, JSON.stringify({ version: 1, turns: [{ steps: [{ limit: { window: "primary", resets_at: resetsAt } }] }] }));
  const account: Account = { id: "claude:test", provider: "claude", name: "test", profileDir: profile,
    profileDirIsDefault: false, credentialEnv: [], kind: null };
  const env = buildAgentEnv(account, { ...process.env, HOME: scratch.home, RELAY_HOME: scratch.relayHome,
    RELAY_CLAUDE_BIN: FAKE_CLAUDE, RELAY_FAKE_SCENARIO: scenario, RELAY_FAKE_RECORD: join(root, "record.json"),
    RELAY_KEEP_FAKE_ENV: "1" }, { jobId: jobId(scratch), workerId: WORKER });
  const request: StartRequest = { jobId: jobId(scratch), workerId: WORKER, cwd: scratch.repo, mode: "interactive",
    instructions: "Follow the task.", permission: "edit-in-workspace", env, logPath: join(root, "worker.log") };
  const paths = { eventsPath: join(root, "events.jsonl"), infoPath: join(root, "info.json"),
    controlPath: join(root, "control.json"), resultPath: join(root, "result.json") };
  writeFileSync(join(root, "request.json"), JSON.stringify({ account, request, ...paths }));
  const child = Bun.spawn([process.execPath, DRIVER, join(root, "request.json")], {
    cwd: scratch.repo, env, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const workerEvents = (): WorkerEvent[] => existsSync(paths.eventsPath)
    ? readFileSync(paths.eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent) : [];
  try {
    await until(() => existsSync(paths.infoPath) && existsSync(join(root, "record.json")));
    child.stdin.write("Work.\n");
    await child.stdin.flush();
    await until(() => workerEvents().some((event) => event.kind === "turn_failed"), 10_000);
    return workerEvents();
  } finally {
    writeFileSync(paths.controlPath, JSON.stringify({ operation: "stop", timeoutMs: 100 }));
    child.stdin.end();
    const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!finished) child.kill("SIGKILL");
    await child.exited;
  }
}

const LIMIT: WorkerEvent = { kind: "turn_failed", reason: "rate_limit", message: "Claude Code stopped: rate_limit.", source: "hook" };

test("with a running daemon, the worker sees the limit the daemon wrote to the job's events.jsonl", async () => {
  const scratch = await setUpJob();
  cleanups.push(() => scratch.cleanup());
  const daemon = spawnDaemon(scratch.relayHome);
  cleanups.push(() => stopDaemon(daemon));
  await waitForDaemon(scratch.relayHome);
  expect(await limitInInteractiveWorker(scratch)).toContainEqual(LIMIT);
  expect(readSpool(scratch.relayHome)).toEqual([]);
  expect(events(scratch).filter((event) => event.type === "hook" && event.data.event === "StopFailure")).toMatchObject([
    { data: { provider: "claude", event: "StopFailure", error: "rate_limit", relay_worker: WORKER } },
  ]);
}, 30_000);

test("without a daemon, the worker sees the limit in the spool", async () => {
  const scratch = await setUpJob();
  cleanups.push(() => scratch.cleanup());
  expect(await limitInInteractiveWorker(scratch)).toContainEqual(LIMIT);
  expect(readSpool(scratch.relayHome).filter((line) => line.event === "StopFailure")).toMatchObject([
    { relay_worker: WORKER, fields: { error: "rate_limit" } },
  ]);
  expect(events(scratch).filter((event) => event.type === "hook")).toEqual([]);
}, 30_000);

test("a spool line that the daemon later writes to events.jsonl is handed out once", () => {
  const scratch = makeFolder();
  const eventsFile = join(scratch, "events.jsonl");
  writeFileSync(eventsFile, "");
  const feed = new HookFeed(scratch, eventsFile);
  const line = spoolLine("claude", "StopFailure", { session_id: "s", error: "rate_limit", tool_input: "x" }, { RELAY_WORKER: WORKER }, new Date());
  appendSpoolLine(scratch, line);
  expect(feed.fresh()).toEqual([line]);
  // The daemon drains the spool and appends the event to the job's log.
  rmSync(join(scratch, "spool", "hooks.jsonl"));
  const hookEvent = (id: number, data: Record<string, unknown>) =>
    `${JSON.stringify({ v: 1, id, ts: new Date().toISOString(), job: "3f9a2c1d", type: "hook", actor: "relay", data })}\n`;
  appendFileSync(eventsFile, hookEvent(1, { provider: "claude", event: "StopFailure", received_at: line.received_at, relay_worker: WORKER, worker_id: null, ...line.fields }));
  expect(feed.fresh()).toEqual([]);
  const later = new Date(Date.parse(line.received_at) + 1000).toISOString();
  appendFileSync(eventsFile, hookEvent(2, { provider: "claude", event: "Stop", received_at: later, relay_worker: WORKER, worker_id: WORKER, session_id: "s" }));
  expect(feed.fresh()).toMatchObject([{ event: "Stop", received_at: later, relay_worker: WORKER, relay_job: "3f9a2c1d", fields: { session_id: "s" } }]);
});

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "relay-feed-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
