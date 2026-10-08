import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StartRequest, WorkerEvent } from "../../../src/adapters/types";
import { appendSpoolLine, readSpool } from "../../../src/hooks/spool";
import { spoolLine } from "../../../src/hooks/fields";
import { readRecord } from "../../fakes/record";
import type { Scenario, Step } from "../../fakes/scenario";
import { relayBin } from "../../helpers/relay-bin";
import { claudeTest, until } from "./helpers/worker";

async function interactiveTest(steps: Step[], check: (context: {
  fixture: ReturnType<typeof claudeTest>;
  child: Bun.Subprocess<"pipe", "ignore", "pipe">;
  events: () => WorkerEvent[];
  info: { presetSessionId: string; sendError: string };
  control: (operation: "stop" | "interrupt", timeoutMs?: number) => void;
  result: () => { how: string; exitCode: number | null; signal: string | null };
}) => Promise<void>, scenario: Partial<Scenario> = {}, resumeSessionId?: string, changes: Partial<StartRequest> = {}): Promise<void> {
  const fixture = claudeTest(steps, scenario);
  const bin = relayBin();
  const eventsPath = join(fixture.root, "events.jsonl");
  const infoPath = join(fixture.root, "info.json");
  const controlPath = join(fixture.root, "control.json");
  const resultPath = join(fixture.root, "result.json");
  const hooks = Object.fromEntries(["StopFailure", "Stop", "Notification", "SessionStart"].map((event) => [event,
    [{ hooks: [{ type: "command", command: `'${bin}' hook claude ${event}`, timeout: 5 }] }],
  ]));
  writeFileSync(join(fixture.profile, "settings.json"), JSON.stringify({ hooks }));
  const requestPath = join(fixture.root, "request.json");
  writeFileSync(requestPath, JSON.stringify({ account: fixture.account,
    request: { ...fixture.request, mode: "interactive", prompt: undefined, resumeSessionId, ...changes }, eventsPath, infoPath, controlPath, resultPath }));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "helpers/interactive-driver.ts"), requestPath], {
    cwd: fixture.root, env: fixture.env, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const events = (): WorkerEvent[] => existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent) : [];
  try {
    await until(() => existsSync(infoPath) && fixture.hasRecord());
    const info = JSON.parse(readFileSync(infoPath, "utf8")) as { presetSessionId: string; sendError: string };
    await until(() => events().length > 0);
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

test("interactive inherits input, uses a preset ID and reports normal turns from hooks", async () => {
  await interactiveTest([{ say: "Done." }], async ({ fixture, child, events, info }) => {
    const record = readRecord(fixture.record);
    expect(record.stdin).toBe("pipe");
    expect(record.argv).toEqual(["--session-id", info.presetSessionId, "--append-system-prompt", "Follow the task."]);
    expect(events()[0]).toEqual({ kind: "session_started", providerSessionId: info.presetSessionId, source: "preset" });
    expect(info.sendError).toBe("Claude Code in interactive mode cannot receive a message while it runs.");
    child.stdin.write("The person’s prompt.\n");
    await child.stdin.flush();
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events()).toContainEqual({ kind: "turn_completed" });
    expect(events().at(-1)).toEqual({ kind: "exited", code: 0, signal: null });
    expect(readRecord(fixture.record).input).toEqual(["The person’s prompt."]);
  });
}, 10_000);

test("a limit is observed from the hook spool and folded into availability", async () => {
  await interactiveTest([{ limit: { window: "primary", resets_at: new Date(Date.now() + 86_400_000).toISOString() } }],
    async ({ fixture, child, events }) => {
      child.stdin.write("Work.\n");
      await child.stdin.flush();
      await until(() => events().some((event) => event.kind === "turn_failed"));
      expect(events()).toContainEqual({ kind: "turn_failed", reason: "rate_limit", message: "Claude Code stopped: rate_limit.", source: "hook" });
      expect(await fixture.adapter.availability(fixture.account, fixture.env)).toMatchObject({ state: "rate_limited", source: "hook" });
      child.stdin.end();
      expect(await child.exited).toBe(0);
    });
}, 10_000);

