// Task 2.2: the daemon's JSON-lines log, its rotation, and the fields it never writes.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogFields } from "../../src/core/log";
import { openDaemonLog } from "../../src/daemon/log";
import { makeRelayHome } from "../helpers/home";

const fail = (file: string, reason: string) => {
  throw new Error(`log failure for ${file}: ${reason}`);
};

test("writes one JSON object per line to logs/daemon.log", () => {
  const relayHome = makeRelayHome();
  const log = openDaemonLog({ relayHome, level: "info", onFailure: fail });
  log.debug("not written at info");
  log.info("daemon_started", { socket: "/r/run/relay.sock", schema_version: 1 });
  const lines = readFileSync(join(relayHome, "logs", "daemon.log"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    level: "info",
    msg: "daemon_started",
    pid: process.pid,
    socket: "/r/run/relay.sock",
    schema_version: 1,
  });
});

test("rotates before a write would pass the limit, keeps five older files, all with mode 0600", () => {
  const relayHome = makeRelayHome();
  const log = openDaemonLog({ relayHome, level: "info", maxBytes: 1024, onFailure: fail });
  for (let n = 0; n < 200; n++) log.info("request", { method: "GET", path: "/v1/version", status: 200, n });
  const dir = join(relayHome, "logs");
  const names = readdirSync(dir).filter((name) => name.startsWith("daemon.log")).sort();
  expect(names).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3", "daemon.log.4", "daemon.log.5"]);
  for (const name of names) {
    const stats = statSync(join(dir, name));
    expect(stats.size).toBeLessThanOrEqual(1024);
    expect(stats.mode & 0o777).toBe(0o600);
  }
  // The newest entry is in daemon.log, the one before it at the end of daemon.log.1.
  const last = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8").trim().split("\n").at(-1)!).n;
  expect(last("daemon.log")).toBe(199);
  expect(last("daemon.log.1")).toBeLessThan(199);
});

test("never writes the environment, hook payload fields outside the allow list, or nested values", () => {
  const relayHome = makeRelayHome();
  const secret = ["sk", "test", String(Date.now())].join("-");
  const log = openDaemonLog({ relayHome, level: "debug", onFailure: fail });
  const fields = {
    env: { ANTHROPIC_API_KEY: secret },
    ENV: secret,
    tool_input: { command: `echo ${secret}` },
    tool_response: secret,
    transcript_path: `/tmp/${secret}.jsonl`,
    error_details: secret,
    body: secret,
    headers: secret,
    nested: { value: secret },
    list: [secret, { value: secret }],
    kept: "visible",
    event: "Stop",
  } as unknown as LogFields;
  log.warn("hook_received", fields);
  const text = readFileSync(join(relayHome, "logs", "daemon.log"), "utf8");
  expect(text).not.toContain(secret);
  const entry = JSON.parse(text);
  for (const key of ["env", "ENV", "tool_input", "tool_response", "transcript_path", "error_details", "body", "headers", "nested", "list"]) {
    expect(Object.keys(entry)).not.toContain(key);
  }
  expect(entry).toMatchObject({ msg: "hook_received", kept: "visible", event: "Stop" });
  expect(existsSync(join(relayHome, "logs", "daemon.log.1"))).toBe(false);
});
