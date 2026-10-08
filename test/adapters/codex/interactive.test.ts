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
import { codexTest, THREAD, until } from "./helpers/worker";

const PREVIOUS = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a32";

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
        expect(events()[0]).toEqual({ kind: "session_started", providerSessionId: THREAD, source: "hook" });
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
    expect(readRecord(fixture.record).argv).toEqual(["resume", PREVIOUS, "-C", fixture.root,
      "-c", 'developer_instructions="Follow the task."', "--", "First turn."]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events()[0]).toEqual({ kind: "session_started", providerSessionId: THREAD, source: "hook" });
  }, { hooks_trusted: true }, { resumeSessionId: PREVIOUS, instructions: "Follow\u202e the task.", prompt: "First\u200b turn." });
}, 10_000);

test("only the first fresh SessionStart for this worker identifies the session", async () => {
  await interactiveTest([{ hang: true }], async ({ fixture, child, events }) => {
    const line = (session: string, worker: string, time = new Date()) => spoolLine("codex", "SessionStart", { session_id: session }, { RELAY_WORKER: worker }, time);
    const [old, unrelated, first, later] = ["1", "2", "3", "4"].map((n) => `0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a3${n}`) as [string, string, string, string];
    appendSpoolLine(fixture.relayHome, line(old, fixture.request.workerId, new Date(Date.now() - 60_000)));
    appendSpoolLine(fixture.relayHome, line(unrelated, "abcd1234"));
    // Any program can write to the spool; an ID that is not a UUID must never become the session.
    appendSpoolLine(fixture.relayHome, line("--dangerously-bypass-approvals-and-sandbox", fixture.request.workerId));
    appendSpoolLine(fixture.relayHome, line(first, fixture.request.workerId));
    appendSpoolLine(fixture.relayHome, line(first, fixture.request.workerId));
    appendSpoolLine(fixture.relayHome, line(later, fixture.request.workerId));
    await until(() => events().some((event) => event.kind === "session_started"));
    expect(events().filter((event) => event.kind === "session_started")).toEqual([{ kind: "session_started", providerSessionId: first, source: "hook" }]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events().filter((event) => event.kind === "session_started")).toHaveLength(1);
  });
}, 10_000);

// The real codex resolves "--" the same way: `codex resume <id> -C /tmp -- --help extra` fails with
// "unexpected argument 'extra' found" instead of printing the help.
for (const prompt of ["--dangerously-bypass-approvals-and-sandbox", "-c", "exec"]) {
  test(`interactive start passes the prompt ${JSON.stringify(prompt)} after "--"`, async () => {
    await interactiveTest([{ say: "Done." }], async ({ fixture, child, events }) => {
      expect(readRecord(fixture.record).argv).toEqual(["-C", fixture.root, "-c", 'developer_instructions="Follow the task."', "--", prompt]);
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(events()).toContainEqual({ kind: "turn_completed" });
    }, { hooks_trusted: true }, { prompt });
  }, 10_000);
}

test("interactive resume refuses a session ID that is not a UUID", async () => {
  const fixture = codexTest();
  try {
    await expect(fixture.adapter.start(fixture.account, { ...fixture.request, mode: "interactive", resumeSessionId: "--last" }))
      .rejects.toThrow("The session ID to resume is not a UUID, so relay did not start the agent.");
    expect(fixture.hasRecord()).toBe(false);
  } finally { await fixture.cleanup(); }
});

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

test("hook mapper ignores other providers, other Codex events and session IDs that are not UUIDs", () => {
  const line = spoolLine("codex", "SessionStart", { session_id: THREAD }, {}, new Date());
  expect(codexHookEvents(line)).toEqual([{ kind: "session_started", providerSessionId: THREAD, source: "hook" }]);
  for (const session of ["", "session", "--dangerously-bypass-approvals-and-sandbox", `${THREAD} --last`, `-${THREAD}`]) {
    expect(codexHookEvents({ ...line, fields: { session_id: session } })).toEqual([]);
  }
  expect(codexHookEvents({ ...line, provider: "claude" })).toEqual([]);
  for (const event of ["SessionEnd", "Interrupt", "PreCompact"]) expect(codexHookEvents({ ...line, event })).toEqual([]);
  expect(noSessionMessage("test")).toBe("relay could not learn the Codex session ID because its hooks are not active. Run relay hooks status codex:test.");
});
