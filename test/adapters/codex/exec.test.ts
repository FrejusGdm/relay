import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCodexAdapter } from "../../../src/adapters/codex/adapter";
import { startAppServerWorker } from "../../../src/adapters/codex/app-server-worker";
import { startExecWorker } from "../../../src/adapters/codex/exec";
import { tomlString } from "../../../src/adapters/text";
import { UnsupportedOperation } from "../../../src/adapters/types";
import { readRecord } from "../../fakes/record";
import { codexTest, until } from "./helpers/worker";
import { unresponsiveExec } from "./helpers/app-server";

const NOTE = "The Codex app server did not start, so relay is using codex exec. Reset times will not be available for this run.";

test("exec command line uses EOF, TOML instructions, model and sandbox", async () => {
  const fixture = codexTest();
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  try {
    const worker = await fixture.start({ permission: "read-only", model: "test-model", instructions: 'Follow\u200b "the task".\nNext line.', prompt: "First\u202e turn." });
    await fixture.finished();
    expect(worker.transport).toBe("codex-exec");
    expect(readRecord(fixture.record)).toMatchObject({ cwd: fixture.root, stdin: "eof", input: [], argv: [
      "exec", "--json", "-C", fixture.root, "-s", "read-only", "-c", `developer_instructions=${tomlString('Follow "the task".\nNext line.')}`, "-m", "test-model", "First turn.",
    ] });
  } finally { await fixture.cleanup(); }
});

test("exec resume passes settings again without flags that resume cannot accept", async () => {
  const fixture = codexTest();
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  try {
    await fixture.start({ resumeSessionId: "thread_previous" });
    await fixture.finished();
    expect(readRecord(fixture.record)).toMatchObject({ cwd: fixture.root, stdin: "eof", argv: ["exec", "resume", "thread_previous", "--json",
      "-c", 'sandbox_mode="workspace-write"', "-c", 'developer_instructions="Follow the task."', "First turn."] });
  } finally { await fixture.cleanup(); }
});

test("request environment can force exec and any other value keeps the default", async () => {
  const fixture = codexTest();
  try {
    const adapter = createCodexAdapter({ ...fixture.env, RELAY_CODEX_TRANSPORT: "another-value" });
    const worker = fixture.collect(await adapter.start(fixture.account, { ...fixture.request, env: { ...fixture.env, RELAY_CODEX_TRANSPORT: "exec" } }));
    expect(worker.transport).toBe("codex-exec");
    await fixture.finished();
  } finally { await fixture.cleanup(); }
  const ordinary = codexTest();
  ordinary.env.RELAY_CODEX_TRANSPORT = "another-value";
  try { expect((await ordinary.start()).transport).toBe("codex-app-server"); await ordinary.finished(); }
  finally { await ordinary.cleanup(); }
});

for (const behavior of ["exit_immediately", "method_not_found", "no_answer"] as const) {
  test(`app server ${behavior} falls back with a log note`, async () => {
    const fixture = codexTest([{ say: "Done." }], { app_server: behavior });
    try {
      const worker = fixture.collect(await startAppServerWorker(fixture.account, fixture.request, fixture.env, { initializeMs: behavior === "no_answer" ? 200 : 2000 }));
      expect(worker.transport).toBe("codex-exec");
      await fixture.finished();
      expect(readFileSync(fixture.request.logPath, "utf8")).toContain(`relay ${NOTE}`);
      expect(readRecord(fixture.record).argv[0]).toBe("exec");
      expect(fixture.events.filter((event) => event.kind === "exited")).toHaveLength(1);
      expect(fixture.events[0]?.kind).toBe("session_started");
    } finally { await fixture.cleanup(); }
  });
}

