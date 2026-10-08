import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv } from "../../../../src/accounts/environment";
import { createCodexAdapter } from "../../../../src/adapters/codex/adapter";
import type { StartRequest, WorkerEvent, WorkerHandle } from "../../../../src/adapters/types";
import type { Account } from "../../../../src/core/config/types";
import { readRecord } from "../../../fakes/record";
import type { Scenario, Step } from "../../../fakes/scenario";
import { FAKE_CODEX } from "../../../helpers/fake-programs";

// The session ID the fake reports. Codex names sessions with UUIDs, and relay ignores any other ID.
export const THREAD = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31";

export async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for the worker.");
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}

export function codexTest(steps: Step[] = [{ say: "Done." }], scenario: Partial<Scenario> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-codex-worker-")));
  const home = join(root, "home");
  const relayHome = join(root, "relay");
  const profile = join(home, "profile");
  mkdirSync(profile, { recursive: true });
  const account: Account = { id: "codex:test", provider: "codex", name: "test", profileDir: profile,
    profileDirIsDefault: false, credentialEnv: [], kind: null };
  const scenarioPath = join(root, "scenario.json");
  const record = join(root, "record.json");
  writeFileSync(scenarioPath, JSON.stringify({ version: 1, session_id: THREAD, turns: [{ steps }], ...scenario }));
  const env = buildAgentEnv(account, { ...process.env, HOME: home, RELAY_HOME: relayHome,
    RELAY_CODEX_TRANSPORT: "app-server", RELAY_CODEX_BIN: FAKE_CODEX, RELAY_FAKE_SCENARIO: scenarioPath,
    RELAY_FAKE_RECORD: record, RELAY_KEEP_FAKE_ENV: "1" }, { jobId: "1234abcd", workerId: "5678abcd" });
  const request: StartRequest = { jobId: "1234abcd", workerId: "5678abcd", cwd: root, mode: "headless",
    instructions: "Follow the task.", prompt: "First turn.", permission: "edit-in-workspace", env, logPath: join(root, "worker.log") };
  const adapter = createCodexAdapter(env);
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
    messages: () => readRecord(record).input.map((line) => JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> }),
  };
}
