import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands/registry";
import { runRelay, runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const notBuilt = (name: string) =>
  `relay: ${name} is not built yet. This version only reads your settings and shows help.\n`;
const argsFor = (count: number) => Array.from({ length: count }, (_, i) => `arg${i + 1}`);
const BROKEN = "version = = 1\n";
const missingRelayHome = () => join(makeRelayHome(), "missing");

describe("Commands that are not built yet", () => {
  // Every command except hook reads the settings first; relay init, relay checkpoint, relay
  // checkpoints, relay rollback, relay accept-git-changes, relay account, relay providers and
  // relay policy are built.
  const readSettings = COMMANDS.filter((def) => def.name !== "hook");
  const unbuilt = readSettings.filter((def) => !def.built);

  test("there are seven of them", () => {
    expect(unbuilt).toHaveLength(7);
  });

  test.each(unbuilt.map((def) => [def.name, def.minArgs] as const))(
    "relay %s with valid settings exits 69",
    async (name, minArgs) => {
      const relayHome = makeRelayHome('[accounts."claude:personal"]\n');
      expect(await runRelayInProcess([name, ...argsFor(minArgs)], { relayHome })).toEqual({
        code: 69,
        stdout: "",
        stderr: notBuilt(name),
      });
    },
  );

  test.each(readSettings.map((def) => [def.name, def.minArgs] as const))(
    "relay %s with broken settings exits 78",
    async (name, minArgs) => {
      const relayHome = makeRelayHome(BROKEN);
      const result = await runRelayInProcess([name, ...argsFor(minArgs)], { relayHome });
      expect(result.code).toBe(78);
      expect(result.stdout).toBe("");
      expect(result.stderr.startsWith(`relay: cannot read ${join(relayHome, "config.toml")}: `)).toBe(true);
    },
  );

  test("settings with problems print the problem report", async () => {
    const relayHome = makeRelayHome('colour = "blue"\n');
    expect(await runRelayInProcess(["status"], { relayHome })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: ${join(relayHome, "config.toml")} has 1 problem:\n  colour: unknown setting.\nThe settings are described in docs/config.md.\n`,
    });
  });

  test.each([[["status"]], [["status", "--log-level", "debug"]]])("an invalid RELAY_LOG_LEVEL fails relay %p", async (args) => {
    expect(await runRelayInProcess(args, { env: { RELAY_LOG_LEVEL: "loud" } })).toEqual({
      code: 78,
      stdout: "",
      stderr: 'relay: RELAY_LOG_LEVEL must be debug, info, warn or error, not "loud".\n',
    });
  });

  test("a credential in the settings is refused and never printed", async () => {
    const value = ["sk", "ant", "test", "123"].join("-");
    const relayHome = makeRelayHome(`[accounts."claude:personal"]\napi_key = "${value}"\n`);
    const result = await runRelay(["status"], { env: { RELAY_HOME: relayHome } });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(
      `accounts."claude:personal".api_key: relay never stores credentials. Remove this key and sign in with the provider's own login command.`,
    );
    expect(result.stderr + result.stdout).not.toContain(value);
    for (const name of readdirSync(relayHome, { recursive: true }) as string[]) {
      const path = join(relayHome, name);
      if (name !== "config.toml" && statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain(value);
    }
  });
});

describe("Help, version and usage errors touch nothing", () => {
  test.each([[["--help"]], [["status", "--help"]], [["help", "run"]], [["--version"]], [["status", "extra"]], [["nope"]]])(
    "relay %p leaves a missing relay folder missing",
    async (args) => {
      const relayHome = missingRelayHome();
      await runRelayInProcess(args, { relayHome });
      expect(existsSync(relayHome)).toBe(false);
    },
  );

  test("help works with broken settings", async () => {
    const relayHome = makeRelayHome(BROKEN, 0o666);
    const result = await runRelayInProcess(["run", "--help"], { relayHome });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  relay run [<provider[:account]>]\n");
    expect(result.stderr).toBe("");
  });

  test("help works with a relative RELAY_HOME", async () => {
    expect((await runRelayInProcess(["--help"], { relayHome: "relay-home" })).code).toBe(0);
  });
});

describe("Relay folder safety", () => {
  test("the first run creates the folder with mode 0700 and no settings file", async () => {
    const relayHome = missingRelayHome();
    expect((await runRelay(["status"], { env: { RELAY_HOME: relayHome } })).code).toBe(69);
    expect(statSync(relayHome).mode & 0o777).toBe(0o700);
    expect(existsSync(join(relayHome, "config.toml"))).toBe(false);
  });

  test("a folder others can change is refused", async () => {
    const relayHome = makeRelayHome();
    chmodSync(relayHome, 0o777);
    expect(await runRelayInProcess(["status"], { relayHome })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: other users can change ${relayHome}. Run "chmod 700 ${relayHome}" and try again.\n`,
    });
  });

  test("a folder owned by someone else is refused", async () => {
    const relayHome = makeRelayHome();
    expect(await runRelayInProcess(["status"], { relayHome, uid: process.getuid!() + 1 })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: ${relayHome} belongs to another user. relay only uses a folder you own.\n`,
    });
  });

  test("a folder the person cannot open is refused with exit 78", async () => {
    const relayHome = makeRelayHome("version = 1\n");
    chmodSync(relayHome, 0o600);
    try {
      expect(await runRelayInProcess(["status"], { relayHome })).toEqual({
        code: 78,
        stdout: "",
        stderr: `relay: you cannot read, write and open ${relayHome}. Run "chmod 700 ${relayHome}" and try again.\n`,
      });
    } finally {
      chmodSync(relayHome, 0o700);
    }
  });

  test("a relative RELAY_HOME is refused", async () => {
    expect(await runRelayInProcess(["status"], { relayHome: "relay-home" })).toEqual({
      code: 78,
      stdout: "",
      stderr: 'relay: RELAY_HOME must be an absolute path, not "relay-home".\n',
    });
  });

  test("a settings file others can change is refused", async () => {
    const relayHome = makeRelayHome("version = 1\n", 0o666);
    const file = join(relayHome, "config.toml");
    expect(await runRelayInProcess(["status"], { relayHome })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: other users can change ${file}. Run "chmod 600 ${file}" and try again.\n`,
    });
  });
});

describe("relay hook stays silent", () => {
  test.each([
    ["broken settings", () => makeRelayHome(BROKEN)],
    ["a settings file others can change", () => makeRelayHome("version = 1\n", 0o666)],
    ["a relative RELAY_HOME", () => "relay-home"],
  ])("with %s", async (_, relayHome) => {
    const input = new Uint8Array(1024 * 1024).fill(0x61);
    expect(await runRelay(["hook", "claude", "Stop"], { env: { RELAY_HOME: relayHome() }, stdin: input })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });
});
