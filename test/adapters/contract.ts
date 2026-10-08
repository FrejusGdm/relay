import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { UnsupportedOperation } from "../../src/adapters/types";
import type { FailureReason, ProviderAdapter, ProviderId, Transport, WorkerEvent, WorkerHandle, StartRequest } from "../../src/adapters/types";
import type { Account } from "../../src/core/config/types";
import { buildAgentEnv } from "../../src/accounts/environment";
import { now } from "../../src/platform/clock";
import { readRecord, stdinKind } from "../fakes/record";
import type { Step } from "../fakes/scenario";
import { checkRequiredFixtures, checkTestedVersions, EXTRA_CODEX_FIXTURES, FIXTURES_ROOT, listFixtures, loadFixture, replayFixture } from "./fixtures";
import type { MapperFactory } from "./fixtures";

export type AdapterContractEntry = {
  provider: ProviderId;
  fakeProgram: string;
  createAdapter: () => ProviderAdapter;
  transports: { id: Transport; fixtureFolder?: string; mapper?: MapperFactory }[];
};
const SESSION = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31";
const reset = new Date(now().getTime() + 86_400_000);
reset.setUTCHours(15, 45, 0, 0);
const RESET = reset.toISOString();
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = now().getTime() + 5000;
  while (!predicate()) {
    if (now().getTime() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}
function contractTest(name: string, body: () => void | Promise<void>): void {
  test(name, body, 10_000);
}
export function defineAdapterContract(entry: AdapterContractEntry): void {
  describe(`${entry.provider} adapter contract`, () => {
    for (const transport of entry.transports) {
      const interactive = transport.id.endsWith("interactive");
      if (transport.fixtureFolder !== undefined) {
        const folder = isAbsolute(transport.fixtureFolder) ? transport.fixtureFolder
          : transport.fixtureFolder.startsWith("test/") ? resolve(transport.fixtureFolder)
          : transport.fixtureFolder.startsWith(`${entry.provider}/`) ? join(FIXTURES_ROOT, transport.fixtureFolder)
          : join(FIXTURES_ROOT, entry.provider, transport.fixtureFolder);
        const fixtureRoot = dirname(dirname(folder));
        const transportFolder = basename(folder);
        contractTest(`${transport.id} fixtures`, () => {
          expect(checkRequiredFixtures(fixtureRoot, entry.provider, transportFolder, transport.id === "codex-app-server" ? EXTRA_CODEX_FIXTURES : [])).toEqual([]);
          if (transport.mapper === undefined) throw new Error(`${transport.id} has a fixture folder but no event mapper.`);
          for (const path of listFixtures(fixtureRoot, entry.provider, transportFolder)) replayFixture(loadFixture(path), transport.mapper);
        });
        contractTest(`${transport.id}: recorded versions are tested`, () => {
          expect(checkTestedVersions(fixtureRoot, entry.provider, resolve(import.meta.dir, `../../src/adapters/${entry.provider}/tested-versions.json`))).toEqual([]);
        });
      }
      async function withWorker(steps: Step[], check: (context: {
        worker: WorkerHandle; events: WorkerEvent[]; record: string; adapter: ProviderAdapter; request: StartRequest; account: Account;
      }) => Promise<void>, changes: Partial<StartRequest> = {}): Promise<void> {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-contract-")));
        const scenario = join(root, "scenario.json");
        const record = join(root, "record.json");
        const home = join(root, "home");
        const profile = join(home, "profile");
        mkdirSync(profile, { recursive: true });
        const account: Account = { id: `${entry.provider}:test`, provider: entry.provider, name: "test", profileDir: profile, profileDirIsDefault: false, credentialEnv: [], kind: null };
        writeFileSync(scenario, JSON.stringify({ version: 1, session_id: SESSION, rate_limits: { primary: { used_percent: 62, window_minutes: 300, resets_at: RESET }, ordinary_usage_allowed: true }, turns: [{ steps }, { steps: [{ say: "Second turn." }] }] }));
        const overrides = { RELAY_CLAUDE_BIN: resolve(entry.fakeProgram), RELAY_CODEX_BIN: resolve(entry.fakeProgram), RELAY_CODEX_TRANSPORT: transport.id === "codex-exec" ? "exec" : "app-server" };
        const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
        Object.assign(process.env, overrides);
        const env = buildAgentEnv(account, {
          ...process.env, ...overrides, HOME: home, RELAY_HOME: join(root, "relay"), RELAY_KEEP_FAKE_ENV: "1",
          RELAY_FAKE_SCENARIO: scenario, RELAY_FAKE_RECORD: record, ANTHROPIC_API_KEY: "test", OPENAI_API_KEY: "test", CLAUDE_CODE_OAUTH_TOKEN: "test",
          CODEX_API_KEY: "test", CODEX_ACCESS_TOKEN: "test", CURSOR_API_KEY: "test", AWS_BEARER_TOKEN_BEDROCK: "test", TZ: "UTC",
        }, { jobId: "job-test", workerId: "worker-test" });
        const request: StartRequest = { jobId: "job-test", workerId: "worker-test", cwd: root, mode: interactive ? "interactive" : "headless", instructions: "Follow the task.", prompt: "First turn.", permission: "edit-in-workspace", env, logPath: join(root, "worker.log"), ...changes };
        let worker: WorkerHandle | undefined;
        let reading: Promise<void> | undefined;
        const events: WorkerEvent[] = [];
        try {
          const adapter = entry.createAdapter();
          worker = await adapter.start(account, request);
          reading = (async () => { for await (const event of worker!.events()) events.push(event); })();
          await until(() => existsSync(record), "the fake's startup record");
          expect(worker.transport).toBe(transport.id);
          await check({ worker, events, record, adapter, request, account });
        } finally {
          try { await worker?.stop({ timeoutMs: 500 }); await reading; }
          finally {
            for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
      contractTest(`${transport.id}: standard input, working directory and environment are correct`, async () => {
        await withWorker([{ say: "Ready." }, { hang: true }], async ({ record, request }) => {
          const start = readRecord(record);
          expect(start.cwd).toBe(request.cwd);
          expect(start.stdin).toBe(interactive ? stdinKind() : transport.id === "codex-exec" ? "eof" : "pipe");
          for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CURSOR_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]) {
            expect(start.env_names).not.toContain(name);
          }
          expect(start.env.RELAY_JOB).toBe(request.jobId);
          expect(start.env.RELAY_TARGET).toBe(`${entry.provider}:test`);
          expect(start.env[entry.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]).toBe(join(request.cwd, "home/profile"));
        });
      });
      contractTest(`${transport.id}: prompt and instructions lose invisible characters`, async () => {
        await withWorker([{ say: "Ready." }, { hang: true }], async ({ record }) => {
          await until(() => transport.id === "codex-exec" || interactive || (transport.id === "codex-app-server"
            ? readRecord(record).input.some((line) => line.includes('"method":"turn/start"'))
            : readRecord(record).input.length > 0), "the first input");
          const start = readRecord(record);
          const sent = JSON.stringify([...start.argv, ...start.input]);
          expect(sent).not.toContain("\u200b");
          expect(sent).not.toContain("\u202e");
          expect(sent).toContain("First turn.");
          expect(sent).toContain("Follow the task.");
        }, { prompt: "First\u200b turn.", instructions: "Follow\u202e the task." });
      });
      if (interactive) {
        contractTest(`${transport.id}: sending is refused and resume is native`, async () => {
          await withWorker([{ say: "Ready." }, { hang: true }], async ({ worker, adapter, record }) => {
            expect(adapter.capabilities(transport.id).streamingInput).toBe(false);
            expect(adapter.capabilities(transport.id).cleanInterrupt).toBe(false);
            expect(adapter.capabilities(transport.id).nativeResume).toBe(true);
            await expect(worker.send("Another message.")).rejects.toBeInstanceOf(UnsupportedOperation);
            const start = readRecord(record);
            expect(start.argv).toContain(entry.provider === "claude" ? "--resume" : "resume");
            expect(start.argv).toContain(SESSION);
          }, { resumeSessionId: SESSION });
        });
        continue;
      }
      contractTest(`${transport.id}: session ID is first`, async () => {
        await withWorker([{ say: "Ready." }], async ({ events }) => {
          await until(() => events.some((e) => e.kind === "turn_completed"), "turn completion");
          expect(events[0]?.kind).toBe("session_started");
          const first = events[0];
          if (first?.kind === "session_started") expect(first.providerSessionId).toBe(SESSION);
        });
      });
      for (const [label, step, reason] of [
        ["usage limit", { limit: { window: "primary", resets_at: RESET } }, "usage_limit"],
        ["authentication failure", { error: "authentication_failed" }, transport.id === "codex-exec" ? "other" : "auth"],
        ["rate limit", { limit: { window: "primary", resets_at: RESET, kind: "rate" } }, transport.id === "codex-exec" ? "other" : "rate_limit"],
        ["overload", { error: "overloaded" }, transport.id === "codex-exec" ? "other" : "overloaded"],
        ["billing failure", { error: "billing_error" }, transport.id === "claude-print" ? "billing" : "other"],
        ["other failure", { error: "server_error" }, "other"],
        ["crash", { exit: 3 }, "crashed"],
      ] as [string, Step, FailureReason][]) {
        contractTest(`${transport.id}: ${label} has the right reason and reset time`, async () => {
          await withWorker([step], async ({ events, adapter }) => {
            await until(() => events.some((e) => e.kind === "turn_failed"), "turn failure");
            const failure = events.find((e): e is Extract<WorkerEvent, { kind: "turn_failed" }> => e.kind === "turn_failed");
            expect(failure?.reason).toBe(reason);
            if (reason === "usage_limit") expect(failure?.retryAt?.toISOString()).toBe(RESET);
            else expect(failure?.retryAt).toBeUndefined();
            const caps = adapter.capabilities(transport.id);
            if (reason === "usage_limit") expect(failure?.source).toBe(caps.limitSignalOnHit === "text" ? "message_text" : transport.id === "codex-app-server" ? "provider_api" : "stream_event");
          });
        });
      }
      contractTest(`${transport.id}: unknown and broken lines are tolerated`, async () => {
        await withWorker([{ raw: "{broken" }, { raw: '{"type":"unknown","method":"unknown","params":{}}' }, { say: "Still working." }], async ({ events }) => {
          await until(() => events.some((e) => e.kind === "turn_completed"), "turn completion after broken lines");
          expect(events.some((e) => e.kind === "message" && e.text === "Still working.")).toBe(true);
          expect(events.some((e) => e.kind === "turn_failed")).toBe(false);
        });
      });
      contractTest(`${transport.id}: interrupt ends the turn and keeps the process`, async () => {
        await withWorker([{ say: "Ready." }, { hang: true }], async ({ worker, events, adapter }) => {
          await until(() => events.some((e) => e.kind === "message"), "a running turn");
          const pid = worker.pid;
          await worker.interrupt();
          await until(() => events.some((e) => e.kind === "turn_failed" && e.reason === "interrupted"), "the interrupted event");
          // A transport without streaming input, such as codex exec, ends its process with the
          // turn; only one that takes further messages must keep running.
          const caps = adapter.capabilities(transport.id);
          if (caps.cleanInterrupt && caps.streamingInput) {
            expect(events.some((e) => e.kind === "exited")).toBe(false);
            expect(worker.pid).toBe(pid);
            expect(pid).not.toBeNull();
            if (pid !== null) expect(() => process.kill(pid, 0)).not.toThrow();
            await worker.send("Second turn.");
            await until(() => events.some((e) => e.kind === "turn_completed"), "a second turn in the same process");
          } else {
            await worker.wait();
          }
        });
      });
      contractTest(`${transport.id}: send matches streamingInput`, async () => {
        await withWorker([{ say: "Ready." }, { hang: true }], async ({ worker, adapter, record, events }) => {
          await until(() => events.some((e) => e.kind === "message"), "a running turn");
          if (adapter.capabilities(transport.id).streamingInput) {
            await worker.send("Second\u200b message.");
            await until(() => readRecord(record).input.some((line) => line.includes("Second message.")), "the sent message");
            expect(readRecord(record).input.join("\n")).not.toContain("\u200b");
          } else {
            let refusal: unknown;
            try { await worker.send("Second message."); } catch (error) { refusal = error; }
            expect(refusal).toBeInstanceOf(UnsupportedOperation);
            expect((refusal as Error).message).toMatch(new RegExp(`^${adapter.displayName} in [a-z -]+ mode cannot .+\\.$`));
          }
        });
      });
      contractTest(`${transport.id}: resume matches nativeResume`, async () => {
        if (!entry.createAdapter().capabilities(transport.id).nativeResume) {
          await expect(withWorker([{ say: "Resumed." }], async () => {
            throw new Error("The adapter resumed despite declaring nativeResume false.");
          }, { resumeSessionId: SESSION })).rejects.toBeInstanceOf(UnsupportedOperation);
          return;
        }
        await withWorker([{ say: "Resumed." }], async ({ record, events }) => {
          await until(() => events.some((e) => e.kind === "turn_completed"), "the resumed turn");
          const session = events.find((e) => e.kind === "session_started");
          expect(session?.providerSessionId).toBe(SESSION);
          const start = readRecord(record);
          expect(JSON.stringify([...start.argv, ...start.input])).toContain(SESSION);
          if (transport.id === "codex-app-server") expect(start.input.some((line) => line.includes('"method":"thread/resume"'))).toBe(true);
          else expect(start.argv).toContain(transport.id === "claude-print" ? "--resume" : "resume");
        }, { resumeSessionId: SESSION });
      });
      contractTest(`${transport.id}: declared capacity readings are available`, async () => {
        if (!entry.createAdapter().capabilities(transport.id).limitPercentBeforeHit) return;
        await withWorker([{ say: "Ready." }, { hang: true }], async ({ adapter, account, request }) => {
          const reading = await adapter.availability(account, request.env);
          expect(reading.state).toBe("available");
          expect(reading.source).toBe("provider_api");
          const window = reading.windows.find((value) => value.name === "five_hour");
          expect(window?.usedPercent).toBe(62);
          expect(window?.windowMinutes).toBe(300);
          expect(window?.resetsAt?.toISOString()).toBe(RESET);
        });
      });
      contractTest(`${transport.id}: declared capabilities match the transport`, () => {
        const adapter = entry.createAdapter();
        const caps = adapter.capabilities(transport.id);
        expect(caps.limitSignalOnHit).toBe(transport.id === "codex-exec" ? "text" : "structured");
        expect(caps.streamingInput).toBe(transport.id !== "codex-exec");
        expect(typeof caps.cleanInterrupt).toBe("boolean");
        expect(caps.nativeResume).toBe(true);
        expect(caps.limitPercentBeforeHit).toBe(transport.id === "codex-app-server");
        expect(caps.observesExternalSessions).toBe("hooks");
        const hooks = adapter.hookSpec();
        expect(hooks.events).toContain("SessionStart");
        expect(hooks.events).toContain("Stop");
        expect(hooks.events).toContain("SessionEnd");
      });
    }
  });
}
