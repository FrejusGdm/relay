import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "../../../src/core/version";
import { readRecord } from "../../fakes/record";
import { codexTest, THREAD, until } from "./helpers/worker";
import { scriptedAppServer } from "./helpers/app-server";
import { startAppServerWorker } from "../../../src/adapters/codex/app-server-worker";

test("app server handshakes first, starts the thread and closes input after its last turn", async () => {
  const fixture = codexTest();
  try {
    const worker = await fixture.start({ model: "test-model", instructions: "Follow\u202e the task.", prompt: "First\u200b turn." });
    await fixture.finished();
    expect(worker.transport).toBe("codex-app-server");
    expect(readRecord(fixture.record)).toMatchObject({ argv: ["app-server"], cwd: fixture.root, stdin: "pipe" });
    const messages = fixture.messages();
    expect(messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(messages[0]?.params).toEqual({ clientInfo: { name: "relay", title: "relay", version: VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false } });
    expect(messages[1]).toEqual({ method: "initialized" });
    expect(messages[2]?.params).toEqual({ cwd: fixture.root, sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: "Follow the task.", model: "test-model" });
    expect(messages[3]?.params).toEqual({ threadId: THREAD, input: [{ type: "text", text: "First turn.", text_elements: [] }] });
    expect(fixture.events[0]).toMatchObject({ kind: "session_started", providerSessionId: THREAD, source: "stream" });
    expect(fixture.events.at(-1)).toEqual({ kind: "exited", code: 0, signal: null });
    expect(await worker.stop()).toMatchObject({ how: "already_exited" });
  } finally { await fixture.cleanup(); }
});

test("initialize has no following request until the answer arrives", async () => {
  const fixture = codexTest([{ say: "Done." }], { startup_delay_ms: 300 });
  const starting = fixture.start();
  try {
    await until(() => fixture.hasRecord() && fixture.messages().length > 0);
    expect(fixture.messages().map((message) => message.method)).toEqual(["initialize"]);
    await starting;
    await fixture.finished();
  } finally { await starting.catch(() => {}); await fixture.cleanup(); }
});

test("steer uses the active ID, interrupt keeps input open, and send starts the next turn", async () => {
  const fixture = codexTest([], { turns: [{ steps: [{ say: "Ready." }, { hang: true }] }, { steps: [{ say: "Second turn." }] }] });
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await worker.send("Second\u200b message.");
    expect(fixture.messages().find((message) => message.method === "turn/steer")?.params).toEqual({
      threadId: THREAD, expectedTurnId: "turn_1", input: [{ type: "text", text: "Second message.", text_elements: [] }],
    });
    await worker.interrupt();
    await until(() => fixture.events.some((event) => event.kind === "turn_failed" && event.reason === "interrupted"));
    expect(fixture.messages().find((message) => message.method === "turn/interrupt")?.params).toEqual({ threadId: THREAD, turnId: "turn_1" });
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
    await worker.send("Continue.");
    await fixture.finished();
    expect(fixture.messages().filter((message) => message.method === "turn/start")).toHaveLength(2);
    expect(fixture.events.some((event) => event.kind === "turn_completed")).toBe(true);
  } finally { await fixture.cleanup(); }
});

test("resume passes all settings again and read-only uses the read-only sandbox", async () => {
  const fixture = codexTest();
  try {
    await fixture.start({ resumeSessionId: "existing_thread", permission: "read-only" });
    await fixture.finished();
    expect(fixture.messages()[2]).toMatchObject({ method: "thread/resume", params: {
      threadId: "existing_thread", cwd: fixture.root, sandbox: "read-only", approvalPolicy: "never", developerInstructions: "Follow the task.",
    } });
    expect(fixture.messages()[3]?.params?.threadId).toBe("existing_thread");
    expect(fixture.events[0]).toMatchObject({ kind: "session_started", providerSessionId: "existing_thread" });
  } finally { await fixture.cleanup(); }
});

test("stop interrupts a running turn then closes input, and broken lines only add a closing note", async () => {
  const fixture = codexTest([{ raw: "{broken" }, { raw: '{"method":"future/event"}' }, { say: "Ready." }, { hang: true }]);
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    expect(await worker.stop({ timeoutMs: 1000 })).toMatchObject({ how: "clean", turnEnded: true });
    await fixture.finished();
    expect(readFileSync(fixture.request.logPath, "utf8")).toContain("ignored 1 line that was not JSON and 1 unknown event.");
  } finally { await fixture.cleanup(); }
});

for (const method of ["thread/start", "thread/resume", "turn/start"]) {
  test(`${method} error emits the server's failure and stops the worker`, async () => {
    const fixture = codexTest();
    const path = scriptedAppServer(fixture.root, { errorMethod: method, code: method === "thread/resume" ? -32601 : -32602 });
    try {
      const request = { ...fixture.request, ...(method === "thread/resume" ? { resumeSessionId: "previous" } : {}) };
      const worker = fixture.collect(await startAppServerWorker(fixture.account, request, { ...fixture.env, RELAY_CODEX_BIN: path }));
      expect(worker.transport).toBe("codex-app-server");
      await fixture.finished();
      expect(fixture.events.filter((event) => event.kind === "turn_failed")).toEqual([
        { kind: "turn_failed", reason: "other", message: "The requested operation failed.", source: "stream_event" },
      ]);
      expect(fixture.events.at(-1)).toEqual({ kind: "exited", code: 0, signal: null });
    } finally { await fixture.cleanup(); }
  });
}

test("stop kills at its deadline even if the server ignores interrupt and EOF", async () => {
  const fixture = codexTest();
  const path = scriptedAppServer(fixture.root, { hang: true });
  try {
    const worker = fixture.collect(await startAppServerWorker(fixture.account, fixture.request, { ...fixture.env, RELAY_CODEX_BIN: path }, { requestMs: 10_000 }));
    await until(() => fixture.events.some((event) => event.kind === "message"));
    const start = performance.now();
    expect(await worker.stop({ timeoutMs: 100 })).toMatchObject({ how: "killed", signal: "SIGKILL" });
    expect(performance.now() - start).toBeLessThan(1500);
    await fixture.finished();
    expect(fixture.events.filter((event) => event.kind === "exited")).toHaveLength(1);
    expect(await worker.stop()).toMatchObject({ how: "already_exited" });
  } finally { await fixture.cleanup(); }
});

test("an oversized sent message is rejected without changing the running turn", async () => {
  const fixture = codexTest([{ say: "Ready." }, { hang: true }]);
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    const before = fixture.messages();
    await expect(worker.send("é".repeat(51_201))).rejects.toThrow("The prompt is too long");
    expect(fixture.messages()).toEqual(before);
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("an unknown turn status does not close a running turn's input", async () => {
  const fixture = codexTest([
    { raw: JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_1", status: "future_status" } } }) },
    { say: "Ready." }, { hang: true },
  ]);
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await worker.send("Continue.");
    expect(fixture.messages().at(-1)).toMatchObject({ method: "turn/steer", params: { expectedTurnId: "turn_1" } });
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
  } finally { await fixture.cleanup(); }
});

for (const mode of ["headless", "interactive"] as const) {
  for (const field of ["instructions", "prompt"] as const) {
    test(`${mode} rejects oversized ${field} before starting Codex`, async () => {
      const fixture = codexTest();
      try {
        await expect(fixture.adapter.start(fixture.account, { ...fixture.request, mode, [field]: "é".repeat(51_201) })).rejects.toThrow("The prompt is too long");
        expect(fixture.hasRecord()).toBe(false);
      } finally { await fixture.cleanup(); }
    });
  }
}