for (const ignoreTerm of [false, true]) {
  test(`interactive stop reports ${ignoreTerm ? "killed" : "terminated"}`, async () => {
    await interactiveTest([...(ignoreTerm ? [{ ignore_sigterm: true } as const] : []), { notification: "ready" }, { hang: true }],
      async ({ fixture, child, control, result }) => {
        child.stdin.write("Work.\n");
        await child.stdin.flush();
        await until(() => readSpool(fixture.relayHome).some((line) => line.fields.notification_type === "ready"));
        control("stop", 100);
        expect(await child.exited).toBe(0);
        expect(result()).toMatchObject(ignoreTerm
          ? { how: "killed", signal: "SIGKILL", turnEnded: false }
          : { how: "terminated", exitCode: 143, signal: null, turnEnded: false });
      });
  }, 10_000);
}

test("interactive resume keeps its ID and accepts matching session hooks only once", async () => {
  const session = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
  await interactiveTest([{ hang: true }], async ({ fixture, child, events, info }) => {
    expect(info.presetSessionId).toBe(session);
    expect(readRecord(fixture.record).argv).toEqual(["--resume", session, "--append-system-prompt", "Follow the task."]);
    const old = new Date(Date.now() - 60_000);
    appendSpoolLine(fixture.relayHome, spoolLine("claude", "Stop", { session_id: session }, {}, old));
    appendSpoolLine(fixture.relayHome, spoolLine("claude", "Stop", { session_id: "unrelated" }, {}, new Date()));
    const matching = spoolLine("claude", "Stop", { session_id: session }, {}, new Date());
    appendSpoolLine(fixture.relayHome, matching);
    appendSpoolLine(fixture.relayHome, matching);
    await until(() => events().filter((event) => event.kind === "turn_completed").length === 2);
    await new Promise<void>((done) => setTimeout(done, 1100));
    expect(events().filter((event) => event.kind === "turn_completed")).toHaveLength(2);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  }, {}, session);
}, 10_000);

test("interactive prompt is cleaned and passed last without permission flags", async () => {
  await interactiveTest([{ say: "Done." }], async ({ fixture, child, info, events }) => {
    expect(readRecord(fixture.record).argv).toEqual(["--session-id", info.presetSessionId,
      "--append-system-prompt", "Follow the task.", "--", "First turn."]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(events()).toContainEqual({ kind: "turn_completed" });
  }, {}, undefined, { instructions: "Follow\u202e the task.", prompt: "First\u200b turn." });
}, 10_000);

// Claude Code 2.1.282 parses its arguments with Commander: after "--" no argument is an option, but
// a first operand that names a command, such as "update", still runs that command. relay passes
// "--" and adds a space to a one-word prompt.
for (const [prompt, sent] of [["--permission-mode=bypassPermissions", "--permission-mode=bypassPermissions "],
  ["--dangerously-skip-permissions now", "--dangerously-skip-permissions now"], ["-p", "-p "], ["update", "update "], ["help", "help "]] as [string, string][]) {
  test(`interactive passes the prompt ${JSON.stringify(prompt)} as the prompt`, async () => {
    await interactiveTest([{ say: "Done." }], async ({ fixture, child, info, events }) => {
      expect(readRecord(fixture.record).argv).toEqual(["--session-id", info.presetSessionId,
        "--append-system-prompt", "Follow the task.", "--", sent]);
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(events()).toContainEqual({ kind: "turn_completed" });
    }, {}, undefined, { prompt });
  }, 10_000);
}

test("interactive interrupt reaches the inherited-input child", async () => {
  await interactiveTest([{ notification: "ready" }, { hang: true }], async ({ fixture, child, control }) => {
    child.stdin.write("Work.\n");
    await child.stdin.flush();
    await until(() => readSpool(fixture.relayHome).some((line) => line.fields.notification_type === "ready"));
    control("interrupt");
    child.stdin.end();
    expect(await child.exited).toBe(0);
  });
}, 10_000);
