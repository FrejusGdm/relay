import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deleteOldWorkerLogs, startHeadless, startInteractive } from "../../src/adapters/process";
import type { HeadlessOptions } from "../../src/adapters/process";
import { setClock } from "../../src/platform/clock";
import { stdinKind } from "../fakes/record";

const CHILD = resolve(import.meta.dir, "..", "helpers", "child.ts");
const PROCESS_MODULE = resolve(import.meta.dir, "..", "..", "src", "adapters", "process.ts");
const env = () => ({ ...process.env }) as Record<string, string>;

function folder(): string {
  return mkdtempSync(join(process.env.HOME!, "process-"));
}

function start(args: string[], input: HeadlessOptions["input"], options: Partial<HeadlessOptions> = {}) {
  const cwd = folder();
  const lines: { stream: "out" | "err"; line: string }[] = [];
  const logPath = join(cwd, "relay-home", "logs", "workers", "job-worker.log");
  const started = startHeadless({
    path: process.execPath, args: [CHILD, ...args], cwd, env: env(), input, logPath,
    onLine: (stream, line) => lines.push({ stream, line }), ...options,
  });
  return { cwd, lines, logPath, started };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("The condition did not become true in time.");
    await Bun.sleep(10);
  }
}

test("a child that prints 50 MB is drained to the end and the log, mode 0600, holds every line", async () => {
  let out = 0;
  let err = 0;
  let last = "";
  const { logPath, started } = start(["--print-mb", "50"], "eof", {
    onLine: (stream, line) => {
      if (stream === "out") { out++; last = line; } else err++;
    },
  });
  const agent = await started;
  expect(await agent.exited).toEqual({ code: 0, signal: null });
  expect(out).toBe(50 * 1024 + 1);
  expect(err).toBe(100);
  expect(last).toBe("done");
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(logPath, "..")).mode & 0o777).toBe(0o700);
  const log = readFileSync(logPath, "utf8");
  expect(log.split("\n").filter((line) => line.startsWith("out ")).length).toBe(50 * 1024 + 1);
  expect(log.split("\n").filter((line) => line.startsWith("err ")).length).toBe(100);
  expect(log).toContain(`out ${"51199 ".padEnd(1023, "x")}\n`);
  expect(log).toContain("out done\n");
}, 60_000);

test("input mode pipe gives the child a pipe that relay writes and then closes", async () => {
  const { cwd, lines, started } = start(["--report", "report.json", "--wait"], "pipe");
  const agent = await started;
  expect(agent.pid).toBeGreaterThan(0);
  await waitFor(() => lines.some(({ line }) => line === "ready"));
  expect(JSON.parse(readFileSync(join(cwd, "report.json"), "utf8"))).toEqual({ stdin: "pipe" });
  await agent.write("hello\n");
  await waitFor(() => lines.some(({ line }) => line === "got hello"));
  agent.closeInput();
  expect(await agent.exited).toEqual({ code: 0, signal: null });
  await expect(agent.write("late\n")).rejects.toThrow("The agent's input is closed.");
}, 10_000);

test("input mode eof gives the child end of file at once", async () => {
  const { cwd, started } = start(["--report", "report.json", "--wait"], "eof");
  const agent = await started;
  expect(await agent.exited).toEqual({ code: 0, signal: null });
  expect(JSON.parse(readFileSync(join(cwd, "report.json"), "utf8"))).toEqual({ stdin: "eof" });
}, 10_000);

test("a line written in two pieces is passed on once, and a last line without a newline is kept", async () => {
  const { lines, logPath, started } = start(["--split", "--partial", "tail"], "eof");
  const agent = await started;
  await agent.exited;
  expect(lines).toEqual([{ stream: "out", line: '{"type":"assistant","n":1}' }, { stream: "out", line: "tail" }]);
  expect(readFileSync(logPath, "utf8")).toBe('out {"type":"assistant","n":1}\nout tail\n');
}, 10_000);

