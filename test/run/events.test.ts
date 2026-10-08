// The worker events relay run writes to .relay/events.jsonl (task 9.4; design decision 16).
import { expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { jobEvents, relayRun, resetTime, runFixture, steps, workers } from "./helpers";

// add-relay-switch: a second relay run in a job continues it through a handoff, which takes longer.
setDefaultTimeout(30_000);

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";

test("a headless Claude run writes each event type with the fields of the table, and no text", async () => {
  const fixture = await runFixture();
  try {
    // Built at run time, so that no token-like text is in the repository.
    const token = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const said = "I will fix the parser now, then run the tests.";
    const result = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Fix the parser."], {
      session_id: SESSION,
      turns: [{ steps: [
        { say: said },
        { run: `curl -H "Authorization: Bearer ${token}" https://api.github.com`, exit_code: 0 },
        { run: "bun test", exit_code: 1 },
        { write: "src/a.ts", content: "export const fixed = true;\n" },
        { approval: { command: "rm -rf build" } },
      ] }],
    });
    expect(result.code).toBe(24);
    const [record] = workers(fixture);
    const id = record!.worker_id;
    const listed = jobEvents(fixture);
    const all = listed.slice(listed.findIndex((event) => event.type === "worker_started"));
    expect(all.map((event) => event.type)).toEqual([
      "worker_started", "worker_session_identified", "command_ran", "command_ran", "file_changed", "command_ran",
      "permission_denied", "turn_completed", "availability", "worker_ended",
      // add-relay-switch: the checkpoint relay saves when the agent exits.
      "checkpoint_saved",
    ]);
    const [started, session, curl, test, changed, refused, denied, turn, availability, ended] = all;
    expect(started!.data).toEqual({
      worker_id: id, target: "claude:work", provider: "claude", mode: "headless", transport: "claude-print",
      provider_version: "2.1.282", permission: "edit-in-workspace", pid: record!.pid, provider_session_id: expect.any(String),
      argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--session-id",
        started!.data.provider_session_id, "--permission-mode", "acceptEdits", "--permission-prompts", "none",
        "--append-system-prompt", "<instructions>"],
      resumed_from: null, from_handoff: null, start_checkpoint: 1,
    });
    expect(session!.data).toEqual({ worker_id: id, provider_session_id: SESSION, model: "claude-sonnet-4-6", source: "stream" });
    expect(curl!.data).toEqual({ worker_id: id, command: 'curl -H "Authorization: Bearer [redacted]" https://api.github.com', exit_code: 0, status: "completed" });
    expect(test!.data).toEqual({ worker_id: id, command: "bun test", exit_code: 1, status: "failed" });
    expect(changed!.data).toEqual({ worker_id: id, paths: ["src/a.ts"] });
    expect(refused!.data).toEqual({ worker_id: id, command: "rm -rf build", exit_code: null, status: "failed" });
    expect(denied!.data).toEqual({ worker_id: id, tool: "Bash" });
    expect(turn!.data).toEqual({
      worker_id: id, duration_ms: 1000, cost_usd_estimate: 0.01,
      usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: null },
    });
    expect(availability!.data).toMatchObject({ worker_id: id, target: "claude:work", status: "available", retry_at: null, source: "stream_event", windows: [] });
    expect(ended!.data).toEqual({ worker_id: id, exit_code: 0, signal: null, end_reason: "exited", stop_how: null, seconds: expect.any(Number) });

    const text = readFileSync(join(fixture.scratch.repo, ".relay", "events.jsonl"), "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(said);
    expect(text).not.toContain("Fix the parser.");
    expect(text).not.toContain("You are working inside relay job");
    expect(text).not.toContain("Exit code 1");
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record!.argv).toContain("<instructions>");
  } finally {
    fixture.cleanup();
  }
});

