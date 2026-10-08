// Task 2.3: one daemon per relay folder, starting, stopping, status, and the refusals of stop.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRelay } from "../helpers/cli";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, tempRelayHome, testSocket, waitForDaemon } from "../helpers/relay-home";

// Daemons started with `relay daemon start` are not children of the test; they are killed here
// if a test fails before it stops them.
const detached = new Set<number>();
afterAll(() => {
  for (const pid of detached) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  removeTempRelayHomes();
});

const LOCK_CHILD = join(import.meta.dir, "..", "platform", "lock-child.ts");
const relay = (relayHome: string, ...args: string[]) => runRelay(["daemon", ...args], { env: { RELAY_HOME: relayHome } });
const pidFile = (relayHome: string) => join(relayHome, "run", "daemon.pid");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Lists the TCP and UDP sockets a process has open: none is the rule for the daemon.
function networkSockets(pid: number): string[] {
  if (process.platform === "darwin") {
    return Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-i"], { stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
  }
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6", "udp", "udp6"]) {
    const path = `/proc/net/${table}`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").trim().split("\n").slice(1)) inodes.add(line.trim().split(/\s+/)[9]!);
  }
  const found: string[] = [];
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode !== undefined && inodes.has(inode)) found.push(target);
  }
  return found;
}

describe("relay daemon run", () => {
  test("two daemons started together leave exactly one; the other exits 0 with already running", async () => {
    const relayHome = tempRelayHome();
    const first = spawnDaemon(relayHome);
    const second = spawnDaemon(relayHome);
    const loser = await Promise.race([first.exited.then(() => first), second.exited.then(() => second)]);
    const winner = loser === first ? second : first;
    expect(await loser.exited).toBe(0);
    expect(await new Response(loser.stderr).text()).toBe(`relay daemon is already running (pid ${winner.pid})\n`);
    expect((await waitForDaemon(relayHome)).pid).toBe(winner.pid);
    expect(await stopDaemon(winner)).toBe(0);
  }, 20_000);

  test("the socket is 0600 in a 0700 directory, the daemon has no network socket, and a clean stop removes the socket and pid file", async () => {
    const relayHome = tempRelayHome();
    const child = spawnDaemon(relayHome);
    const version = await waitForDaemon(relayHome);
    expect(version).toMatchObject({ api: "v1", pid: child.pid });
    expect(lstatSync(join(relayHome, "run")).mode & 0o777).toBe(0o700);
    expect(lstatSync(testSocket(relayHome)).mode & 0o777).toBe(0o600);
    expect(lstatSync(pidFile(relayHome)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pidFile(relayHome), "utf8"))).toEqual({
      pid: child.pid,
      started_at: version.started_at,
      version: version.daemon_version,
      socket: testSocket(relayHome),
    });
    expect(networkSockets(child.pid)).toEqual([]);
    expect(await stopDaemon(child)).toBe(0);
    expect(existsSync(testSocket(relayHome))).toBe(false);
    expect(existsSync(pidFile(relayHome))).toBe(false);
    const messages = readFileSync(join(relayHome, "logs", "daemon.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).msg);
    expect(messages).toEqual(["daemon_started", "daemon_stopping", "daemon_stopped"]);
  }, 20_000);

  test("refuses a runtime directory others can read, on standard error and in daemon.log", async () => {
    const relayHome = tempRelayHome();
    mkdirSync(join(relayHome, "run"), { mode: 0o700 });
    chmodSync(join(relayHome, "run"), 0o755);
    const dir = join(relayHome, "run");
    const message = `relay cannot start: ${dir} must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}`;
    expect(await relay(relayHome, "run")).toEqual({ code: 1, stdout: "", stderr: `${message}\n` });
    const entry = JSON.parse(readFileSync(join(relayHome, "logs", "daemon.log"), "utf8").trim());
    expect(entry).toMatchObject({ level: "error", msg: "daemon_refused", reason: message });
  }, 20_000);

  test("writes no credential from its environment to any log", async () => {
    const relayHome = tempRelayHome();
    const secret = ["sk", "ant", "test", String(Date.now())].join("-");
    const child = spawnDaemon(relayHome, { ANTHROPIC_API_KEY: secret, RELAY_LOG_LEVEL: "debug" });
    await waitForDaemon(relayHome);
    expect(await stopDaemon(child)).toBe(0);
    for (const name of readdirSync(join(relayHome, "logs"))) {
      expect(readFileSync(join(relayHome, "logs", name), "utf8")).not.toContain(secret);
    }
  }, 20_000);
});

describe("relay daemon start, stop and status", () => {
  test("after kill -9, start succeeds and replaces the stale socket and pid file; status and stop work", async () => {
    const relayHome = tempRelayHome();
    const crashed = spawnDaemon(relayHome);
    await waitForDaemon(relayHome);
    crashed.kill("SIGKILL");
    await crashed.exited;
    expect(lstatSync(testSocket(relayHome)).isSocket()).toBe(true);
    expect(existsSync(pidFile(relayHome))).toBe(true);

    const started = await relay(relayHome, "start");
    const pid = Number(/^relay daemon started \(pid (\d+)\)\n$/.exec(started.stdout)?.[1]);
    detached.add(pid);
    expect(started).toEqual({ code: 0, stdout: `relay daemon started (pid ${pid})\n`, stderr: "" });
    expect(pid).not.toBe(crashed.pid);
    expect(JSON.parse(readFileSync(pidFile(relayHome), "utf8")).pid).toBe(pid);
    expect((await waitForDaemon(relayHome)).pid).toBe(pid);

    expect(await relay(relayHome, "start")).toEqual({ code: 0, stdout: `relay daemon is already running (pid ${pid})\n`, stderr: "" });
    const status = await relay(relayHome, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(
      new RegExp(
        `^Running   pid ${pid} · version \\S+ · started \\d\\d:\\d\\d\\n` +
          `Socket    ${testSocket(relayHome)}\\n` +
          `Log       ${join(relayHome, "logs", "daemon.log")}\\n$`,
      ),
    );

    // The daemon leads its own session and process group, so closing the terminal does not reach it.
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
    expect(group).toBe(String(pid));

    expect(await relay(relayHome, "stop")).toEqual({ code: 0, stdout: "relay daemon stopped\n", stderr: "" });
    expect(alive(pid)).toBe(false);
    expect(existsSync(testSocket(relayHome))).toBe(false);
    expect(existsSync(pidFile(relayHome))).toBe(false);
    expect(await relay(relayHome, "status")).toEqual({ code: 10, stdout: "relay daemon is not running\n", stderr: "" });
    expect(await relay(relayHome, "stop")).toEqual({ code: 0, stdout: "relay daemon is not running\n", stderr: "" });
  }, 30_000);

  test("status exits 10 and stop exits 0 when no daemon ever ran", async () => {
    const relayHome = tempRelayHome();
    expect(await relay(relayHome, "status")).toEqual({ code: 10, stdout: "relay daemon is not running\n", stderr: "" });
    expect(await relay(relayHome, "stop")).toEqual({ code: 0, stdout: "relay daemon is not running\n", stderr: "" });
    expect(existsSync(join(relayHome, "run"))).toBe(false);
  }, 20_000);

  test("restart stops the running daemon and starts a new one", async () => {
    const relayHome = tempRelayHome();
    const child = spawnDaemon(relayHome);
    await waitForDaemon(relayHome);
    const restarted = await relay(relayHome, "restart");
    const pid = Number(/relay daemon started \(pid (\d+)\)/.exec(restarted.stdout)?.[1]);
    detached.add(pid);
    expect(restarted).toEqual({ code: 0, stdout: `relay daemon stopped\nrelay daemon started (pid ${pid})\n`, stderr: "" });
    expect(await child.exited).toBe(0);
    expect(await relay(relayHome, "stop")).toMatchObject({ code: 0, stdout: "relay daemon stopped\n" });
  }, 30_000);

  test("status and stop trust nothing in a runtime directory that is not private", async () => {
    const relayHome = tempRelayHome();
    const dir = join(relayHome, "run");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);
    const expected = {
      code: 1,
      stdout: "",
      stderr: `relay will not use ${dir}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}\n`,
    };
    expect(await relay(relayHome, "status")).toEqual(expected);
    expect(await relay(relayHome, "stop")).toEqual(expected);
  }, 20_000);

  test("start reports a daemon that refuses to start, with exit code 10", async () => {
    const relayHome = tempRelayHome();
    mkdirSync(join(relayHome, "run"), { mode: 0o700 });
    chmodSync(join(relayHome, "run"), 0o755);
    expect(await relay(relayHome, "start")).toEqual({
      code: 10,
      stdout: "",
      stderr: `relay could not start its background service. Details are in ${join(relayHome, "logs", "daemon.log")}.\n`,
    });
    expect(readFileSync(join(relayHome, "logs", "daemon.stderr.log"), "utf8")).toContain("must be private");
  }, 20_000);

  test("stop refuses, and signals nothing, when the pid file names another process", async () => {
    const relayHome = tempRelayHome();
    const child = spawnDaemon(relayHome);
    const version = await waitForDaemon(relayHome);
    const sleeper = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      writeFileSync(pidFile(relayHome), JSON.stringify({ ...version, pid: sleeper.pid, version: version.daemon_version, socket: testSocket(relayHome) }));
      expect(await relay(relayHome, "stop")).toEqual({
        code: 1,
        stdout: "",
        stderr: "relay found a pid file that does not match the running daemon. Run relay daemon status.\n",
      });
      expect(alive(sleeper.pid)).toBe(true);
      expect(alive(child.pid)).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
    expect(await stopDaemon(child)).toBe(0);
  }, 20_000);

  test("stop signals nothing when a process holds the lock but does not answer", async () => {
    const relayHome = tempRelayHome();
    mkdirSync(join(relayHome, "run"), { mode: 0o700 });
    const holder = Bun.spawn([process.execPath, LOCK_CHILD, join(relayHome, "run", "daemon.lock")], { stdout: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
      writeFileSync(
        pidFile(relayHome),
        JSON.stringify({ pid: holder.pid, started_at: new Date().toISOString(), version: "0.0.0", socket: testSocket(relayHome) }),
      );
      const expected = `relay daemon (pid ${holder.pid}) is not responding. Stop it with: kill ${holder.pid}\n`;
      expect(await relay(relayHome, "stop")).toEqual({ code: 1, stdout: "", stderr: expected });
      expect(await relay(relayHome, "status")).toEqual({ code: 1, stdout: "", stderr: expected });
      expect(alive(holder.pid)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 20_000);
});
