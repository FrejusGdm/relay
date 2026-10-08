import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { startClaudeHeadless } from "../../../src/adapters/claude/headless";
import { readRecord } from "../../fakes/record";
import { claudeTest, until } from "./helpers/worker";

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";

test("interrupt ends a hanging turn, keeps input open, and permits another message", async () => {
  const fixture = claudeTest([{ say: "Ready." }, { hang: true }]);
  try {
    const worker = fixture.collect(await startClaudeHeadless(fixture.account, fixture.request, fixture.env,
      { interruptMs: 100, terminateMs: 100 }));
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await worker.interrupt();
    await until(() => fixture.events.some((event) => event.kind === "turn_failed" && event.reason === "interrupted"));
    await new Promise<void>((done) => setTimeout(done, 250));
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
    await worker.send("Continue.");
    await fixture.finished();
    expect(fixture.events.some((event) => event.kind === "turn_completed")).toBe(true);
    expect((await worker.stop()).how).toBe("already_exited");
    await worker.interrupt();
  } finally { await fixture.cleanup(); }
}, 10_000);

test("stop interrupts a hanging turn and closes input cleanly", async () => {
  const fixture = claudeTest([{ say: "Ready." }, { hang: true }]);
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    expect(await worker.stop({ timeoutMs: 1000 })).toEqual({ how: "clean", exitCode: 1, signal: null, turnEnded: true });
    await fixture.finished();
    expect(fixture.events.some((event) => event.kind === "turn_failed" && event.reason === "interrupted")).toBe(true);
    expect((await worker.stop()).how).toBe("already_exited");
  } finally { await fixture.cleanup(); }
}, 10_000);

function unresponsiveProgram(root: string, ignoreTerm: boolean): string {
  const path = join(root, "unresponsive");
  const recordModule = resolve(import.meta.dir, "../../fakes/record.ts");
  writeFileSync(path, `#!${process.execPath}
import { startRecord } from ${JSON.stringify(recordModule)};
const argv = process.argv.slice(2);
const record = startRecord(argv);
const session = argv[argv.indexOf("--session-id") + 1];
process.on("SIGINT", () => {});
process.on("SIGTERM", () => { ${ignoreTerm ? "" : "process.exit(143);"} });
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (text) => {
  pending += text;
  let newline;
  while ((newline = pending.indexOf("\\n")) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    record?.input(line);
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Ready." }] } }));
  }
});
setInterval(() => {}, 60000);
`, { mode: 0o755 });
  return path;
}

for (const ignoreTerm of [false, true]) {
  test(`an ignored interrupt escalates to ${ignoreTerm ? "SIGKILL" : "SIGTERM"}`, async () => {
    const fixture = claudeTest();
    try {
      const path = unresponsiveProgram(fixture.root, ignoreTerm);
      const worker = fixture.collect(await startClaudeHeadless(fixture.account, fixture.request,
        { RELAY_CLAUDE_BIN: path }, { interruptMs: 40, terminateMs: 40 }));
      await until(() => fixture.events.some((event) => event.kind === "message"));
      await worker.interrupt();
      const status = await worker.wait();
      await fixture.finished();
      expect(status).toEqual(ignoreTerm ? { code: null, signal: "SIGKILL" } : { code: 143, signal: null });
      expect(fixture.events).toContainEqual({ kind: "turn_failed", reason: "interrupted", message: "The agent stopped before the turn ended.", source: "none" });
      expect((await worker.stop()).how).toBe("already_exited");
    } finally { await fixture.cleanup(); }
  }, 10_000);
}

test("stop respects its shorter deadline when no result arrives", async () => {
  const fixture = claudeTest();
  try {
    const worker = fixture.collect(await startClaudeHeadless(fixture.account, fixture.request,
      { RELAY_CLAUDE_BIN: unresponsiveProgram(fixture.root, true) }));
    await until(() => fixture.events.some((event) => event.kind === "message"));
    const started = performance.now();
    expect(await worker.stop({ timeoutMs: 50 })).toEqual({ how: "killed", exitCode: null, signal: "SIGKILL", turnEnded: false });
    expect(performance.now() - started).toBeLessThan(1000);
  } finally { await fixture.cleanup(); }
}, 10_000);

test("stop reports termination when SIGTERM ends an unresponsive turn", async () => {
  const fixture = claudeTest();
  try {
    const worker = fixture.collect(await startClaudeHeadless(fixture.account, fixture.request,
      { RELAY_CLAUDE_BIN: unresponsiveProgram(fixture.root, false) }, { interruptMs: 40, terminateMs: 100 }));
    await until(() => fixture.events.some((event) => event.kind === "message"));
    expect(await worker.stop({ timeoutMs: 1000 })).toEqual({ how: "terminated", exitCode: 143, signal: null, turnEnded: false });
  } finally { await fixture.cleanup(); }
});

test("resume sends every setting again without a new session flag", async () => {
  const fixture = claudeTest();
  try {
    const worker = await fixture.start({ resumeSessionId: SESSION, permission: "read-only", model: "test-model" });
    await fixture.finished();
    expect(worker.presetSessionId).toBe(SESSION);
    expect(readRecord(fixture.record).argv).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--resume", SESSION, "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--append-system-prompt", "Follow the task.", "--model", "test-model"]);
  } finally { await fixture.cleanup(); }
});

test("an unexpected exit in a turn is a crash", async () => {
  const fixture = claudeTest([{ crash: { signal: "SIGKILL" } }]);
  try {
    await fixture.start();
    await fixture.finished();
    expect(fixture.events.some((event) => event.kind === "turn_failed" && event.reason === "crashed")).toBe(true);
    expect(fixture.events.at(-1)).toEqual({ kind: "exited", code: null, signal: "SIGKILL" });
  } finally { await fixture.cleanup(); }
});
