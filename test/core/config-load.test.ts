import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsError } from "../../src/cli/errors";
import { loadConfig } from "../../src/core/config/load";
import { resolveLogLevel } from "../../src/core/config/log-level";
import { emptyConfig } from "../../src/core/config/validate";
import { makeRelayHome } from "../helpers/home";

const uid = process.getuid!();
const homedir = "/Users/josue";
const load = (relayHome: string) => loadConfig({ relayHome, homedir, uid });

function settingsErrorLines(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SettingsError) return error.lines;
    throw error;
  }
  throw new Error("expected a SettingsError");
}

describe("loadConfig", () => {
  test("a missing file gives empty settings and creates no file", () => {
    const relayHome = makeRelayHome();
    expect(load(relayHome)).toEqual(emptyConfig(relayHome));
    expect(load(relayHome).exists).toBe(false);
    expect(readdirSync(relayHome)).toEqual([]);
  });

  test("a symbolic link to a 0644 file the person owns is read", () => {
    const relayHome = makeRelayHome();
    const dotfiles = join(makeRelayHome(), "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "relay.toml"), '[accounts."claude:personal"]\n');
    chmodSync(join(dotfiles, "relay.toml"), 0o644);
    symlinkSync(join(dotfiles, "relay.toml"), join(relayHome, "config.toml"));
    const config = load(relayHome);
    expect(config.exists).toBe(true);
    expect(config.accounts.map((account) => account.id)).toEqual(["claude:personal"]);
  });

  test("a file with mode 0666 is rejected", () => {
    const relayHome = makeRelayHome("version = 1\n", 0o666);
    const file = join(relayHome, "config.toml");
    expect(settingsErrorLines(() => load(relayHome))).toEqual([
      `relay: other users can change ${file}. Run "chmod 600 ${file}" and try again.`,
    ]);
  });

  test("a file over 1 MB is rejected", () => {
    const relayHome = makeRelayHome(`# ${"x".repeat(1_048_576)}\n`);
    const file = join(relayHome, "config.toml");
    expect(settingsErrorLines(() => load(relayHome))).toEqual([
      `relay: ${file} is larger than 1 MB, the most relay reads.`,
    ]);
  });

  test("invalid TOML gives the parser message, with short quoted pieces kept", () => {
    const relayHome = makeRelayHome("version = = 1\n");
    expect(settingsErrorLines(() => load(relayHome))).toEqual([
      `relay: cannot read ${join(relayHome, "config.toml")}: TOML Parse error: Expected a value but found '='`,
    ]);
  });

  test("a named pipe is refused without waiting for a writer", () => {
    const relayHome = makeRelayHome();
    const file = join(relayHome, "config.toml");
    expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    expect(settingsErrorLines(() => load(relayHome))).toEqual([`relay: ${file} is not a regular file.`]);
  });

  test("a relay folder the person cannot open gives a settings error, not an unexpected one", () => {
    const relayHome = makeRelayHome("version = 1\n");
    chmodSync(relayHome, 0o600);
    try {
      expect(settingsErrorLines(() => load(relayHome))).toEqual([
        `relay: cannot use ${join(relayHome, "config.toml")}: you do not have permission.`,
      ]);
    } finally {
      chmodSync(relayHome, 0o700);
    }
  });

  test("a link to a missing file is a settings error, not empty settings", () => {
    const relayHome = makeRelayHome();
    symlinkSync(join(relayHome, "missing.toml"), join(relayHome, "config.toml"));
    expect(settingsErrorLines(() => load(relayHome))).toEqual([
      `relay: cannot use ${join(relayHome, "config.toml")}: it, or the file it links to, does not exist.`,
    ]);
  });

  test("an unquoted credential is cut from the parser message", () => {
    const value = ["sk", "ant", "test", "123"].join("-");
    const relayHome = makeRelayHome(`api_key = ${value}\n`);
    expect(settingsErrorLines(() => load(relayHome))).toEqual([
      `relay: cannot read ${join(relayHome, "config.toml")}: TOML Parse error: Strings must be quoted: "..."`,
    ]);
  });

  // Bun's parser quotes the text it could not read, and that text can be a credential.
  test("a parser message never shows text from the file", () => {
    const value = ["sk", "ant", "test", "123"].join("-");
    for (const text of [`api_key = ${value}\n`, `x = [${value}]\n`, `x = "${value}\n`]) {
      const lines = settingsErrorLines(() => load(makeRelayHome(text)));
      expect(lines.join("\n")).not.toContain(value);
    }
  });
});

describe("resolveLogLevel", () => {
  const withLevel = (level: "debug" | "info" | "warn" | "error" | null) => ({
    ...emptyConfig("/r"),
    log: { level },
  });

  test("the flag wins, then RELAY_LOG_LEVEL, then log.level, then info", () => {
    expect(resolveLogLevel("debug", { RELAY_LOG_LEVEL: "error" }, withLevel("warn"))).toBe("debug");
    expect(resolveLogLevel(undefined, { RELAY_LOG_LEVEL: "error" }, withLevel("warn"))).toBe("error");
    expect(resolveLogLevel(undefined, {}, withLevel("warn"))).toBe("warn");
    expect(resolveLogLevel(undefined, { RELAY_LOG_LEVEL: "" }, withLevel("warn"))).toBe("warn");
    expect(resolveLogLevel(undefined, {}, withLevel(null))).toBe("info");
    expect(resolveLogLevel(undefined, {}, null)).toBe("info");
  });

  test.each([undefined, "debug" as const])("an invalid RELAY_LOG_LEVEL is a settings error with the flag %p", (flag) => {
    expect(settingsErrorLines(() => resolveLogLevel(flag, { RELAY_LOG_LEVEL: "loud" }, null))).toEqual([
      'relay: RELAY_LOG_LEVEL must be debug, info, warn or error, not "loud".',
    ]);
  });
});

test("reading the settings leaves the relay folder as it was", () => {
  const relayHome = makeRelayHome("version = 1\n");
  load(relayHome);
  expect(readdirSync(relayHome)).toEqual(["config.toml"]);
  expect(existsSync(join(relayHome, "logs"))).toBe(false);
});