test("signals go through the held child, and nothing is sent once it has exited", async () => {
  const { lines, started } = start(["--wait"], "pipe");
  const agent = await started;
  await waitFor(() => lines.some(({ line }) => line === "ready"));
  expect(agent.running()).toBe(true);
  expect(agent.signal("SIGINT")).toBe(true);
  expect(await agent.exited).toEqual({ code: 130, signal: null });
  expect(lines.at(-1)).toEqual({ stream: "out", line: "interrupted" });
  expect(agent.running()).toBe(false);
  expect(agent.signal("SIGTERM")).toBe(false);
  expect(agent.signal("SIGKILL")).toBe(false);
}, 10_000);

test("a headless child runs in its own process group", async () => {
  const cwd = folder();
  const groups: string[] = [];
  const agent = await startHeadless({
    path: "/bin/sh", args: ["-c", "ps -o pgid= -p $$; ps -o pgid= -p $PPID"], cwd, env: env(), input: "eof",
    logPath: join(cwd, "worker.log"), onLine: (_stream, line) => groups.push(line.trim()),
  });
  expect((await agent.exited).code).toBe(0);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toBe(String(agent.pid));
  expect(groups[0]).not.toBe(groups[1]);
}, 10_000);

test("a program that cannot start is reported", async () => {
  const cwd = folder();
  await expect(startHeadless({
    path: join(cwd, "missing-program"), args: [], cwd, env: env(), input: "eof", logPath: join(cwd, "worker.log"), onLine: () => {},
  })).rejects.toThrow();
});

test("a worker log in a linked folder, of another kind or open to others is refused or made private", async () => {
  const cwd = folder();
  const options = (logPath: string): HeadlessOptions => ({
    path: process.execPath, args: [CHILD], cwd, env: env(), input: "eof", logPath, onLine: () => {},
  });
  symlinkSync(folder(), join(cwd, "linked"));
  await expect(startHeadless(options(join(cwd, "linked", "worker.log")))).rejects.toThrow("is not safe to use");
  expect(Bun.spawnSync(["mkfifo", join(cwd, "pipe.log")]).exitCode).toBe(0);
  await expect(startHeadless(options(join(cwd, "pipe.log")))).rejects.toThrow();
  const open = join(cwd, "open");
  mkdirSync(open, { mode: 0o777 });
  chmodSync(open, 0o777);
  await (await startHeadless(options(join(open, "worker.log")))).exited;
  expect(statSync(open).mode & 0o777).toBe(0o700);
}, 10_000);

test("an interactive child inherits the terminal while relay ignores SIGINT and SIGQUIT", async () => {
  const cwd = folder();
  const report = join(cwd, "report.json");
  const once = () => {};
  process.once("SIGQUIT", once);
  const before = { SIGINT: process.rawListeners("SIGINT"), SIGQUIT: process.rawListeners("SIGQUIT") };
  const agent = startInteractive({ path: process.execPath, args: [CHILD, "--report", report, "--sleep", "300"], cwd, env: env() });
  for (const name of ["SIGINT", "SIGQUIT"] as const) {
    const listeners = process.listeners(name);
    expect(listeners).toHaveLength(1);
    expect(before[name]).not.toContain(listeners[0]!);
  }
  expect(await agent.exited).toEqual({ code: 0, signal: null });
  expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ stdin: stdinKind() });
  // The handler added with once is still a one-time handler.
  expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
  expect(process.rawListeners("SIGQUIT")).toEqual(before.SIGQUIT);
  process.removeListener("SIGQUIT", once);
  expect(agent.signal("SIGTERM")).toBe(false);
}, 10_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a child still running when relay exits is stopped", async () => {
  const cwd = folder();
  const script = join(cwd, "exit.ts");
  writeFileSync(script, [
    `import { startHeadless } from ${JSON.stringify(PROCESS_MODULE)};`,
    `const agent = await startHeadless({ path: process.execPath, args: [${JSON.stringify(CHILD)}, "--wait"], cwd: ${JSON.stringify(cwd)},`,
    `  env: process.env, input: "pipe", logPath: ${JSON.stringify(join(cwd, "worker.log"))}, onLine: () => {} });`,
    "console.log(agent.pid);",
    "process.exit(0);",
  ].join("\n"));
  const relay = Bun.spawn([process.execPath, script], { cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  const pid = Number((await new Response(relay.stdout).text()).trim());
  expect(await relay.exited).toBe(0);
  expect(pid).toBeGreaterThan(0);
  await waitFor(() => !alive(pid));
}, 10_000);

