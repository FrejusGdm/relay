import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvalError } from "../src/plan.ts";
import { findRelay, Relay, RelayError, toolVersions } from "../src/relay-cli.ts";
import { cleanup, gitRepo, STUB_RELAY, temp, writeScenario } from "./helpers.ts";

afterEach(cleanup);

function fakeRelay(script: string): string {
  const path = join(temp("fake-relay"), "relay");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("A missing relay stops with exit code 3 and a plain message", () => {
  const dir = temp("no-relay");
  for (const env of [{ RELAY_BIN: join(dir, "relay") }, { PATH: dir }]) {
    try {
      findRelay(env);
      throw new Error("findRelay unexpectedly found relay.");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).exitCode).toBe(3);
      expect((error as EvalError).message).toBe("relay was not found. Build it first or set RELAY_BIN.");
    }
  }
  expect(findRelay({ RELAY_BIN: STUB_RELAY })).toBe(STUB_RELAY);
});

test("Relay calls work against the stub and are copied to the log", async () => {
  const repo = await gitRepo({ "a.txt": "one\n" });
  const log = join(temp("log"), "relay-run.log");
  writeFileSync(log, "");
  const relay = new Relay(STUB_RELAY);
  await relay.init(repo, "eval sample run", log);
  writeFileSync(join(repo, "a.txt"), "two\n");
  const saved = await relay.checkpoint(repo, "eval final", log);
  expect(saved).toMatch(/^[0-9a-f]{40}$/);
  // Nothing changed: relay names the latest checkpoint, whose commit comes from the list.
  expect(await relay.checkpoint(repo, "eval final", log)).toBe(saved);
  const text = readFileSync(log, "utf8");
  expect(text).toContain('$ relay init --title "eval sample run"\nStarted job ');
  expect(text).toContain('$ relay checkpoint --message "eval final" --json\n{"saved":true');
  expect(text).toContain("$ relay checkpoints --json\n");
  expect(await relay.status(repo, log)).toEqual([]);
  const tools = await toolVersions(STUB_RELAY, repo);
  expect(tools).toMatchObject({ relay: "0.0.0-stub", claude: null, codex: null, bun: Bun.version });
}, 30000);

test("A failed switch is a result, and a running relay drains its output to the log", async () => {
  const repo = await gitRepo({ "a.txt": "one\n" });
  const log = join(temp("log"), "relay-run.log");
  writeFileSync(log, "");
  const relay = new Relay(STUB_RELAY);
  await relay.init(repo, "eval sample run", log);
  const scenario = writeScenario({
    workers: { "claude:eval-test": { steps: [{ write: "a.txt", content: "two\n" }], end: "hang" } },
    switch: { exit_code: 31, error: "The next agent did not start." },
  });
  process.env.RELAY_STUB_SCENARIO = scenario;
  try {
    const running = relay.startRun(repo, "claude:eval-test", "Do the task.", log);
    const deadline = Date.now() + 10000;
    while (!readFileSync(log, "utf8").includes('"file_changed"')) {
      if (Date.now() > deadline) throw new Error("relay run printed no step.");
      await Bun.sleep(20);
    }
    const switched = await relay.switchTo(repo, "codex:eval-test", log);
    expect(switched).toMatchObject({ exitCode: 31, error: "The next agent did not start.", result: null });
    running.interrupt();
    expect(await running.exited).toBe(130);
  } finally {
    delete process.env.RELAY_STUB_SCENARIO;
  }
  const text = readFileSync(log, "utf8");
  expect(text).toContain("$ relay run claude:eval-test --headless --prompt <prompt> --json\n");
  expect(text).toContain('"type":"worker_ended"');
  expect(text).toContain("$ relay switch codex:eval-test --yes --json\nThe next agent did not start.\n[exit 31]\n");
  expect(text.trimEnd().endsWith("[exit 130]")).toBe(true);
}, 30000);

test("A non-zero exit or output that is not JSON names the command", async () => {
  const dir = temp("cwd");
  const log = join(dir, "log");
  writeFileSync(log, "");
  await expect(new Relay(fakeRelay('echo "relay is not set up here." >&2; exit 3')).checkpoint(dir, "eval final", log))
    .rejects.toThrow(new RelayError('relay checkpoint --message "eval final" --json exited with code 3: relay is not set up here.'));
  await expect(new Relay(fakeRelay("echo not json")).status(dir, log))
    .rejects.toThrow(new RelayError("relay status --json printed output that is not JSON: not json"));
  await expect(new Relay(fakeRelay('echo "{}"')).switchTo(dir, "codex:work", log))
    .rejects.toThrow(new RelayError("relay switch codex:work --yes --json printed no checkpoint_sha."));
});
