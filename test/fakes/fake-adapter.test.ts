import { afterEach, beforeEach, expect, test } from "bun:test";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterRegistry } from "../../src/adapters/registry";
import { UnsupportedOperation } from "../../src/adapters/types";
import { setClock } from "../../src/platform/clock";
import type { StartRequest, WorkerEvent, WorkerHandle } from "../../src/adapters/types";
import type { Account } from "../../src/core/config/types";
import { createFakeAdapter } from "./fake-adapter";
import type { Scenario } from "./scenario";

const calls: string[] = [];
const restore: (() => void)[] = [];

function block<T extends object, K extends keyof T>(object: T, key: K): void {
  const original = object[key];
  object[key] = ((..._args: unknown[]) => {
    calls.push(String(key));
    throw new Error(`The fake adapter tried to call ${String(key)}.`);
  }) as unknown as T[K];
  restore.push(() => { object[key] = original; });
}

beforeEach(() => {
  calls.length = 0;
  block(Bun, "spawn");
  block(Bun, "spawnSync");
  for (const key of ["spawn", "spawnSync", "exec", "execFile", "fork"] as const) block(childProcess, key);
});

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  expect(calls).toEqual([]);
});

function inputs(provider: "claude" | "codex" = "claude"): { account: Account; req: StartRequest } {
  const cwd = mkdtempSync(join(process.env.HOME!, "fake-adapter-"));
  return {
    account: { id: `${provider}:work`, provider, name: "work", profileDir: cwd, profileDirIsDefault: false, credentialEnv: [], kind: null },
    req: { jobId: "job", workerId: "worker", cwd, mode: "headless", instructions: "Finish the task.", prompt: "Start.",
      permission: "edit-in-workspace", env: {}, logPath: join(cwd, "worker.log") },
  };
}

async function collect(handle: WorkerHandle, onEvent?: (event: WorkerEvent) => Promise<void>): Promise<WorkerEvent[]> {
  const result: WorkerEvent[] = [];
  for await (const event of handle.events()) {
    result.push(event);
    await onEvent?.(event);
  }
  return result;
}

