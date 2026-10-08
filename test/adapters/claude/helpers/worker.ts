import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv } from "../../../../src/accounts/environment";
import { createClaudeAdapter } from "../../../../src/adapters/claude/adapter";
import type { StartRequest, WorkerEvent, WorkerHandle } from "../../../../src/adapters/types";
import type { Account } from "../../../../src/core/config/types";
import { FAKE_CLAUDE } from "../../../helpers/fake-programs";
import type { Scenario, Step } from "../../../fakes/scenario";

export async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for the worker.");
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}

export function claudeTest(steps: Step[] = [{ say: "Done." }], scenario: Partial<Scenario> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-claude-worker-")));
  const home = join(root, "home");
  const relayHome = join(root, "relay");
  const profile = join(home, "profile");
  mkdirSync(profile, { recursive: true });
  const account: Account = { id: "claude:test", provider: "claude", name: "test", profileDir: profile,
    profileDirIsDefault: false, credentialEnv: [], kind: null };
  const scenarioPath = join(root, "scenario.json");
  const record = join(root, "record.json");
  writeFileSync(scenarioPath, JSON.stringify({ version: 1, turns: [{ steps }], ...scenario }));
  const env = buildAgentEnv(account, { ...process.env, HOME: home, RELAY_HOME: relayHome,
    RELAY_CLAUDE_BIN: FAKE_CLAUDE, RELAY_FAKE_SCENARIO: scenarioPath,
    RELAY_FAKE_RECORD: record, RELAY_KEEP_FAKE_ENV: "1" }, { jobId: "1234abcd", workerId: "5678abcd" });
  const request: StartRequest = { jobId: "1234abcd", workerId: "5678abcd", cwd: root, mode: "headless",
    instructions: "Follow the task.", prompt: "First turn.", permission: "edit-in-workspace", env,
    logPath: join(root, "worker.log") };
  const adapter = createClaudeAdapter(env);
  const events: WorkerEvent[] = [];
  let worker: WorkerHandle | undefined;
  let reading: Promise<void> | undefined;
  function collect(handle: WorkerHandle) {
    worker = handle;
    reading = (async () => { for await (const event of handle.events()) events.push(event); })();
    return handle;
  }
  return { root, relayHome, profile, account, request, record, env, adapter, events, collect,
    async start(changes: Partial<StartRequest> = {}) { return collect(await adapter.start(account, { ...request, ...changes })); },
    async finished() { await worker?.wait(); await reading; },
    async cleanup() {
      try { await worker?.stop({ timeoutMs: 100 }); await reading; }
      finally { rmSync(root, { recursive: true, force: true }); }
    },
    hasRecord: () => existsSync(record),
  };
}