test("send refuses without stopping exec; interruption ends its process cleanly", async () => {
  const fixture = codexTest([{ say: "Ready." }, { hang: true }]);
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await expect(worker.send("Another message.")).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(worker.send("Another message.")).rejects.toThrow("Codex in codex exec mode cannot receive a message while it runs.");
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
    expect(await worker.stop({ timeoutMs: 1000 })).toMatchObject({ how: "clean", exitCode: 1, turnEnded: true });
    await fixture.finished();
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: "turn_failed", reason: "interrupted" }));
    expect(await worker.stop()).toMatchObject({ how: "already_exited" });
  } finally { await fixture.cleanup(); }
});

test("exec usage-limit text supplies its reset time", async () => {
  const reset = new Date(Date.now() + 86_400_000);
  reset.setSeconds(0, 0);
  const fixture = codexTest([{ limit: { window: "primary", resets_at: reset.toISOString() } }]);
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  try {
    await fixture.start(); await fixture.finished();
    const failure = fixture.events.find((event) => event.kind === "turn_failed");
    expect(failure).toMatchObject({ reason: "usage_limit", source: "message_text" });
    expect(failure?.kind === "turn_failed" ? failure.retryAt?.getTime() : undefined).toBe(reset.getTime());
  } finally { await fixture.cleanup(); }
});

test("exec reset text uses the worker's timezone without changing relay's timezone", async () => {
  const reset = new Date(Date.now() + 86_400_000);
  reset.setSeconds(0, 0);
  const fixture = codexTest([{ limit: { window: "primary", resets_at: reset.toISOString() } }]);
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  fixture.env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC" ? "America/New_York" : "UTC";
  const original = process.env.TZ;
  try {
    await fixture.start(); await fixture.finished();
    const failure = fixture.events.find((event) => event.kind === "turn_failed");
    expect(failure?.kind === "turn_failed" ? failure.retryAt?.getTime() : undefined).toBe(reset.getTime());
    expect(process.env.TZ).toBe(original);
  } finally { await fixture.cleanup(); }
});

for (const apostrophe of ["'", "’"]) {
  test(`an error record alone recognises a ${apostrophe} usage-limit message`, async () => {
    const fixture = codexTest([{ raw: JSON.stringify({ type: "error", message: `You${apostrophe}ve hit your usage limit. Try again at 3:45 PM.` }) }, { exit: 1 }]);
    fixture.env.RELAY_CODEX_TRANSPORT = "exec";
    try {
      await fixture.start(); await fixture.finished();
      const failure = fixture.events.find((event) => event.kind === "turn_failed");
      expect(failure).toMatchObject({ reason: "usage_limit", source: "message_text" });
      expect(failure?.kind === "turn_failed" ? failure.retryAt : undefined).toBeInstanceOf(Date);
      expect(fixture.events.filter((event) => event.kind === "turn_failed")).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });
}

test("exit code 1 without a usage message is other", async () => {
  const fixture = codexTest([{ exit: 1 }]);
  fixture.env.RELAY_CODEX_TRANSPORT = "exec";
  try {
    await fixture.start(); await fixture.finished();
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: "turn_failed", reason: "other" }));
  } finally { await fixture.cleanup(); }
});

for (const ignoreTerm of [false, true]) {
  test(`exec stop escalates an ignored interrupt to ${ignoreTerm ? "SIGKILL" : "SIGTERM"}`, async () => {
    const fixture = codexTest();
    try {
      const path = unresponsiveExec(fixture.root, ignoreTerm);
      const worker = fixture.collect(await startExecWorker(fixture.account, fixture.request,
        { ...fixture.env, RELAY_CODEX_BIN: path }, { interruptMs: 40 }));
      await until(() => fixture.events.some((event) => event.kind === "message"));
      const stopped = await worker.stop({ timeoutMs: 200 });
      expect(stopped.how).toBe(ignoreTerm ? "killed" : "terminated");
      expect(stopped.turnEnded).toBe(false);
      await fixture.finished();
      expect(fixture.events.filter((event) => event.kind === "turn_failed")).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });
}
