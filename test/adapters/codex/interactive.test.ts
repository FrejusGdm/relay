import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StartRequest, WorkerEvent } from "../../../src/adapters/types";
import { codexHookEvents, noSessionMessage } from "../../../src/adapters/codex/hooks";
import { spoolLine } from "../../../src/hooks/fields";
import { appendSpoolLine, readSpool } from "../../../src/hooks/spool";
import { readRecord } from "../../fakes/record";
import type { Scenario, Step } from "../../fakes/scenario";
import { relayBin } from "../../helpers/relay-bin";
import { codexTest, until } from "./helpers/worker";

async function interactiveTest(steps: Step[], check: (context: {
  fixture: ReturnType<typeof codexTest>;
  child: Bun.Subprocess<"pipe", "ignore", "pipe">;
  events: () => WorkerEvent[];
  info: { transport: string; presetSessionId: string | null; sendError: string };
  control: (operation: "stop" | "interrupt", timeoutMs?: number) => void;
  result: () => { how: string; exitCode: number | null; signal: string | null };
}) => Promise<void>, scenario: Partial<Scenario> = {}, changes: Partial<StartRequest> = {}): Promise<void> {
  const fixture = codexTest(steps, scenario);
  const bin = relayBin();
  const eventsPath = join(fixture.root, "events.jsonl");
  const infoPath = join(fixture.root, "info.json");
  const controlPath = join(fixture.root, "control.json");
  const resultPath = join(fixture.root, "result.json");
  const hooks = Object.fromEntries(["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"].map((event) => [event,
    [{ hooks: [{ type: "command", command: `'${bin}' hook codex ${event}`, timeout: ["SessionEnd", "Interrupt"].includes(event) ? 3 : 5 }] }],
  ]));
  writeFileSync(join(fixture.profile, "hooks.json"), JSON.stringify({ hooks }));
  const requestPath = join(fixture.root, "request.json");
  writeFileSync(requestPath, JSON.stringify({ account: fixture.account,
    request: { ...fixture.request, mode: "interactive", prompt: undefined, ...changes }, eventsPath, infoPath, controlPath, resultPath }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "helpers/interactive-driver.ts"), requestPath], {
    cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const events = (): WorkerEvent[] => existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent) : [];
  try {
    await until(() => existsSync(infoPath) && fixture.hasRecord());
    const info = JSON.parse(readFileSync(infoPath, "utf8")) as { transport: string; presetSessionId: string | null; sendError: string };
    await check({ fixture, child, events, info,
      control: (operation, timeoutMs) => writeFileSync(controlPath, JSON.stringify({ operation, timeoutMs })),
      result: () => JSON.parse(readFileSync(resultPath, "utf8")),
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      writeFileSync(controlPath, JSON.stringify({ operation: "stop", timeoutMs: 100 }));
      child.stdin.end();
      const finished = await Promise.race([child.exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 2000))]);
      if (!finished) child.kill("SIGKILL");
    }
    await child.exited;
    const stderr = await errors;
    await fixture.cleanup();
    rmSync(dirname(bin), { recursive: true, force: true });
    expect(stderr).toBe("");
  }
}

for (const trusted of [true, false]) {
  test(`interactive hooks ${trusted ? "trusted" : "untrusted"} ${trusted ? "identify the session" : "leave it unknown"}`, async () => {
    await interactiveTest([{ say: "Done." }], async ({ fixture, child, events, info }) => {
      expect(info).toEqual({ transport: "codex-interactive", presetSessionId: null, sendError: "Codex in interactive mode cannot receive a message while it runs." });
      expect(readRecord(fixture.record)).toMatchObject({ stdin: "pipe", argv: ["-C", fixture.root, "-c", 'developer_instructions="Follow the task."'] });
      child.stdin.write("Work.\n"); await child.stdin.flush(); child.stdin.end();
      expect(await child.exited).toBe(0);
      if (trusted) {
        expect(events()[0]).toEqual({ kind: "session_started", providerSessionId: "thread_test", source: "hook" });
        expect(events()).toContainEqual({ kind: "turn_completed" });
        expect(readSpool(fixture.relayHome).find((line) => line.event === "SessionStart")?.relay_worker).toBe(fixture.request.workerId);
      } else {
        expect(events()).toEqual([{ kind: "exited", code: 0, signal: null }]);
      }
    }, { hooks_trusted: trusted });
  }, 10_000);
}

test("interactive resume passes settings and cleaned prompt without permission flags", async () => {
  await interactiveTest([{ say: "Done." }], async ({ fixture, child, events }) => {
    expect(readRecord(fixture.record).argv).toEqual(["resume", "previous_thread", "-C", fixture.root,
      "-c", 'developer_instructions="Follow the task."', "First turn."]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events()[0]).toEqual({ kind: "session_started", providerSessionId: "thread_test", source: "hook" });
  }, { hooks_trusted: true }, { resumeSessionId: "previous_thread", instructions: "Follow\u202e the task.", prompt: "First\u200b turn." });
}, 10_000);

test("only the first fresh SessionStart for this worker identifies the session", async () => {
  await interactiveTest([{ hang: true }], async ({ fixture, child, events }) => {
    const line = (session: string, worker: string, time = new Date()) => spoolLine("codex", "SessionStart", { session_id: session }, { RELAY_WORKER: worker }, time);
    appendSpoolLine(fixture.relayHome, line("old", fixture.request.workerId, new Date(Date.now() - 60_000)));
    appendSpoolLine(fixture.relayHome, line("unrelated", "abcd1234"));
    const first = line("first_session", fixture.request.workerId);
    appendSpoolLine(fixture.relayHome, first);
    appendSpoolLine(fixture.relayHome, first);
    appendSpoolLine(fixture.relayHome, line("later_session", fixture.request.workerId));
    await until(() => events().some((event) => event.kind === "session_started"));
    expect(events().filter((event) => event.kind === "session_started")).toEqual([{ kind: "session_started", providerSessionId: "first_session", source: "hook" }]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events().filter((event) => event.kind === "session_started")).toHaveLength(1);
  });
}, 10_000);

for (const ignoreTerm of [false, true]) {
  test(`interactive stop ${ignoreTerm ? "kills a worker that ignores SIGTERM" : "terminates the held worker"}`, async () => {
    await interactiveTest([...(ignoreTerm ? [{ ignore_sigterm: true } as const] : []), { write: "ready", content: "ready" }, { hang: true }],
      async ({ fixture, child, control, result }) => {
        child.stdin.write("Work.\n"); await child.stdin.flush();
        await until(() => existsSync(join(fixture.root, "ready")));
        control("stop", 100);
        expect(await child.exited).toBe(0);
        expect(result().how).toBe(ignoreTerm ? "killed" : "terminated");
      });
  }, 10_000);
}

test("hook mapper ignores other providers and other Codex events", () => {
  const line = spoolLine("codex", "SessionStart", { session_id: "session" }, {}, new Date());
  expect(codexHookEvents(line)).toEqual([{ kind: "session_started", providerSessionId: "session", source: "hook" }]);
  expect(codexHookEvents({ ...line, provider: "claude" })).toEqual([]);
  for (const event of ["SessionEnd", "Interrupt", "PreCompact"]) expect(codexHookEvents({ ...line, event })).toEqual([]);
  expect(noSessionMessage("test")).toBe("relay could not learn the Codex session ID because its hooks are not active. Run relay hooks status codex:test.");
});
