import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsError } from "../../src/cli/errors";
import { expandPath, resolveHomedir, resolveRelayHome } from "../../src/core/paths";
import { MAIN } from "../helpers/cli";

const HOME = "/Users/josue";

describe("resolveRelayHome", () => {
  test("defaults to $HOME/.relay", () => {
    expect(resolveRelayHome({}, HOME)).toBe("/Users/josue/.relay");
  });

  test("uses an absolute RELAY_HOME", () => {
    expect(resolveRelayHome({ RELAY_HOME: "/tmp/relay-test-1" }, HOME)).toBe("/tmp/relay-test-1");
  });

  test("expands a leading ~/", () => {
    expect(resolveRelayHome({ RELAY_HOME: "~/x" }, HOME)).toBe("/Users/josue/x");
  });

  test("treats an empty RELAY_HOME as unset", () => {
    expect(resolveRelayHome({ RELAY_HOME: "" }, HOME)).toBe("/Users/josue/.relay");
  });

  const errorOf = (value: string) => {
    try {
      resolveRelayHome({ RELAY_HOME: value }, HOME);
    } catch (error) {
      if (error instanceof SettingsError) return error.lines;
      throw error;
    }
    throw new Error("expected a SettingsError");
  };

  test.each(["relay-home", "./relay", "~relay"])("rejects the relative path %p", (value) => {
    expect(errorOf(value)).toEqual([`relay: RELAY_HOME must be an absolute path, not "${value}".`]);
  });

  test.each(["~", "~/", "~/.", "/Users/josue", "/Users/josue/", "/Users/josue/x/.."])(
    "rejects %p, which is the home folder itself",
    (value) => {
      expect(errorOf(value)).toEqual([
        `relay: RELAY_HOME cannot be your home folder itself ("${value}"). Use a folder of its own, such as ~/.relay.`,
      ]);
    },
  );

  test("escapes control characters in the value it repeats", () => {
    expect(errorOf("a\u001b[31m\u009bb")).toEqual([
      'relay: RELAY_HOME must be an absolute path, not "a\\u001b[31m\\u009bb".',
    ]);
  });
});

describe("the home folder", () => {
  test("comes from HOME, and from os.homedir() only when HOME is unset or empty", () => {
    expect(resolveHomedir({ HOME: "/home/someone" })).toBe("/home/someone");
    expect(resolveHomedir({})).toBe(homedir());
    expect(resolveHomedir({ HOME: "" })).toBe(homedir());
  });

  // A relative HOME would put the relay folder inside whatever folder relay runs in.
  test("a relative HOME is not used", () => {
    expect(resolveHomedir({ HOME: "relhome" })).toBe(homedir());
    expect(resolveHomedir({ HOME: "./relhome" })).toBe(homedir());
  });

  // Bun's os.homedir() ignores a changed HOME. relay must still use HOME, or a run with a test
  // HOME and no RELAY_HOME would reach the person's real ~/.relay.
  test("relay uses the HOME it is started with when RELAY_HOME is unset", () => {
    const home = mkdtempSync(join(dirname(process.env.RELAY_HOME!), "home-"));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name !== "RELAY_HOME" && value !== undefined) env[name] = value;
    }
    env.HOME = home;
    // relay policy show claude is a built command that only prints fixed text.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", MAIN, "policy", "show", "claude"], { env });
    expect(result.exitCode).toBe(0);
    expect(statSync(join(home, ".relay")).mode & 0o777).toBe(0o700);
  });
});

describe("expandPath", () => {
  test.each([
    ["~", "/Users/josue"],
    ["~/a/", "/Users/josue/a"],
    ["~//.relay", "/Users/josue/.relay"],
    ["~///a//b", "/Users/josue/a/b"],
    ["/a/./b/..", "/a"],
    ["/a/b/", "/a/b"],
  ])("%p becomes %p", (value, expected) => {
    expect(expandPath(value, HOME)).toBe(expected);
  });

  test.each(["a/b", "./a", "~a"])("%p is relative", (value) => {
    expect(expandPath(value, HOME)).toBeNull();
  });
});
