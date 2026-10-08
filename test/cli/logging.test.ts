import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { COMMANDS } from "../../src/cli/commands/registry";
import { policyText } from "../../src/cli/commands/policy";
import { policyOf } from "../../src/policies/load";
import { runRelay, runRelayInProcess, UNBUILT, WITH_UNBUILT } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const ONE_ACCOUNT = '[accounts."claude:personal"]\n';
const notBuilt = (name: string) =>
  `relay: ${name} is not built yet. This version only reads your settings and shows help.\n`;

// A value that looks like a credential, built at run time so that none is committed.
const planted = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function entries(relayHome: string, file = "cli.log"): Record<string, unknown>[] {
  const path = join(relayHome, "logs", file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// The text of every file under logs/, so that a test can search all of them at once.
function allLogs(relayHome: string): string {
  const dir = join(relayHome, "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
}

function snapshot(relayHome: string): Record<string, string> {
  const dir = join(relayHome, "logs");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

const messages = (relayHome: string, file?: string) => entries(relayHome, file).map((entry) => entry.msg);

// Tests that start relay as its own process cannot pass a test-only command. They use relay policy
// show claude, a built command that only prints fixed text.
const POLICY = ["policy", "show", "claude"];
const policyOutput = () => policyText(policyOf("claude")).map((line) => `${line}\n`).join("");

describe("Log file locations", () => {
  test("the first command creates logs/ with mode 0700 and cli.log with mode 0600", async () => {
    const relayHome = makeRelayHome();
    expect((await runRelay(POLICY, { env: { RELAY_HOME: relayHome } })).code).toBe(0);
    expect(statSync(join(relayHome, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(relayHome, "logs", "cli.log")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(relayHome, "logs"))).toEqual(["cli.log"]);
  });

  test("relay hook writes hook.log and not cli.log", async () => {
    const relayHome = makeRelayHome();
    expect(await runRelay(["hook", "claude", "Stop"], { env: { RELAY_HOME: relayHome }, stdin: "{}" })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(readdirSync(join(relayHome, "logs"))).toEqual(["hook.log"]);
    expect(statSync(join(relayHome, "logs", "hook.log")).mode & 0o777).toBe(0o600);
    expect(entries(relayHome, "hook.log")).toContainEqual(
      expect.objectContaining({ msg: "hook ignored: not built yet", provider: "claude", event: "Stop" }),
    );
  });

  test.each([[["providers", "--help"]], [["help", "providers"]], [["--help"]], [["--version"]], [["providers", "extra"]], [["nope"]]])(
    "relay %p creates and changes no log file",
    async (args) => {
      const empty = makeRelayHome();
      await runRelayInProcess(args, { relayHome: empty });
      expect(existsSync(join(empty, "logs"))).toBe(false);

      const used = makeRelayHome();
      await runRelayInProcess(["providers"], { relayHome: used });
      const before = snapshot(used);
      await runRelayInProcess(args, { relayHome: used });
      expect(snapshot(used)).toEqual(before);
    },
  );

  test("a hook usage error goes to hook.log with the number of arguments", async () => {
    const relayHome = makeRelayHome();
    const value = planted("sk-ant");
    expect(await runRelay(["hook", value], { env: { RELAY_HOME: relayHome } })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(entries(relayHome, "hook.log")).toEqual([expect.objectContaining({ level: "info", msg: "hook usage error", arguments: 1 })]);
    expect(existsSync(join(relayHome, "logs", "cli.log"))).toBe(false);
    expect(allLogs(relayHome)).not.toContain(value);
  });
});

describe("hook usage error level", () => {
  test('log.level = "warn" in valid settings hides the hook usage error entry', async () => {
    const relayHome = makeRelayHome('[log]\nlevel = "warn"\n');
    expect(await runRelayInProcess(["hook", "claude"], { relayHome })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(join(relayHome, "logs", "hook.log"))).toBe(false);
  });

  test("RELAY_LOG_LEVEL wins over log.level", async () => {
    const relayHome = makeRelayHome('[log]\nlevel = "warn"\n');
    await runRelayInProcess(["hook", "claude"], { relayHome, env: { RELAY_LOG_LEVEL: "info" } });
    expect(messages(relayHome, "hook.log")).toEqual(["hook usage error"]);
  });

  test("broken settings fall back to info and print nothing", async () => {
    const relayHome = makeRelayHome("version = = 1\n");
    expect(await runRelayInProcess(["hook", "claude"], { relayHome })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(messages(relayHome, "hook.log")).toEqual(["hook usage error"]);
  });
});

describe("Line format", () => {
  test("every line parses as JSON with the six leading keys", async () => {
    const relayHome = makeRelayHome(ONE_ACCOUNT);
    await runRelay(["providers"], { env: { RELAY_HOME: relayHome } });
    // A folder outside any repository, so relay checkpoint stops before it saves anything.
    await runRelay(["checkpoint", "-m", "x"], { env: { RELAY_HOME: relayHome }, cwd: relayHome });
    const all = entries(relayHome);
    expect(all).toHaveLength(6);
    for (const entry of all) {
      expect(Object.keys(entry).slice(0, 6)).toEqual(["ts", "level", "msg", "pid", "invocation", "version"]);
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(["debug", "info", "warn", "error"]).toContain(entry.level as string);
      expect((entry.msg as string).length).toBeGreaterThan(0);
      expect(typeof entry.pid).toBe("number");
      expect(entry.invocation).toMatch(/^[0-9a-f]{8}$/);
      expect(entry.version).toBe(pkg.version);
    }
    const runs = [all.slice(0, 3), all.slice(3)];
    for (const run of runs) expect(new Set(run.map((entry) => entry.invocation)).size).toBe(1);
    expect(runs[0]![0]!.invocation).not.toBe(runs[1]![0]!.invocation);
    expect(readFileSync(join(relayHome, "logs", "cli.log"), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("Command events", () => {
  test('relay checkpoint -m "secret plan" logs the option name and not its value', async () => {
    const relayHome = makeRelayHome(ONE_ACCOUNT);
    const result = await runRelay(["checkpoint", "-m", "secret plan"], { env: { RELAY_HOME: relayHome }, cwd: relayHome });
    expect(result.code).toBe(3);
    const all = entries(relayHome);
    expect(all.map((entry) => entry.msg)).toEqual(["command started", "settings loaded", "command finished"]);
    expect(all[0]).toMatchObject({ level: "info", command: "checkpoint", options: ["message"], arguments: 0 });
    expect(all[1]).toMatchObject({
      level: "info",
      path: join(relayHome, "config.toml"),
      exists: true,
      accounts: 1,
      projects: 0,
    });
    expect(all[2]).toMatchObject({ level: "info", exit_code: 3 });
    expect(typeof all[2]!.duration_ms).toBe("number");
    const text = readFileSync(join(relayHome, "logs", "cli.log"), "utf8");
    expect(text).toContain('"options":["message"]');
    expect(text).not.toContain("secret plan");
  });

  test("missing settings are logged with exists false", async () => {
    const relayHome = makeRelayHome();
    await runRelayInProcess([UNBUILT, "codex:personal"], { relayHome, commands: WITH_UNBUILT });
    expect(entries(relayHome)).toEqual([
      expect.objectContaining({ msg: "command started", command: UNBUILT, options: [], arguments: 1 }),
      expect.objectContaining({ msg: "settings loaded", exists: false, accounts: 0, projects: 0 }),
      expect.objectContaining({ msg: "command finished", exit_code: 69 }),
    ]);
  });

  test("settings with problems are logged as a count at level warn", async () => {
    const relayHome = makeRelayHome('colour = "blue"\n[log]\nlevel = "loud"\n');
    expect((await runRelayInProcess(["providers"], { relayHome })).code).toBe(78);
    expect(entries(relayHome)).toEqual([
      expect.objectContaining({ level: "info", msg: "command started", command: "providers" }),
      expect.objectContaining({
        level: "warn",
        msg: "settings invalid",
        path: join(relayHome, "config.toml"),
        problems: 2,
      }),
      expect.objectContaining({ level: "info", msg: "command finished", exit_code: 78 }),
    ]);
    expect(allLogs(relayHome)).not.toContain("blue");
    expect(allLogs(relayHome)).not.toContain("loud");
  });

  test("an invalid RELAY_LOG_LEVEL is logged as invalid settings without its value", async () => {
    const relayHome = makeRelayHome();
    const value = planted("level");
    expect((await runRelayInProcess(["providers"], { relayHome, env: { RELAY_LOG_LEVEL: value } })).code).toBe(78);
    expect(messages(relayHome)).toEqual(["command started", "settings invalid", "command finished"]);
    expect(entries(relayHome)[1]).toMatchObject({ problems: 1 });
    expect(allLogs(relayHome)).not.toContain(value);
  });

  test("an invalid RELAY_LOG_LEVEL is a settings error even with --log-level", async () => {
    const relayHome = makeRelayHome();
    const result = await runRelayInProcess(["providers", "--log-level", "debug"], { relayHome, env: { RELAY_LOG_LEVEL: "loud" } });
    expect(result.code).toBe(78);
    expect(messages(relayHome)).toEqual(["command started", "settings invalid", "command finished"]);
  });

  test("relay hook with broken settings logs them in hook.log and stays silent", async () => {
    const relayHome = makeRelayHome("version = = 1\n");
    expect(await runRelay(["hook", "claude", "Stop"], { env: { RELAY_HOME: relayHome } })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(entries(relayHome, "hook.log")).toEqual([
      expect.objectContaining({ msg: "command started", command: "hook", arguments: 2 }),
      expect.objectContaining({ msg: "settings invalid", problems: 1 }),
      expect.objectContaining({ msg: "command finished", exit_code: 0 }),
    ]);
  });
});

describe("Unexpected errors are logged", () => {
  test("a thrown TypeError is logged with its name and stack frames, without its message", async () => {
    const commands = COMMANDS.map((def) =>
      def.name === "providers"
        ? { ...def, handler: async () => { throw new TypeError("x is undefined"); } }
        : def,
    );
    const relayHome = makeRelayHome();
    const result = await runRelayInProcess(["providers"], { commands, relayHome });
    const file = join(relayHome, "logs", "cli.log");
    expect(result).toEqual({
      code: 70,
      stdout: "",
      stderr: `relay: unexpected error: x is undefined\nDetails are in ${file}.\n`,
    });
    const error = entries(relayHome).find((entry) => entry.msg === "unexpected error");
    expect(error).toMatchObject({ level: "error", error_name: "TypeError" });
    expect(Object.hasOwn(error!, "error_message")).toBe(false);
    expect(error!.stack).toMatch(/^\s+at /);
    expect(allLogs(relayHome)).not.toContain("x is undefined");
    expect(entries(relayHome).at(-1)).toMatchObject({ msg: "command finished", exit_code: 70 });
  });

  test("a planted value in an error message, also on several lines, never reaches the log", async () => {
    const value = planted("sk-ant");
    const commands = COMMANDS.map((def) =>
      def.name === "providers"
        ? { ...def, handler: async () => { throw new Error(`failed: ${value}\n    at ${value}`); } }
        : def,
    );
    const relayHome = makeRelayHome();
    const result = await runRelayInProcess(["providers"], { commands, relayHome });
    expect(result.code).toBe(70);
    expect(result.stderr).toContain(value);
    expect(messages(relayHome)).toContain("unexpected error");
    expect(allLogs(relayHome)).not.toContain(value);
  });

  test("without a working log, the error message does not point to a log file", async () => {
    const commands = COMMANDS.map((def) =>
      def.name === "providers" ? { ...def, handler: async () => { throw new TypeError("x is undefined"); } } : def,
    );
    const relayHome = makeRelayHome();
    writeFileSync(join(relayHome, "logs"), "", { mode: 0o600 });
    const file = join(relayHome, "logs", "cli.log");
    expect(await runRelayInProcess(["providers"], { commands, relayHome })).toEqual({
      code: 70,
      stdout: "",
      stderr: `relay: could not write to the log ${file}: logs is not a folder. Continuing without it.\nrelay: unexpected error: x is undefined\n`,
    });
  });

  test("relay hook logs a thrown error and stays silent", async () => {
    const commands = COMMANDS.map((def) =>
      def.name === "hook" ? { ...def, handler: async () => { throw new RangeError("too far"); } } : def,
    );
    const relayHome = makeRelayHome();
    expect(await runRelayInProcess(["hook", "claude", "Stop"], { commands, relayHome })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(entries(relayHome, "hook.log")).toContainEqual(
      expect.objectContaining({ level: "error", msg: "unexpected error", error_name: "RangeError" }),
    );
  });
});

describe("Log levels", () => {
  test('log.level = "warn" hides command started', async () => {
    const relayHome = makeRelayHome('[log]\nlevel = "warn"\n');
    expect((await runRelayInProcess([UNBUILT], { relayHome, commands: WITH_UNBUILT })).code).toBe(69);
    expect(messages(relayHome)).not.toContain("command started");
    expect(messages(relayHome)).toEqual([]);
  });

  test('--log-level debug wins over log.level = "warn"', async () => {
    const relayHome = makeRelayHome('[log]\nlevel = "warn"\n');
    await runRelayInProcess(["providers", "--log-level", "debug"], { relayHome });
    expect(messages(relayHome)).toEqual(["command started", "settings loaded", "command finished"]);
  });

  test("RELAY_LOG_LEVEL=warn still logs invalid settings", async () => {
    const relayHome = makeRelayHome('colour = "blue"\n');
    await runRelayInProcess(["providers"], { relayHome, env: { RELAY_LOG_LEVEL: "warn" } });
    expect(messages(relayHome)).toEqual(["settings invalid"]);
  });
});

describe("What logs never contain", () => {
  test("planted credentials in the environment never reach a log", async () => {
    const relayHome = makeRelayHome(ONE_ACCOUNT);
    const secrets = {
      ANTHROPIC_API_KEY: planted("sk-ant"),
      OPENAI_API_KEY: planted("sk"),
      CLAUDE_CODE_OAUTH_TOKEN: planted("oauth"),
      SOME_TOKEN: planted("token"),
    };
    const env = { RELAY_HOME: relayHome, ...secrets };
    await runRelay(["providers"], { env });
    await runRelay(POLICY, { env });
    await runRelay(["hook", "claude", "Stop"], { env, stdin: "{}" });
    await runRelay(["providers", "--log-level", "debug"], { env });
    const text = allLogs(relayHome);
    expect(messages(relayHome)).toHaveLength(9);
    expect(messages(relayHome, "hook.log")).toHaveLength(4);
    for (const [name, value] of Object.entries(secrets)) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(name);
    }
  });

  test("planted values in arguments, options, settings and standard input never reach a log", async () => {
    const relayHome = makeRelayHome(ONE_ACCOUNT);
    const env = { RELAY_HOME: relayHome };
    const value = planted("sk-ant");
    // relay init and relay checkpoint run outside any repository, so they change nothing.
    await runRelay(["checkpoint", "-m", value], { env, cwd: relayHome });
    await runRelay(["checkpoint", `--message=${value}`], { env, cwd: relayHome });
    await runRelay(["init", "--title", value], { env, cwd: relayHome });
    await runRelay(["switch", value], { env });
    await runRelay(["rollback", value], { env });
    await runRelay(["hook", value, value], { env, stdin: value });
    await runRelay(["hook", "claude", value], { env, stdin: value });
    await runRelay(["hook", value], { env, stdin: value });

    const badSettings = makeRelayHome(
      `[accounts."claude:personal"]\napi_key = "${value}"\n[[projects]]\npath = "/tmp/${value}"\nallow = ["claude:personal"]\n`,
    );
    await runRelay(["providers"], { env: { RELAY_HOME: badSettings } });
    const goodSettings = makeRelayHome(`${ONE_ACCOUNT}[[projects]]\npath = "/tmp/${value}"\nallow = ["claude:personal"]\n`);
    await runRelay(["providers"], { env: { RELAY_HOME: goodSettings } });

    expect(messages(relayHome).length).toBeGreaterThan(0);
    expect(entries(relayHome, "hook.log")).toContainEqual(
      expect.objectContaining({ msg: "hook ignored: not built yet", provider: null, event: null }),
    );
    expect(entries(relayHome, "hook.log")).toContainEqual(
      expect.objectContaining({ msg: "hook ignored: not built yet", provider: "claude", event: null }),
    );
    expect(messages(badSettings)).toContain("settings invalid");
    expect(entries(goodSettings)).toContainEqual(expect.objectContaining({ msg: "settings loaded", projects: 1 }));
    for (const home of [relayHome, badSettings, goodSettings]) expect(allLogs(home)).not.toContain(value);
  });

  test("the session ID from hook input never reaches a log", async () => {
    const relayHome = makeRelayHome();
    const sessionId = ["abc", "123"].join("-");
    const result = await runRelay(["hook", "claude", "Stop"], {
      env: { RELAY_HOME: relayHome },
      stdin: JSON.stringify({ session_id: sessionId }),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(messages(relayHome, "hook.log")).toContain("hook ignored: not built yet");
    expect(allLogs(relayHome)).not.toContain(sessionId);
  });
});

describe("Hook event names", () => {
  test.each([
    ["claude", "PreToolUse", "claude", "PreToolUse"],
    ["claude", "StopFailure", "claude", "StopFailure"],
    ["codex", "Interrupt", "codex", "Interrupt"],
    ["claude", "Interrupt", "claude", null],
    ["codex", "UserPromptSubmit", "codex", null],
    ["claude", "toString", "claude", null],
    ["toString", "Stop", null, null],
  ])("relay hook %s %s logs provider %p and event %p", async (provider, event, loggedProvider, loggedEvent) => {
    const relayHome = makeRelayHome();
    await runRelayInProcess(["hook", provider, event], { relayHome });
    expect(entries(relayHome, "hook.log")).toContainEqual(
      expect.objectContaining({ msg: "hook ignored: not built yet", provider: loggedProvider, event: loggedEvent }),
    );
  });

  test("a one-word secret passed as the event never reaches the log", async () => {
    const relayHome = makeRelayHome();
    const word = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
    await runRelayInProcess(["hook", "claude", word], { relayHome });
    expect(messages(relayHome, "hook.log")).toContain("hook ignored: not built yet");
    expect(allLogs(relayHome)).not.toContain(word);
  });
});

describe("Rotation", () => {
  test("a full cli.log moves to cli.log.1 and no cli.log.6 is created", async () => {
    const relayHome = makeRelayHome();
    const dir = join(relayHome, "logs");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "cli.log"), "a".repeat(10_485_700), { mode: 0o600 });
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(dir, `cli.log.${n}`), `old ${n}\n`, { mode: 0o600 });
    expect((await runRelayInProcess([UNBUILT], { relayHome, commands: WITH_UNBUILT })).code).toBe(69);
    expect(statSync(join(dir, "cli.log.1")).size).toBe(10_485_700);
    expect(readFileSync(join(dir, "cli.log.5"), "utf8")).toBe("old 4\n");
    expect(existsSync(join(dir, "cli.log.6"))).toBe(false);
    expect(messages(relayHome)).toEqual(["command started", "settings loaded", "command finished"]);
    expect(statSync(join(dir, "cli.log")).mode & 0o777).toBe(0o600);
  });
});

describe("Logging failures do not change the outcome", () => {
  const warning = (file: string, reason: string) =>
    `relay: could not write to the log ${file}: ${reason}. Continuing without it.\n`;

  test("a read-only logs folder prints the warning once and the command still succeeds", async () => {
    const relayHome = makeRelayHome(ONE_ACCOUNT);
    const dir = join(relayHome, "logs");
    mkdirSync(dir, { mode: 0o500 });
    try {
      expect(await runRelay(POLICY, { env: { RELAY_HOME: relayHome } })).toEqual({
        code: 0,
        stdout: policyOutput(),
        stderr: warning(join(dir, "cli.log"), "the logs folder has mode 0500, not 0700"),
      });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(existsSync(join(dir, "cli.log"))).toBe(false);
  });

  test("a file in place of logs/ prints the warning once and exits 69", async () => {
    const relayHome = makeRelayHome();
    writeFileSync(join(relayHome, "logs"), "", { mode: 0o600 });
    const file = join(relayHome, "logs", "cli.log");
    expect(await runRelayInProcess([UNBUILT], { relayHome, commands: WITH_UNBUILT })).toEqual({
      code: 69,
      stdout: "",
      stderr: warning(file, "logs is not a folder") + notBuilt(UNBUILT),
    });
  });

  test("a named pipe in place of cli.log does not block relay", async () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    const file = join(relayHome, "logs", "cli.log");
    expect(Bun.spawnSync(["mkfifo", "-m", "600", file]).exitCode).toBe(0);
    expect(await runRelay(POLICY, { env: { RELAY_HOME: relayHome } })).toEqual({
      code: 0,
      stdout: policyOutput(),
      stderr: warning(file, "it is not a regular file"),
    });
  });

  test("relay hook with a named pipe in place of hook.log finishes in silence", async () => {
    const relayHome = makeRelayHome();
    mkdirSync(join(relayHome, "logs"), { mode: 0o700 });
    expect(Bun.spawnSync(["mkfifo", "-m", "600", join(relayHome, "logs", "hook.log")]).exitCode).toBe(0);
    expect(await runRelay(["hook", "claude", "Stop"], { env: { RELAY_HOME: relayHome }, stdin: "{}" })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("relay hook with a read-only logs folder stays silent", async () => {
    const relayHome = makeRelayHome();
    const dir = join(relayHome, "logs");
    mkdirSync(dir, { mode: 0o500 });
    try {
      expect(await runRelay(["hook", "claude", "Stop"], { env: { RELAY_HOME: relayHome }, stdin: "{}" })).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
