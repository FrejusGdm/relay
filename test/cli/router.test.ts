import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands/registry";
import { route } from "../../src/cli/router";
import { runRelayInProcess } from "../helpers/cli";

const golden = (name: string) => readFileSync(join(import.meta.dir, "golden", `${name}.txt`), "utf8");
const notBuilt = (name: string) =>
  `relay: ${name} is not built yet. This version only reads your settings and shows help.\n`;

describe("Command set", () => {
  test("relay providers is handled as the providers command", async () => {
    const result = await runRelayInProcess(["providers"]);
    expect(result).toEqual({ code: 69, stdout: "", stderr: notBuilt("providers") });
  });

  test("the sixteen commands and help are recognized", () => {
    for (const name of [...COMMANDS.map((def) => def.name), "help"]) {
      const result = route([name], COMMANDS);
      expect(result.kind === "usage-error" && result.lines[0]!.includes("is not a relay command")).toBe(false);
    }
    expect(COMMANDS).toHaveLength(16);
  });

  test("an unknown command is a usage error", async () => {
    const result = await runRelayInProcess(["sw1tch", "codex:personal"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: "sw1tch" is not a relay command.\nRun "relay --help" to see the commands.\n',
    });
  });
});

describe("Top-level help", () => {
  test("relay with no arguments prints the top-level help", async () => {
    const result = await runRelayInProcess([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith("relay keeps your coding work moving between agents and accounts.")).toBe(true);
    expect(result.stdout.split("\n")).toContain("  switch              Hand the job to another agent or account");
    expect(result.stdout).toBe(golden("top-help"));
  });

  test.each([["--help"], ["-h"], ["help"]])("relay %s prints the same help", async (arg) => {
    expect(await runRelayInProcess([arg])).toEqual({ code: 0, stdout: golden("top-help"), stderr: "" });
  });
});

describe("Command help", () => {
  test("relay switch --help", async () => {
    const result = await runRelayInProcess(["switch", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  relay switch <provider[:account]>\n");
    expect(result.stdout).toContain("  relay switch codex:personal\n");
  });

  test.each([[["switch", "-h"]], [["help", "switch"]], [["switch", "a", "b", "--fast", "--help"]]])(
    "relay %p prints the switch help",
    async (args) => {
      expect(await runRelayInProcess(args)).toEqual({ code: 0, stdout: golden("switch"), stderr: "" });
    },
  );

  test("help wins over a bad option", async () => {
    expect(await runRelayInProcess(["checkpoint", "--fast", "--help"])).toEqual({
      code: 0,
      stdout: golden("checkpoint"),
      stderr: "",
    });
  });

  test("help for an unknown command", async () => {
    const result = await runRelayInProcess(["help", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.split("\n")[0]).toBe('relay: "nope" is not a relay command.');
  });
});

describe("Version", () => {
  test("relay --version", async () => {
    expect(await runRelayInProcess(["--version"])).toEqual({ code: 0, stdout: "relay 0.1.0\n", stderr: "" });
  });
});

describe("Option checking", () => {
  test.each([
    [
      ["switch", "codex:personal", "--fast"],
      'relay: unknown option "--fast" for switch.\nRun "relay switch --help" to see its options.\n',
    ],
    [
      ["checkpoint", "--message"],
      'relay: option "--message" needs a value.\nRun "relay checkpoint --help" to see its options.\n',
    ],
    [
      ["checkpoint", "-m", "--log-level", "debug"],
      'relay: option "-m" needs a value.\nRun "relay checkpoint --help" to see its options.\n',
    ],
    [
      ["doctor", "--reindex=yes"],
      'relay: option "--reindex" does not take a value.\nRun "relay doctor --help" to see its options.\n',
    ],
    [
      ["status", "--log-level", "loud"],
      'relay: --log-level must be debug, info, warn or error, not "loud".\nRun "relay status --help" to see its options.\n',
    ],
    [
      ["--log-level", "debug", "status"],
      'relay: unknown option "--log-level".\nRun "relay --help" to see the commands.\n',
    ],
  ])("relay %p", async (args, stderr) => {
    expect(await runRelayInProcess(args)).toEqual({ code: 2, stdout: "", stderr });
  });

  test("own options, --log-level and positionals are parsed", () => {
    const result = route(["checkpoint", "-m", "secret plan", "--log-level", "debug"], COMMANDS);
    expect(result).toMatchObject({
      kind: "run",
      positionals: [],
      optionNames: ["message"],
      values: { message: "secret plan" },
      logLevelFlag: "debug",
    });
  });
});

describe("Argument count checking", () => {
  test("a missing argument", async () => {
    expect(await runRelayInProcess(["switch"])).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: switch needs <provider[:account]>.\nRun "relay switch --help" for an example.\n',
    });
  });

  test("three arguments for account are accepted", async () => {
    expect(await runRelayInProcess(["account", "status", "codex", "work"])).toEqual({
      code: 21,
      stdout: "",
      stderr: "codex:work is not one of your accounts. See relay account list.\n",
    });
  });

  test("too many arguments", async () => {
    expect(await runRelayInProcess(["status", "extra"])).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: too many arguments for status: "extra".\nRun "relay status --help" for an example.\n',
    });
  });

  const EXPECTED: Record<string, [number, number]> = {
    init: [0, 0], run: [0, 1], checkpoint: [0, 0], checkpoints: [0, 0], rollback: [0, 1],
    "accept-git-changes": [0, 0], switch: [1, 1], status: [0, 0], account: [1, 3], providers: [0, 0],
    policy: [2, 2], hooks: [2, 2], hook: [2, 2], statusline: [1, 1], daemon: [1, 1], doctor: [0, 0],
  };
  const args = (count: number) => Array.from({ length: count }, (_, i) => `arg${i + 1}`);

  test.each(COMMANDS.map((def) => [def.name, def] as const))("%s accepts only its argument counts", (name, def) => {
    const [min, max] = EXPECTED[name]!;
    expect([def.minArgs, def.maxArgs]).toEqual([min, max]);
    expect(route([name, ...args(min)], COMMANDS).kind).toBe("run");
    expect(route([name, ...args(max)], COMMANDS).kind).toBe("run");
    expect(route([name, ...args(max + 1)], COMMANDS)).toMatchObject({ kind: "usage-error", quiet: name === "hook" });
    if (min > 0) {
      expect(route([name, ...args(min - 1)], COMMANDS)).toMatchObject({ kind: "usage-error", quiet: name === "hook" });
    }
  });
});

