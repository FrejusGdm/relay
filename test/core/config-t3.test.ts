import { describe, expect, test } from "bun:test";
import { emptyConfig, validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";
import { runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const ctx = { relayHome: "/r", homedir: "/Users/josue" };
const validate = (text: string) => {
  const { config, problems } = validateConfig(parseToml(text), ctx);
  return { config, problems: problems.map(({ key, message }) => `${key}: ${message}`) };
};
const accounts = '\n[accounts."claude:personal"]\n[accounts."codex:personal"]\n';

describe("T3 settings", () => {
  test.each([
    ['[t3]\nurl = "http://192.168.1.20:3773/mcp"',
      "t3.url: relay only connects to T3 Code on this computer (127.0.0.1 or localhost)."],
    ['[t3.instances.codex]\naccount = "codex:work"',
      't3.instances.codex.account: "codex:work" is not one of your accounts.'],
  ])("the CLI reports a settings problem with exit code 78: %s", async (text, problem) => {
    const result = await runRelayInProcess(["status"], { relayHome: makeRelayHome(text) });
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`  ${problem}\n`);
  });

  test("the default address and empty lists do not require a t3 table", () => {
    const expected = { url: "http://127.0.0.1:3773/mcp", projects: [], instances: [] };
    expect(emptyConfig("/r").t3).toEqual(expected);
    expect(validate("").config.t3).toEqual(expected);
  });

  test("local addresses, folders and instance mappings are accepted", () => {
    const { config, problems } = validate(`[t3]
url = "http://localhost:4000/mcp"
projects = ["~/projects/relay/", "/work/./app"]
[t3.instances.Claude_1]
account = "claude:personal"
[t3.instances.codex]
account = "codex:personal"
model = "gpt-6.1-sol"
${accounts}`);
    expect(problems).toEqual([]);
    expect(config.t3).toEqual({
      url: "http://localhost:4000/mcp",
      projects: ["/Users/josue/projects/relay", "/work/app"],
      instances: [
        { id: "Claude_1", account: "claude:personal", model: null },
        { id: "codex", account: "codex:personal", model: "gpt-6.1-sol" },
      ],
    });
  });

  test.each(["http://192.168.1.20:3773/mcp", "https://192.168.1.20/wrong", "http://[::1]:3773/mcp"])(
    "a network address is refused first: %s", (url) => {
      expect(validate(`[t3]\nurl = "${url}"`).problems).toEqual([
        "t3.url: relay only connects to T3 Code on this computer (127.0.0.1 or localhost).",
      ]);
    },
  );

  test.each(["not a URL", "https://localhost:3773/mcp", "http://localhost:3773/ws"])(
    "an invalid local address is refused: %s", (url) => {
      expect(validate(`[t3]\nurl = "${url}"`).problems).toEqual([
        "t3.url: must look like http://127.0.0.1:3773/mcp.",
      ]);
    },
  );

  test("an unknown account in an instance", () => {
    expect(validate('[t3.instances.codex]\naccount = "codex:work"').problems).toEqual([
      't3.instances.codex.account: "codex:work" is not one of your accounts.',
    ]);
  });

  test("folders are normalized before checking duplicates", () => {
    expect(validate('[t3]\nprojects = ["~/projects/relay/", "/Users/josue/projects/./relay"]').problems).toEqual([
      "t3.projects[2]: the same path as t3.projects[1].",
    ]);
  });

  test.each(["_bad", "bad.id", "a".repeat(65)])("a bad instance ID: %s", (id) => {
    expect(validate(`[t3.instances."${id}"]\naccount = "claude:personal"${accounts}`).problems).toEqual([
      `t3.instances.${id.includes(".") ? `"${id}"` : id}: T3 provider instance IDs use letters, digits, "_" and "-".`,
    ]);
  });

  test("two instances cannot name one account", () => {
    expect(validate(`[t3.instances.first]\naccount = "claude:personal"
[t3.instances.second]\naccount = "claude:personal"${accounts}`).problems).toEqual([
      "t3.instances.second.account: the same account as t3.instances.first.",
    ]);
  });

  test.each(["3", '""', '"   "'])("model = %s must be a non-empty string", (value) => {
    expect(validate(`[t3.instances.codex]\naccount = "codex:personal"\nmodel = ${value}${accounts}`).problems).toEqual([
      "t3.instances.codex.model: must be a string.",
    ]);
  });

  test("wrong types and missing required settings", () => {
    expect(validate("t3 = 3").problems).toEqual(["t3: must be a table."]);
    expect(validate("[t3]\nurl = 3\nprojects = 3\ninstances = 3").problems).toEqual([
      "t3.url: must be a string.", "t3.projects: must be a list of folders.", "t3.instances: must be a table.",
    ]);
    expect(validate('[t3]\nprojects = [3, "relative"]\n[t3.instances.codex]').problems).toEqual([
      "t3.projects[1]: must be a string.", "t3.projects[2]: must be an absolute path or start with ~/.",
      "t3.instances.codex.account: is required.",
    ]);
    expect(validate("[t3.instances]\ncodex = 3").problems).toEqual(["t3.instances.codex: must be a table."]);
    expect(validate("[t3.instances.codex]\naccount = 3").problems).toEqual(["t3.instances.codex.account: must be a string."]);
    expect(validate('[t3.instances.codex]\naccount = "BAD"').problems).toEqual([
      't3.instances.codex.account: account names look like provider:name in lowercase, for example "claude:personal".',
    ]);
  });

  test("unknown keys use the existing credential checks and file order", () => {
    expect(validate(`[t3]\nconstructor = 3\ntoken = "hidden"
[t3.instances.codex]\naccount = "codex:personal"\ncolour = "hidden"${accounts}`).problems).toEqual([
      "t3.constructor: unknown setting.",
      "t3.token: relay never stores credentials. Remove this key and sign in with the provider's own login command.",
      "t3.instances.codex.colour: unknown setting.",
    ]);
  });
});
