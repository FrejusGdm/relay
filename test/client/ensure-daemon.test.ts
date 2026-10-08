// Task 9.1: ensureDaemon, which relay run and relay switch call before they start an agent. Those
// commands come with add-provider-adapters and add-relay-switch, so the test calls it directly.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDaemon } from "../../src/client/ensure-daemon";
import { VERSION } from "../../src/core/version";
import { runRelay } from "../helpers/cli";
import { removeTempRelayHomes, tempRelayHome, testSocket } from "../helpers/relay-home";

const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  removeTempRelayHomes();
});

function ensure(relayHome: string) {
  let err = "";
  const done = ensureDaemon({ relayHome, env: { ...process.env, RELAY_HOME: relayHome }, err: (text) => (err += text) });
  return done.then((ok) => ({ ok, err }));
}

test("with no daemon, ensureDaemon leaves a running daemon in its own session", async () => {
  const relayHome = tempRelayHome();
  mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
  stops.push(() => runRelay(["daemon", "stop"], { env: { RELAY_HOME: relayHome } }));
  expect(await ensure(relayHome)).toEqual({ ok: true, err: "" });
  const version = (await (await fetch("http://relay/v1/version", { unix: testSocket(relayHome) })).json()) as { pid: number };
  const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(version.pid)], { stdout: "pipe" }).stdout.toString().trim();
  expect(group).toBe(String(version.pid));
  expect(await ensure(relayHome)).toEqual({ ok: true, err: "" });
}, 30_000);

test("a daemon of another version gets the restart notice once", async () => {
  const relayHome = tempRelayHome();
  mkdirSync(join(relayHome, "run"), { mode: 0o700 });
  const server = Bun.serve({
    unix: testSocket(relayHome),
    fetch: () => Response.json({ api: "v1", daemon_version: "0.0.1", pid: process.pid, started_at: new Date().toISOString() }),
  });
  try {
    expect(await ensure(relayHome)).toEqual({
      ok: true,
      err: `The relay daemon is running version 0.0.1; this command is version ${VERSION}. Restart it with: relay daemon restart\n`,
    });
  } finally {
    server.stop(true);
  }
}, 30_000);

test("when the daemon cannot start, it says so and returns false, so the command can go on", async () => {
  const relayHome = tempRelayHome();
  const dir = join(relayHome, "run");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o755);
  expect(await ensure(relayHome)).toEqual({
    ok: false,
    err:
      `relay will not use ${dir}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}\n` +
      `relay could not start its background service. Details are in ${join(relayHome, "logs", "daemon.log")}.\n`,
  });
}, 30_000);