describe("Output streams", () => {
  test("a repeated value cannot send a terminal control sequence", async () => {
    const result = await runRelayInProcess(["\u001b[31m\u009b31m"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toMatch(/[\u001b\u009b]/);
    expect(result.stderr.split("\n")[0]).toBe('relay: "\\u001b[31m\\u009b31m" is not a relay command.');
  });

  test("a usage error writes only to standard error, and every line starts with relay: or Run", async () => {
    const result = await runRelayInProcess(["rollback", "1", "2"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    for (const line of result.stderr.trimEnd().split("\n")) {
      expect(line.startsWith("relay: ") || line.startsWith('Run "relay')).toBe(true);
    }
  });
});

describe("Unexpected error", () => {
  test("a command that throws exits 70 with the two-line message", async () => {
    const commands = COMMANDS.map((def) =>
      def.name === "status"
        ? { ...def, handler: async () => { throw new TypeError("x is undefined"); } }
        : def,
    );
    const relayHome = join(process.env.HOME!, "relay-home-for-error");
    const result = await runRelayInProcess(["status"], { commands, relayHome });
    expect(result).toEqual({
      code: 70,
      stdout: "",
      stderr: `relay: unexpected error: x is undefined\nDetails are in ${join(relayHome, "logs", "cli.log")}.\n`,
    });
  });
});

describe("Review findings", () => {
  test.each(["--constructor", "--toString", "--__proto__", "--hasOwnProperty"])(
    "%s is an unknown option, not a crash",
    async (option) => {
      expect(await runRelayInProcess(["switch", "codex:personal", option])).toEqual({
        code: 2,
        stdout: "",
        stderr: `relay: unknown option "${option}" for switch.\nRun "relay switch --help" to see its options.\n`,
      });
      expect(await runRelayInProcess(["hook", "claude", "Stop", option])).toEqual({ code: 0, stdout: "", stderr: "" });
    },
  );

  test("echoed values are quoted as JSON strings", async () => {
    const newline = await runRelayInProcess(["sw\nitch"]);
    expect(newline.stderr).toBe('relay: "sw\\nitch" is not a relay command.\nRun "relay --help" to see the commands.\n');
    const escape = await runRelayInProcess(["status", "\u001b[31mred"]);
    expect(escape.stderr).toBe(
      'relay: too many arguments for status: "\\u001b[31mred".\nRun "relay status --help" for an example.\n',
    );
    const option = await runRelayInProcess(["status", "--x\u001b]0;title\u0007"]);
    expect(option.stderr).toContain('relay: unknown option "--x\\u001b]0;title\\u0007" for status.');
    for (const result of [newline, escape, option]) expect(result.stderr).not.toContain("\u001b");
  });

  test("the option without a value is the one blamed", async () => {
    expect(await runRelayInProcess(["init", "--title=-draft", "--log-level"])).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: option "--log-level" needs a value.\nRun "relay init --help" to see its options.\n',
    });
  });

  test("a value that starts with a dash gets a hint", async () => {
    expect(await runRelayInProcess(["checkpoint", "-m", "-fixed typo"])).toEqual({
      code: 2,
      stdout: "",
      stderr:
        'relay: option "-m" needs a value.\n' +
        'relay: to give a value that starts with "-", write "--message=-fixed typo".\n' +
        'Run "relay checkpoint --help" to see its options.\n',
    });
    expect((await runRelayInProcess(["checkpoint", "-m", "-h"])).stdout).toBe(golden("checkpoint"));
    expect((await runRelayInProcess(["checkpoint", "-m", "--log-level=debug"])).stderr).toBe(
      'relay: option "-m" needs a value.\nRun "relay checkpoint --help" to see its options.\n',
    );
    expect(route(["checkpoint", "-m", "-"], COMMANDS)).toMatchObject({ kind: "run", values: { message: "-" } });
    expect(route(["checkpoint", "--message=-fixed typo"], COMMANDS)).toMatchObject({
      kind: "run",
      values: { message: "-fixed typo" },
    });
  });

  test("an option marked multiple gives a list of every value", () => {
    expect(route(["checkpoint", "--include", ".env.local", "--include=id_rsa", "--json"], COMMANDS)).toMatchObject({
      kind: "run",
      optionNames: ["include", "json"],
      values: { include: [".env.local", "id_rsa"], json: true },
    });
  });

  test.each([["--help"], ["-h"]])("relay help %s prints the top-level help", async (arg) => {
    expect(await runRelayInProcess(["help", arg])).toEqual({ code: 0, stdout: golden("top-help"), stderr: "" });
  });
});