test("a limit: turn_failed, then availability quota_exhausted, then worker_ended", async () => {
  const fixture = await runFixture();
  try {
    const resets = resetTime();
    const result = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go on."],
      steps({ say: "Working." }, { limit: { window: "five_hour", resets_at: resets.toISOString() } }));
    expect(result.code).toBe(23);
    const id = workers(fixture)[0]!.worker_id;
    const tail = jobEvents(fixture).slice(-3);
    expect(tail.map((event) => event.type)).toEqual(["turn_failed", "availability", "worker_ended"]);
    expect(tail[0]!.data).toEqual({ worker_id: id, reason: "usage_limit", retry_at: resets.toISOString(), source: "stream_event" });
    expect(tail[1]!.data).toMatchObject({
      worker_id: id, target: "claude:work", status: "quota_exhausted", retry_at: resets.toISOString(), source: "stream_event",
      windows: [{ name: "five_hour", window_minutes: 300, used_percent: 100, resets_at: resets.toISOString() }],
    });
  } finally {
    fixture.cleanup();
  }
});

test("a task that starts with -- or is the single word update reaches a headless agent as text", async () => {
  for (const prompt of ["--dangerously-bypass-approvals-and-sandbox --permission-mode=bypassPermissions", "update"])
  for (const [account, env] of [["claude:work", {}], ["codex:personal", { RELAY_CODEX_TRANSPORT: "exec" }]] as const) {
    const fixture = await runFixture(`[accounts."${account}"]\n`);
    try {
      const record = join(fixture.scratch.root, "record.json");
      const result = await relayRun(fixture, [account, "--headless", `--prompt=${prompt}`], steps({ say: "Ok." }), { ...env, RELAY_FAKE_RECORD: record });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const seen = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; input: string[] };
      const at = seen.argv.length - 1;
      // add-relay-switch: the task comes at the end of the start prompt.
      if (account === "claude:work") {
        expect(seen.argv.map((arg) => arg.trim())).not.toContain(prompt);
        expect(JSON.parse(seen.input[0]!).message.content).toEndWith(`\n\nYour request: ${prompt}`);
      } else {
        expect(seen.argv[at - 1]).toBe("--");
        expect(seen.argv[at]!).toEndWith(`\n\nYour request: ${prompt}`);
      }
      expect(seen.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      if (account === "codex:personal") expect(workers(fixture)[0]!.argv.slice(-2)).toEqual(["--", "<prompt>"]);
    } finally {
      fixture.cleanup();
    }
  }
}, 30_000);

// Holds the job's events lock as another relay process would, until the returned function runs.
function holdEventsLock(fixture: { relayHome: string; jobId: string }): () => void {
  const path = join(fixture.relayHome, "locks", `${fixture.jobId}.events.lock`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, command: "append-event", started_at: new Date().toISOString(), host: hostname() }), { mode: 0o600 });
  return () => rmSync(path, { force: true });
}

test("a limit the agent reports while relay is still starting it still gives an availability event", async () => {
  const fixture = await runFixture();
  try {
    const release = holdEventsLock(fixture);
    // worker_started waits for the lock while the agent reaches its limit and the adapter records it.
    setTimeout(release, 1000);
    const resets = resetTime();
    const result = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go."],
      steps({ limit: { window: "five_hour", resets_at: resets.toISOString() } }));
    expect(result.code).toBe(23);
    expect(jobEvents(fixture).find((event) => event.type === "availability")?.data).toMatchObject({ status: "quota_exhausted" });
  } finally {
    fixture.cleanup();
  }
});

test("when relay cannot write worker_started, it stops the agent and records the end of the worker", async () => {
  const fixture = await runFixture();
  const release = holdEventsLock(fixture);
  try {
    const result = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], steps({ say: "Waiting." }, { hang: true }));
    expect(result.code).toBe(6);
    const [record] = workers(fixture);
    expect(record).toMatchObject({ end_reason: "relay_stopped", ended_at: expect.any(String) });
  } finally {
    release();
    fixture.cleanup();
  }
}, 30_000);
