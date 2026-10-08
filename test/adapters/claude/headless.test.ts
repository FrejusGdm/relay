import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createClaudeAdapter } from "../../../src/adapters/claude/adapter";
import { readRecord } from "../../fakes/record";
import { claudeTest, until } from "./helpers/worker";

const BYPASS = ["--dangerously-skip-permissions", "bypassPermissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "danger-full-access"];
for (const [permission, mode] of [["edit-in-workspace", "acceptEdits"], ["read-only", "dontAsk"]] as const) {
  test(`headless ${permission} passes exact flags and a user message, then closes input`, async () => {
    const fixture = claudeTest();
    try {
      const worker = await fixture.start({ permission, model: "test-model", instructions: "Follow\u202e the task.", prompt: "First\u200b turn." });
      await fixture.finished();
      const record = readRecord(fixture.record);
      expect(worker.presetSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(record.argv).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--session-id", worker.presetSessionId!, "--permission-mode", mode, "--permission-prompts", "none",
        "--append-system-prompt", "Follow the task.", "--model", "test-model"]);
      expect(record.input).toEqual([JSON.stringify({ type: "user", message: { role: "user", content: "First turn." }, parent_tool_use_id: null })]);
      for (const flag of BYPASS) expect(record.argv.join(" ")).not.toContain(flag);
      expect(await worker.wait()).toEqual({ code: 0, signal: null });
      expect(fixture.events[0]).toMatchObject({ kind: "session_started", providerSessionId: worker.presetSessionId });
      expect(fixture.events.at(-1)).toEqual({ kind: "exited", code: 0, signal: null });
      expect(() => worker.events()).toThrow("only be read once");
    } finally { await fixture.cleanup(); }
  }, 10_000);
}

test("a second message sent during the first turn waits for its own result", async () => {
  const fixture = claudeTest([], { turns: [
    { steps: [{ say: "Ready." }, { run: "first", delay_ms: 100 }] },
    { steps: [{ say: "Second." }, { run: "second", delay_ms: 200 }] },
  ] });
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await worker.send("Second\u200b message.");
    await until(() => fixture.events.some((event) => event.kind === "turn_completed"));
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
    await fixture.finished();
    expect(fixture.events.filter((event) => event.kind === "turn_completed")).toHaveLength(2);
    expect(readRecord(fixture.record).input.map((line) => JSON.parse(line).message.content)).toEqual(["First turn.", "Second message."]);
  } finally { await fixture.cleanup(); }
}, 10_000);

test("unknown and broken output ends the worker log with the counts", async () => {
  const fixture = claudeTest([{ raw: "not JSON" }, { raw: '{"type":"new_event"}' }, { say: "Done." }]);
  try {
    await fixture.start();
    await fixture.finished();
    expect(readFileSync(fixture.request.logPath, "utf8").trim().split("\n").at(-1)).toBe("relay ignored 1 line that was not JSON and 1 unknown event.");
    expect(fixture.events.some((event) => event.kind === "turn_failed")).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("a mismatched init session is kept and noted in the log", async () => {
  const fixture = claudeTest([{ say: "Done." }], { session_id: "reported-session" });
  try {
    const worker = await fixture.start();
    await fixture.finished();
    expect(fixture.events[0]).toMatchObject({ kind: "session_started", providerSessionId: "reported-session" });
    expect(readFileSync(fixture.request.logPath, "utf8")).toContain(`Claude Code reported session reported-session, not the session ID relay chose (${worker.presetSessionId}).`);
  } finally { await fixture.cleanup(); }
});

for (const mode of ["headless", "interactive"] as const) {
  for (const field of ["instructions", "prompt"] as const) {
    test(`${mode} refuses over 100 KB of ${field} before starting`, async () => {
      const fixture = claudeTest();
      try {
        await expect(fixture.adapter.start(fixture.account, { ...fixture.request, mode, [field]: "é".repeat(51_201) })).rejects.toThrow(
          "The prompt is too long to pass on the command line; put it in a file under .relay/ and refer to it.");
        expect(existsSync(fixture.record)).toBe(false);
        expect(existsSync(fixture.request.logPath)).toBe(false);
      } finally { await fixture.cleanup(); }
    });
  }
}

test("a missing prompt and a missing program are refused", async () => {
  const fixture = claudeTest();
  try {
    await expect(fixture.adapter.start(fixture.account, { ...fixture.request, prompt: undefined })).rejects.toThrow("needs a prompt");
    await expect(createClaudeAdapter({ PATH: "" }).start(fixture.account, fixture.request)).rejects.toThrow("Claude Code is not installed.");
    expect(fixture.hasRecord()).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("an oversized sent message is refused without changing the worker’s input", async () => {
  const fixture = claudeTest([{ say: "Ready." }, { hang: true }]);
  try {
    const worker = await fixture.start();
    await until(() => fixture.events.some((event) => event.kind === "message"));
    await expect(worker.send("é".repeat(51_201))).rejects.toThrow("The prompt is too long");
    expect(readRecord(fixture.record).input).toHaveLength(1);
    expect(fixture.events.some((event) => event.kind === "exited")).toBe(false);
  } finally { await fixture.cleanup(); }
});

for (const mode of ["headless", "interactive"] as const) {
  test(`${mode}: a session ID that is not a UUID never reaches Claude Code`, async () => {
    const fixture = claudeTest();
    try {
      for (const resumeSessionId of ["--permission-mode=bypassPermissions", "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f --fork-session"]) {
        await expect(fixture.adapter.start(fixture.account, { ...fixture.request, mode, resumeSessionId }))
          .rejects.toThrow("The session ID to resume is not a UUID, so relay did not start the agent.");
      }
      expect(fixture.hasRecord()).toBe(false);
    } finally { await fixture.cleanup(); }
  });
}
