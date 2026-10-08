import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openLog, reasonOf, type Logger } from "../../src/core/log";
import { makeRelayHome } from "../helpers/home";

const LEADING_KEYS = ["ts", "level", "msg", "pid", "invocation", "version"];

function setUp(options: { maxBytes?: number; keep?: number; failures?: string[] } = {}) {
  const relayHome = makeRelayHome();
  const failures = options.failures ?? [];
  const log = openLog({
    relayHome,
    file: "cli.log",
    level: "info",
    version: "0.1.0",
    invocation: "0a1b2c3d",
    maxBytes: options.maxBytes,
    keep: options.keep,
    onFailure: (file, reason) => failures.push(`${file}: ${reason}`),
  });
  const read = () => readFileSync(log.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { relayHome, log, read, failures };
}

// Opens a logger on a relay folder that a test has prepared, and collects its failures.
function openPrepared(relayHome: string, file = "cli.log") {
  const failures: string[] = [];
  const log = openLog({
    relayHome,
    file,
    level: "info",
    version: "0.1.0",
    invocation: "0a1b2c3d",
    onFailure: (_, reason) => failures.push(reason),
  });
  return { log, failures };
}

describe("openLog", () => {
  test("every line is one JSON object that starts with the six keys", () => {
    const { log, read } = setUp();
    log.info("command started", { command: "status", options: ["message"], arguments: 0 });
    log.warn("settings invalid", { path: "/x/config.toml", problems: 2 });
    log.error("unexpected error", { error_name: "TypeError", stack: null, exists: true });
    const text = readFileSync(log.file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const entries = read();
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(Object.keys(entry).slice(0, 6)).toEqual(LEADING_KEYS);
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(["debug", "info", "warn", "error"]).toContain(entry.level);
      expect(entry.msg.length).toBeGreaterThan(0);
      expect(entry.pid).toBe(process.pid);
      expect(entry.invocation).toMatch(/^[0-9a-f]{8}$/);
      expect(entry.version).toBe("0.1.0");
    }
    expect(entries[0]).toMatchObject({ level: "info", command: "status", options: ["message"], arguments: 0 });
    expect(entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  });

  test("the time comes from now() in UTC with milliseconds", () => {
    const relayHome = makeRelayHome();
    const log = openLog({
      relayHome,
      file: "cli.log",
      level: "info",
      version: "0.1.0",
      invocation: "0a1b2c3d",
      onFailure: () => {},
      now: () => new Date(Date.UTC(2026, 9, 8, 7, 5, 3, 9)),
    });
    log.info("command started");
    expect(JSON.parse(readFileSync(log.file, "utf8")).ts).toBe("2026-10-08T07:05:03.009Z");
  });

  test("characters that do not print are written as escapes and read back unchanged", () => {
    const { log, read } = setUp();
    const value = ["a", "\u001b[31m", "\u009b", "\u202e", "\u2028", "b"].join("");
    log.info("x", { path: value });
    const text = readFileSync(log.file, "utf8");
    expect(text.trimEnd()).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(read()[0]!.path).toBe(value);
  });

  test("fields cannot replace the six leading keys", () => {
    const { log, read } = setUp();
    log.info("command started", { level: "error", pid: 1, version: "9", command: "status" });
    expect(read()[0]).toMatchObject({ level: "info", pid: process.pid, version: "0.1.0", command: "status" });
  });

  test("levels filter in the order debug, info, warn, error", () => {
    const { log, read } = setUp();
    const writeAll = () => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    };
    writeAll();
    log.setLevel("warn");
    writeAll();
    log.setLevel("debug");
    writeAll();
    log.setLevel("error");
    writeAll();
    expect(read().map((entry) => entry.msg)).toEqual(["i", "w", "e", "w", "e", "d", "i", "w", "e", "e"]);
  });

  test("logs/ has mode 0700 and the file has mode 0600, also under umask 0o002", () => {
    const previous = process.umask(0o002);
    try {
      const { relayHome, log } = setUp();
      expect(statSync(join(relayHome, "logs")).mode & 0o777).toBe(0o700);
      log.info("x");
      expect(statSync(log.file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  test("logs/ has mode 0700 and the file mode 0600 under umask 0o277, over several writes", () => {
    const relayHome = makeRelayHome();
    const previous = process.umask(0o277);
    try {
      const { log, failures } = openPrepared(relayHome);
      for (const msg of ["a", "b", "c"]) log.info(msg);
      expect(failures).toEqual([]);
      expect(statSync(join(relayHome, "logs")).mode & 0o777).toBe(0o700);
      expect(statSync(log.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(log.file, "utf8").trim().split("\n")).toHaveLength(3);
    } finally {
      process.umask(previous);
    }
  });

  test("an existing log file with a loose mode is set to 0600", () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    writeFileSync(join(relayHome, "logs", "cli.log"), "");
    chmodSync(join(relayHome, "logs", "cli.log"), 0o644);
    const { log, failures } = openPrepared(relayHome);
    log.info("x");
    expect(failures).toEqual([]);
    expect(statSync(log.file).mode & 0o777).toBe(0o600);
  });

  test("rotation with maxBytes 200 and keep 5 keeps .1 to .5 and never creates .6", () => {
    const { relayHome, log } = setUp({ maxBytes: 200, keep: 5 });
    for (let i = 0; i < 40; i++) log.info("entry", { i });
    const names = readdirSync(join(relayHome, "logs")).sort();
    expect(names).toEqual(["cli.log", "cli.log.1", "cli.log.2", "cli.log.3", "cli.log.4", "cli.log.5"]);
    for (const name of names) {
      const path = join(relayHome, "logs", name);
      expect(statSync(path).size).toBeLessThanOrEqual(200);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // Each file holds the entries after the ones in the next older file.
    const first = (name: string) => JSON.parse(readFileSync(join(relayHome, "logs", name), "utf8").split("\n")[0]!).i;
    expect(first("cli.log.5")).toBeLessThan(first("cli.log.4"));
    expect(first("cli.log.1")).toBeLessThan(first("cli.log"));
    expect(readFileSync(log.file, "utf8")).toContain('"i":39}');
  });

  test("a full 10 MB log moves to .1 and the new file holds only the new entry", () => {
    const { relayHome, log, read } = setUp();
    const dir = join(relayHome, "logs");
    writeFileSync(log.file, "a".repeat(10_485_700), { mode: 0o600 });
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(`${log.file}.${n}`, `old ${n}\n`, { mode: 0o600 });
    log.info("command finished", { exit_code: 69, padding: "x".repeat(10) });
    expect(statSync(`${log.file}.1`).size).toBe(10_485_700);
    expect(readFileSync(`${log.file}.2`, "utf8")).toBe("old 1\n");
    expect(readFileSync(`${log.file}.5`, "utf8")).toBe("old 4\n");
    expect(existsSync(`${log.file}.6`)).toBe(false);
    expect(read().map((entry) => entry.msg)).toEqual(["command finished"]);
    expect(readdirSync(dir)).toHaveLength(6);
  });

  test("an entry that still fits does not rotate", () => {
    const { log } = setUp({ maxBytes: 10_000 });
    log.info("a");
    log.info("b");
    expect(existsSync(`${log.file}.1`)).toBe(false);
  });

  test("a failing write calls onFailure once and later writes do nothing", () => {
    const failures: string[] = [];
    const { relayHome, log } = setUp({ failures });
    const dir = join(relayHome, "logs");
    chmodSync(dir, 0o500);
    try {
      log.info("first");
      log.warn("second");
      chmodSync(dir, 0o700);
      log.error("third");
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(failures).toEqual([`${log.file}: EACCES: permission denied`]);
    expect(existsSync(log.file)).toBe(false);
  });

  test("a logs folder that cannot be created calls onFailure once", () => {
    const failures: string[] = [];
    const relayHome = makeRelayHome();
    chmodSync(relayHome, 0o500);
    try {
      const log = openLog({
        relayHome,
        file: "hook.log",
        level: "info",
        version: "0.1.0",
        invocation: "0a1b2c3d",
        onFailure: (file, reason) => failures.push(`${file}: ${reason}`),
      });
      log.info("hook ignored: not built yet");
    } finally {
      chmodSync(relayHome, 0o700);
    }
    expect(failures).toEqual([`${join(relayHome, "logs", "hook.log")}: EACCES: permission denied`]);
    expect(existsSync(join(relayHome, "logs"))).toBe(false);
  });

  test("a full log with a loose mode is set to 0600 before it is rotated", () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    const file = join(relayHome, "logs", "cli.log");
    writeFileSync(file, "a".repeat(300));
    chmodSync(file, 0o644);
    const failures: string[] = [];
    const log = openLog({
      relayHome,
      file: "cli.log",
      level: "info",
      version: "0.1.0",
      invocation: "0a1b2c3d",
      maxBytes: 200,
      onFailure: (_, reason) => failures.push(reason),
    });
    log.info("x");
    expect(failures).toEqual([]);
    expect(statSync(`${file}.1`).size).toBe(300);
    expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test.each([
    [0o500, "the logs folder has mode 0500, not 0700"],
    [0o755, "the logs folder has mode 0755, not 0700"],
  ])("an existing logs folder with mode %o is refused and kept", (mode, reason) => {
    const relayHome = makeRelayHome();
    const dir = join(relayHome, "logs");
    mkdirSync(dir);
    chmodSync(dir, mode);
    try {
      const { log, failures } = openPrepared(relayHome);
      log.info("x");
      expect(failures).toEqual([reason]);
      expect(log.writing).toBe(false);
      expect(statSync(dir).mode & 0o777).toBe(mode);
      expect(existsSync(log.file)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a symbolic link in place of logs/ is refused and its target is not written", () => {
    const relayHome = makeRelayHome();
    const target = makeRelayHome();
    chmodSync(target, 0o700);
    symlinkSync(target, join(relayHome, "logs"));
    const { log, failures } = openPrepared(relayHome);
    log.info("x");
    expect(failures).toEqual(["the logs folder is a symbolic link"]);
    expect(readdirSync(target)).toEqual([]);
  });

  test("a file in place of logs/ is refused", () => {
    const relayHome = makeRelayHome();
    writeFileSync(join(relayHome, "logs"), "");
    const { failures } = openPrepared(relayHome);
    expect(failures).toEqual(["logs is not a folder"]);
  });

  test("a symbolic link in place of the log file is refused and its target is unchanged", () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    const target = join(makeRelayHome(), "other.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(relayHome, "logs", "cli.log"));
    const { log, failures } = openPrepared(relayHome);
    log.info("x");
    log.info("y");
    expect(failures).toEqual(["it is not a regular file"]);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(log.file).isSymbolicLink()).toBe(true);
  });

  test("a named pipe without a reader in place of the log file fails at once", () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    const fifo = join(relayHome, "logs", "hook.log");
    expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
    const { log, failures } = openPrepared(relayHome, "hook.log");
    log.info("x");
    log.info("y");
    expect(failures).toEqual(["it is not a regular file"]);
  });

  test("reasonOf removes the system call and the path", () => {
    const withPath = Object.assign(new Error("EACCES: permission denied, open '/x/logs/cli.log'"), { code: "EACCES" });
    expect(reasonOf(withPath)).toBe("EACCES: permission denied");
    expect(reasonOf(new Error("ENOSPC: no space left on device, write"))).toBe("ENOSPC: no space left on device");
    expect(reasonOf(new Error("the logs folder is a symbolic link"))).toBe("the logs folder is a symbolic link");
  });

  test("several processes that rotate the same file at once report no failure", async () => {
    const relayHome = makeRelayHome();
    const script = `
      const { openLog } = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "core", "log.ts"))});
      const log = openLog({
        relayHome: ${JSON.stringify(relayHome)}, file: "cli.log", level: "info", version: "0.1.0",
        invocation: "0a1b2c3d", maxBytes: 300, keep: 3,
        onFailure: (file, reason) => console.error("failure: " + reason),
      });
      for (let i = 0; i < 400; i++) log.info("entry", { i });
    `;
    // Created first, so that no writer finds logs/ half made.
    openPrepared(relayHome);
    const writers = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      writers.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ code: 0, stderr: "" })));
    expect(existsSync(join(relayHome, "logs", "cli.log.4"))).toBe(false);
  }, 20_000);
});

// Never called: these lines only exist for `bun run typecheck`, which fails if an object field
// is accepted.
function typeChecks(log: Logger): void {
  // @ts-expect-error a nested object is not a log value
  log.info("x", { settings: { level: "info" } });
  // @ts-expect-error the environment is not a log value
  log.info("x", { env: process.env });
  // @ts-expect-error an array of numbers is not a log value
  log.info("x", { counts: [1, 2] });
}
