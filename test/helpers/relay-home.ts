// Relay folders for tests that open the daemon's socket, and a test daemon in such a folder.
// A socket path may have at most 103 bytes on macOS, and the folders from makeRelayHome sit two
// levels deeper, so these come straight from the system's temporary folder (design.md
// decision 22). Each test file calls removeTempRelayHomes in an afterAll hook, which also kills
// any test daemon still running.
import type { Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN } from "./cli";

const created: string[] = [];
const daemons = new Set<Subprocess>();

export function tempRelayHome(): string {
  const path = mkdtempSync(join(tmpdir(), "relay-test-"));
  created.push(path);
  return path;
}

export function removeTempRelayHomes(): void {
  for (const child of daemons) child.kill("SIGKILL");
  daemons.clear();
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function testSocket(relayHome: string): string {
  return join(relayHome, "run", "relay.sock");
}

// Starts `relay daemon run` in the foreground as a child of the test.
export function spawnDaemon(relayHome: string, env: Record<string, string> = {}): Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "daemon", "run"], {
    env: { ...process.env, RELAY_HOME: relayHome, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  daemons.add(child);
  void child.exited.then(() => daemons.delete(child));
  return child;
}

// GET /v1/version from the daemon in relayHome, retried until it answers or timeoutMs passes.
export async function waitForDaemon(relayHome: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch("http://relay/v1/version", { unix: testSocket(relayHome) });
      if (response.status === 200) return (await response.json()) as Record<string, unknown>;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`no daemon answered in ${relayHome}`);
    await Bun.sleep(25);
  }
}

// Sends SIGTERM to a test daemon and returns its exit code.
export async function stopDaemon(child: Subprocess): Promise<number | null> {
  child.kill("SIGTERM");
  return child.exited;
}

// Stops the daemon that a relay command started in relayHome (relay run and relay switch start one
// when RELAY_TEST_START_DAEMON=1), found through its pid file, and waits until it is gone. Only a
// process whose command line is relay's daemon is signalled.
export async function stopStartedDaemon(relayHome: string): Promise<void> {
  let pid: number;
  try {
    pid = (JSON.parse(readFileSync(join(relayHome, "run", "daemon.pid"), "utf8")) as { pid: number }).pid;
  } catch {
    return;
  }
  const isDaemon = () =>
    Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().includes("daemon run");
  if (!isDaemon()) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 45_000;
  while (isDaemon() && Date.now() < deadline) await Bun.sleep(50);
  if (isDaemon()) process.kill(pid, "SIGKILL");
}