// src/cli/main.ts ends relay on SIGHUP the same way; the script below does the same.
test("when a closed terminal ends relay, the agent and the programs it started are stopped", async () => {
  const cwd = folder();
  const script = join(cwd, "hangup.ts");
  const pids = join(cwd, "pids.txt");
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `import { startHeadless } from ${JSON.stringify(PROCESS_MODULE)};`,
    `process.on("SIGHUP", () => process.exit(143));`,
    `let sleepPid = "";`,
    `const agent = await startHeadless({ path: "/bin/sh", args: ["-c", "sleep 60 & echo $!; wait"], cwd: ${JSON.stringify(cwd)},`,
    `  env: process.env, input: "eof", logPath: ${JSON.stringify(join(cwd, "worker.log"))}, onLine: (_stream, line) => { sleepPid = line; } });`,
    `setInterval(() => { if (sleepPid !== "") writeFileSync(${JSON.stringify(pids)}, agent.pid + " " + sleepPid); }, 10);`,
  ].join("\n"));
  const relay = Bun.spawn([process.execPath, script], { cwd, env: env(), stdout: "ignore", stderr: "pipe" });
  await waitFor(() => existsSync(pids) && /^[1-9]\d* \d+$/.test(readFileSync(pids, "utf8")));
  const [agentPid, sleepPid] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
  expect(alive(agentPid) && alive(sleepPid)).toBe(true);
  relay.kill("SIGHUP");
  expect(await relay.exited).toBe(143);
  await waitFor(() => !alive(agentPid) && !alive(sleepPid));
}, 10_000);

test("old worker logs are not deleted through a linked logs or workers folder", () => {
  const day = 24 * 60 * 60 * 1000;
  const elsewhere = folder();
  const victim = join(elsewhere, "3f9a2c1d-5d2e8f01.log");
  writeFileSync(victim, "keep me\n");
  utimesSync(victim, new Date(Date.now() - 30 * day), new Date(Date.now() - 30 * day));
  const linkedWorkers = folder();
  mkdirSync(join(linkedWorkers, "logs"));
  symlinkSync(elsewhere, join(linkedWorkers, "logs", "workers"));
  deleteOldWorkerLogs(linkedWorkers);
  const linkedLogs = folder();
  mkdirSync(join(elsewhere, "workers"));
  const victimInWorkers = join(elsewhere, "workers", "3f9a2c1d-5d2e8f01.log");
  writeFileSync(victimInWorkers, "keep me\n");
  utimesSync(victimInWorkers, new Date(Date.now() - 30 * day), new Date(Date.now() - 30 * day));
  symlinkSync(elsewhere, join(linkedLogs, "logs"));
  deleteOldWorkerLogs(linkedLogs);
  expect(existsSync(victim)).toBe(true);
  expect(existsSync(victimInWorkers)).toBe(true);
});

test("worker logs last changed more than 14 days ago are deleted", () => {
  const relayHome = folder();
  const logs = join(relayHome, "logs", "workers");
  mkdirSync(logs, { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  const age = (name: string, days: number) => {
    const path = join(logs, name);
    writeFileSync(path, "out line\n");
    const time = new Date(Date.now() - days * day);
    utimesSync(path, time, time);
    return path;
  };
  const old = age("3f9a2c1d-5d2e8f01.log", 15);
  const recent = age("3f9a2c1d-0a1b2c3d.log", 13);
  const other = age("notes.txt", 30);
  const folderInside = join(logs, "folder");
  mkdirSync(folderInside);
  utimesSync(folderInside, new Date(Date.now() - 20 * day), new Date(Date.now() - 20 * day));
  symlinkSync(recent, join(logs, "aaaaaaaa-bbbbbbbb.log"));
  deleteOldWorkerLogs(relayHome);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(other)).toBe(true);
  expect(existsSync(folderInside)).toBe(true);
  setClock(() => new Date(Date.now() + 2 * day));
  try {
    deleteOldWorkerLogs(relayHome);
  } finally {
    setClock(null);
  }
  expect(existsSync(recent)).toBe(false);
  deleteOldWorkerLogs(join(relayHome, "missing"));
});