const reset = "2026-10-07T15:45:00Z";
const limitScenario: Scenario = { version: 1, turns: [{ steps: [{ say: "Working." }, { limit: { window: "five_hour", resets_at: reset } }] }] };

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} emits the scenario limit without starting a process`, async () => {
    const { account, req } = inputs(provider);
    const registry = createAdapterRegistry({ [provider]: createFakeAdapter({ provider, scenario: limitScenario }) });
    const handle = await registry.get(provider).start(account, req);
    try {
      const events = await collect(handle);
      expect(events.map((event) => event.kind)).toEqual(["session_started", "message", "limit_update", "turn_failed", "exited"]);
      expect(events.find((event) => event.kind === "turn_failed")).toEqual({ kind: "turn_failed", reason: "usage_limit",
        retryAt: new Date(reset), source: provider === "claude" ? "stream_event" : "provider_api",
        message: provider === "claude" ? "You've hit your session limit." : "You’ve hit your usage limit." });
      expect(handle.pid).toBeNull();
      if (provider === "codex") expect(handle.presetSessionId).toBeUndefined();
      expect(calls).toEqual([]);
    } finally { await handle.stop(); }
  }, 2000);
}

test("availability becomes unknown after the recorded reset", async () => {
  const { account, req } = inputs();
  let now = new Date("2026-10-07T15:44:00Z");
  const adapter = createFakeAdapter({ provider: "claude", scenario: limitScenario, clock: () => now });
  expect(await adapter.availability(account, {})).toMatchObject({ state: "unknown", source: "none", windows: [] });
  const handle = await adapter.start(account, req);
  try {
    await collect(handle);
    expect(await adapter.availability(account, {})).toMatchObject({ state: "quota_exhausted", retryAt: new Date(reset) });
    now = new Date("2026-10-07T15:46:00Z");
    const reading = await adapter.availability(account, {});
    expect(reading.state).toBe("unknown");
    expect(reading.detail).toBe("The reset time has passed; relay has not measured since.");
    expect(reading.retryAt).toBeUndefined();
    expect(reading.windows).toHaveLength(1);
  } finally { await handle.stop(); }
}, 2000);

test("without an injected clock the fake adapter reads relay's clock", async () => {
  const { account, req } = inputs();
  const adapter = createFakeAdapter({ provider: "claude", scenario: limitScenario });
  setClock(() => new Date("2026-10-07T15:44:00Z"));
  try {
    const handle = await adapter.start(account, req);
    await collect(handle);
    expect((await adapter.availability(account, {})).state).toBe("quota_exhausted");
    setClock(() => new Date("2026-10-07T15:46:00Z"));
    expect((await adapter.availability(account, {})).state).toBe("unknown");
  } finally { setClock(null); }
}, 2000);

test("initial provider rate limits use the window duration", async () => {
  const { account } = inputs("codex");
  const adapter = createFakeAdapter({ provider: "codex", scenario: { version: 1, turns: [], rate_limits: {
    ordinary_usage_allowed: true, primary: { used_percent: 62, window_minutes: 300, resets_at: reset },
  } } });
  const reading = await adapter.availability(account, {});
  expect(reading.state).toBe("available");
  expect(reading.windows).toEqual([{ name: "five_hour", windowMinutes: 300, usedPercent: 62, resetsAt: new Date(reset), source: "provider_api" }]);
});

test("write steps create files and report both tool events", async () => {
  const { account, req } = inputs();
  const content = "export const a = 1;\n";
  const adapter = createFakeAdapter({ provider: "claude", scenario: { version: 1, turns: [{ steps: [{ write: "src/a.ts", content }] }] } });
  const handle = await adapter.start(account, req);
  try {
    const events = await collect(handle);
    expect(readFileSync(join(req.cwd, "src/a.ts"), "utf8")).toBe(content);
    expect(events.filter((event) => event.kind === "tool")).toEqual([
      { kind: "tool", toolId: "tool_1", name: "Write", status: "started", paths: ["src/a.ts"] },
      { kind: "tool", toolId: "tool_1", name: "Write", status: "completed", paths: ["src/a.ts"] },
    ]);
  } finally { await handle.stop(); }
}, 2000);

test("send queues a second turn after the first turn completes", async () => {
  const { account, req } = inputs();
  const adapter = createFakeAdapter({ provider: "claude", scenario: { version: 1, turns: [
    { steps: [{ say: "First." }, { run: "true", delay_ms: 10 }] }, { steps: [{ say: "Second." }] },
  ] } });
  const handle = await adapter.start(account, req);
  try {
    await handle.send("Continue.");
    const events = await collect(handle);
    const firstCompleted = events.findIndex((event) => event.kind === "turn_completed");
    const secondMessage = events.findIndex((event) => event.kind === "message" && event.text === "Second.");
    expect(firstCompleted).toBeGreaterThanOrEqual(0);
    expect(secondMessage).toBeGreaterThan(firstCompleted);
    expect(events.filter((event) => event.kind === "turn_completed")).toHaveLength(2);
  } finally { await handle.stop(); }
}, 2000);

test("interactive Claude refuses send with UnsupportedOperation", async () => {
  const { account, req } = inputs();
  const handle = await createFakeAdapter({ provider: "claude" }).start(account, { ...req, mode: "interactive", prompt: undefined });
  try {
    let error: unknown;
    try { await handle.send("Continue."); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(UnsupportedOperation);
    expect((error as Error).message).toBe("Claude Code in claude interactive mode cannot receive a message while it runs.");
  } finally { await handle.stop(); }
}, 2000);

test("interrupt ends a hanging headless turn and stop sees its exit", async () => {
  const { account, req } = inputs();
  const handle = await createFakeAdapter({ provider: "claude", scenario: { version: 1, turns: [{ steps: [{ say: "Waiting." }, { hang: true }] }] } }).start(account, req);
  try {
    const events = await collect(handle, async (event) => { if (event.kind === "message") await handle.interrupt(); });
    expect(events.find((event) => event.kind === "turn_failed")).toEqual({ kind: "turn_failed", reason: "interrupted", message: "The turn was interrupted.", source: "none" });
    expect(await handle.wait()).toEqual({ code: 1, signal: null });
    expect(await handle.stop()).toEqual({ how: "already_exited", exitCode: 1, signal: null, turnEnded: true });
  } finally { await handle.stop(); }
}, 2000);

test("headless stop interrupts a turn and exits cleanly", async () => {
  const { account, req } = inputs();
  const handle = await createFakeAdapter({ provider: "codex", scenario: { version: 1, turns: [{ steps: [{ say: "Waiting." }, { hang: true }] }] } }).start(account, req);
  try {
    const events = await collect(handle, async (event) => {
      if (event.kind === "message") expect(await handle.stop()).toEqual({ how: "clean", exitCode: 0, signal: null, turnEnded: true });
    });
    expect(events.map((event) => event.kind)).toEqual(["session_started", "message", "turn_failed", "exited"]);
    expect(await handle.wait()).toEqual({ code: 0, signal: null });
  } finally { await handle.stop(); }
}, 2000);

test("interactive stop reports that an idle turn has ended", async () => {
  const { account, req } = inputs();
  const handle = await createFakeAdapter({ provider: "claude" }).start(account, { ...req, mode: "interactive" });
  try {
    const events = await collect(handle, async (event) => {
      if (event.kind === "turn_completed") expect(await handle.stop()).toEqual({ how: "terminated", exitCode: 143, signal: null, turnEnded: true });
    });
    expect(events.map((event) => event.kind)).toEqual(["session_started", "message", "turn_completed", "exited"]);
  } finally { await handle.stop(); }
}, 2000);

for (const ignore of [false, true]) {
  test(`interactive stop ${ignore ? "kills a worker ignoring SIGTERM" : "terminates the worker"}`, async () => {
    const { account, req } = inputs();
    const scenario: Scenario = { version: 1, turns: [{ steps: [...(ignore ? [{ ignore_sigterm: true } as const] : []), { say: "Waiting." }, { hang: true }] }] };
    const handle = await createFakeAdapter({ provider: "claude", scenario }).start(account, { ...req, mode: "interactive" });
    try {
      const events = await collect(handle, async (event) => {
        if (event.kind === "message") expect(await handle.stop()).toEqual(ignore
          ? { how: "killed", exitCode: null, signal: "SIGKILL", turnEnded: false }
          : { how: "terminated", exitCode: 143, signal: null, turnEnded: false });
      });
      expect(events.map((event) => event.kind)).toEqual(["session_started", "message", "turn_failed", "exited"]);
      expect(await handle.wait()).toEqual(ignore ? { code: null, signal: "SIGKILL" } : { code: 143, signal: null });
    } finally { await handle.stop(); }
  }, 2000);
}

test("capabilities retain transport-specific signals and input", () => {
  const adapter = createFakeAdapter({ provider: "codex" });
  expect(adapter.capabilities("codex-exec").limitSignalOnHit).toBe("text");
  expect(adapter.capabilities("claude-print").streamingInput).toBe(true);
});

test("a limit reached on one account does not change another account's availability", async () => {
  const { account, req } = inputs();
  const adapter = createFakeAdapter({ provider: "claude", scenario: limitScenario, clock: () => new Date("2026-10-07T15:00:00Z") });
  await collect(await adapter.start(account, req));
  expect((await adapter.availability(account, {})).state).toBe("quota_exhausted");
  const personal = { ...account, id: "claude:personal" as const, name: "personal" };
  expect(await adapter.availability(personal, {})).toMatchObject({ account: "claude:personal", state: "unknown", source: "none" });
});

test("an exhausted window from the scenario's rate limits expires at its reset", async () => {
  const { account } = inputs("codex");
  let time = new Date("2026-10-07T15:00:00Z");
  const adapter = createFakeAdapter({ provider: "codex", clock: () => time, scenario: { version: 1, turns: [], rate_limits: {
    ordinary_usage_allowed: false, primary: { used_percent: 100, window_minutes: 300, resets_at: reset },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: "2026-10-12T16:00:00Z" },
  } } });
  expect(await adapter.availability(account, {})).toMatchObject({ state: "quota_exhausted", retryAt: new Date(reset) });
  time = new Date("2026-10-07T15:46:00Z");
  expect((await adapter.availability(account, {})).state).toBe("unknown");
});

for (const trusted of [true, false]) {
  test(`interactive Codex ${trusted ? "names" : "does not name"} its session when its hooks are ${trusted ? "" : "not "}trusted`, async () => {
    const { account, req } = inputs("codex");
    const scenario: Scenario = { version: 1, hooks_trusted: trusted, turns: [] };
    const handle = await createFakeAdapter({ provider: "codex", scenario }).start(account, { ...req, mode: "interactive", prompt: undefined });
    await Bun.sleep(20);
    const result = await handle.stop();
    expect(result.how).toBe("terminated");
    const events = await collect(handle);
    expect(events.some((event) => event.kind === "session_started")).toBe(trusted);
  }, 2000);
}
