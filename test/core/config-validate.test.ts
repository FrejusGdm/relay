import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsError } from "../../src/cli/errors";
import { loadConfig } from "../../src/core/config/load";
import { validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";
import { makeRelayHome } from "../helpers/home";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "config");
const ctx = { relayHome: "/r", homedir: "/Users/josue" };

const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.toml`), "utf8");
const validate = (text: string) => {
  const { config, problems } = validateConfig(parseToml(text), ctx);
  return { config, problems: problems.map(({ key, message }) => `${key}: ${message}`) };
};
const problemsOf = (name: string) => validate(fixture(name)).problems;

const CREDENTIAL =
  "relay never stores credentials. Remove this key and sign in with the provider's own login command.";

describe("Known settings only", () => {
  test("a typo in a key is named without its value", () => {
    const problems = problemsOf("typo-key");
    expect(problems).toEqual(['accounts."claude:personal".profil_dir: unknown setting.']);
    expect(problems.join("\n")).not.toContain("~/x");
  });

  test("a newer file asks for a newer relay", () => {
    expect(problemsOf("newer-version")).toEqual(["version: this file is for a newer relay (version 2). Update relay."]);
  });

  test.each(['version = "1"', "version = 0", "version = 1.5"])("%s must be 1", (text) => {
    expect(validate(text).problems).toEqual(["version: must be 1."]);
  });

  test("version 1 and an empty file are accepted", () => {
    expect(validate("version = 1\n").problems).toEqual([]);
    expect(validate("").problems).toEqual([]);
  });

  test("a table setting given as a value", () => {
    expect(validate('defaults = "x"\nlog = 1\naccounts = []\nprojects = "x"\n').problems).toEqual([
      "defaults: must be a table.",
      "log: must be a table.",
      "accounts: must be a table.",
      "projects: must be a list of [[projects]] tables.",
    ]);
  });
});

describe("Keys that name built-in object properties", () => {
  const names = ["__proto__", "constructor", "toString", "__defineGetter__", "valueOf"];
  const lines = names.map((name) => `${name} = 1`).join("\n");

  test.each([
    ["an account", `[accounts."claude:personal"]\n${lines}\n`, 'accounts."claude:personal"'],
    ["[log]", `[log]\n${lines}\n`, "log"],
    ["[defaults]", `[defaults]\n${lines}\n`, "defaults"],
    ["[[projects]]", `[[projects]]\npath = "/p"\nallow = []\n${lines}\n`, "projects[1]"],
  ])("are unknown settings in %s", (_, text, key) => {
    expect(validate(text).problems).toEqual(names.map((name) => `${key}.${name}: unknown setting.`));
  });

  test("are unknown settings at the top level", () => {
    expect(validate(`${lines}\n`).problems).toEqual(names.map((name) => `${name}: unknown setting.`));
  });
});

describe("Accounts", () => {
  test("a minimal account", () => {
    const { config, problems } = validate(fixture("minimal-account"));
    expect(problems).toEqual([]);
    expect(config.accounts).toEqual([
      {
        id: "claude:personal",
        provider: "claude",
        name: "personal",
        profileDir: "/r/profiles/claude-personal",
        profileDirIsDefault: true,
        credentialEnv: [],
        kind: null,
      },
    ]);
  });

  test("a badly formed name", () => {
    expect(problemsOf("bad-account-name")).toEqual([
      'accounts."Claude:Personal": account names look like provider:name in lowercase, for example "claude:personal".',
    ]);
  });

  test("a provider relay does not support yet", () => {
    expect(problemsOf("unsupported-provider")).toEqual([
      'accounts."cursor:work": relay does not support "cursor" yet. Supported providers: claude, codex.',
    ]);
  });

  test("every account setting", () => {
    const { config, problems } = validate(
      '[accounts."codex:work"]\nprofile_dir = "/p/codex"\ncredential_env = ["OPENAI_API_KEY"]\nkind = "work"\n',
    );
    expect(problems).toEqual([]);
    expect(config.accounts[0]).toMatchObject({
      profileDir: "/p/codex",
      profileDirIsDefault: false,
      credentialEnv: ["OPENAI_API_KEY"],
      kind: "work",
    });
  });

  test("wrong types in an account", () => {
    expect(
      validate('[accounts."codex:work"]\nprofile_dir = 1\ncredential_env = "OPENAI_API_KEY"\nkind = "team"\n').problems,
    ).toEqual([
      'accounts."codex:work".profile_dir: must be a string.',
      'accounts."codex:work".credential_env: must be a list of variable names in capitals, for example "ANTHROPIC_API_KEY".',
      'accounts."codex:work".kind: must be "personal" or "work".',
    ]);
    expect(validate('[accounts]\n"codex:work" = 1\n').problems).toEqual(['accounts."codex:work": must be a table.']);
  });
});

describe("Paths in settings", () => {
  test("a home-relative path is expanded and loses its trailing slash", () => {
    const { config, problems } = validate(fixture("home-relative-path"));
    expect(problems).toEqual([]);
    expect(config.accounts[0]!.profileDir).toBe("/Users/josue/.codex");
  });

  test("a relative path is a problem", () => {
    expect(problemsOf("relative-path")).toEqual([
      'accounts."claude:personal".profile_dir: must be an absolute path or start with ~/.',
    ]);
  });

  test("a date is not a path", () => {
    expect(validate('[accounts."claude:personal"]\nprofile_dir = 1979-05-27T07:32:00Z\n').problems).toEqual([
      'accounts."claude:personal".profile_dir: must be a string.',
    ]);
  });
});

describe("One profile folder per account", () => {
  test("two accounts with the same folder", () => {
    expect(problemsOf("shared-folder")).toEqual([
      'accounts."claude:work".profile_dir: the same folder as accounts."claude:personal". Each account needs its own profile folder.',
    ]);
  });
});

describe("Credentials are refused", () => {
  // Built at run time, so that no credential-like text is committed.
  const value = ["sk", "ant", "test", "123"].join("-");

  test("an API key in an account", () => {
    const { problems } = validate(`[accounts."claude:personal"]\napi_key = "${value}"\n`);
    expect(problems).toEqual([`accounts."claude:personal".api_key: ${CREDENTIAL}`]);
    expect(problems.join("\n")).not.toContain(value);
  });

  test.each([
    [`token = "${value}"`, "token"],
    [`[defaults]\nApiKey = "${value}"`, "defaults.ApiKey"],
    [`[log]\nPASSWORD = "${value}"`, "log.PASSWORD"],
    [`[[projects]]\npath = "/p"\nallow = []\nsession_cookie = "${value}"`, "projects[1].session_cookie"],
    [`[accounts."codex:work"]\ncredentials = ["${value}"]`, 'accounts."codex:work".credentials'],
    [`client_secret = { value = "${value}" }`, "client_secret"],
  ])("%p is refused", (text, key) => {
    const { problems } = validate(text);
    expect(problems).toEqual([`${key}: ${CREDENTIAL}`]);
    expect(problems.join("\n")).not.toContain(value);
  });

  test("a credential inside an unknown table", () => {
    const { problems } = validate(`[extra]\nnested = { github_token = "${value}" }\n`);
    expect(problems).toEqual(["extra: unknown setting.", `extra.nested.github_token: ${CREDENTIAL}`]);
  });

  test("credential_env holds names, and a value placed there is not shown", () => {
    expect(validate('[accounts."claude:personal"]\ncredential_env = ["ANTHROPIC_API_KEY"]\n').problems).toEqual([]);
    const { problems } = validate(`[accounts."claude:personal"]\ncredential_env = ["${value}"]\n`);
    expect(problems.join("\n")).not.toContain(value);
  });

  test("credential_env names only variables of the account's own provider", () => {
    expect(validate('[accounts."codex:work"]\ncredential_env = ["OPENAI_API_KEY", "CODEX_API_KEY"]\n').problems).toEqual([]);
    expect(validate('[accounts."claude:work"]\ncredential_env = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]\n').problems).toEqual([
      'accounts."claude:work".credential_env: OPENAI_API_KEY is not allowed: claude accounts may only receive ANTHROPIC_ names or CLAUDE_CODE_OAUTH_TOKEN.',
    ]);
    expect(validate('[accounts."codex:work"]\ncredential_env = ["CODEX_HOME"]\n').problems).toEqual([
      'accounts."codex:work".credential_env: CODEX_HOME is not allowed: codex accounts may only receive OPENAI_ names, or CODEX_ names other than CODEX_HOME, CODEX_THREAD_ID and CODEX_SANDBOX names.',
    ]);
  });

  test("a value placed in an allow list or defaults.account is not shown", () => {
    const { problems } = validate(`[defaults]\naccount = "${value}"\n\n[[projects]]\npath = "/p"\nallow = ["${value}"]\n`);
    expect(problems).toEqual([
      'defaults.account: account names look like provider:name in lowercase, for example "claude:personal".',
      'projects[1].allow: account names look like provider:name in lowercase, for example "claude:personal".',
    ]);
  });
});

describe("Project allow lists", () => {
  test("an account that is not defined", () => {
    expect(problemsOf("unknown-allow")).toEqual(['projects[1].allow: "codex:work" is not one of your accounts.']);
  });

  test("a missing path", () => {
    expect(problemsOf("missing-path")).toEqual(["projects[1].path: is required."]);
  });

  test("a missing allow list", () => {
    expect(validate('[[projects]]\npath = "/p"\n').problems).toEqual(["projects[1].allow: is required."]);
  });

  test("an empty allow list allows no account", () => {
    const { config, problems } = validate(fixture("empty-allow"));
    expect(problems).toEqual([]);
    expect(config.projects).toEqual([{ path: "/work/app", allow: [] }]);
  });

  test("an allow list that is not a list of names", () => {
    expect(validate('[[projects]]\npath = "/p"\nallow = "claude:personal"\n').problems).toEqual([
      "projects[1].allow: must be a list of account names.",
    ]);
  });
});

describe("Defaults and log level", () => {
  test("a default account that is not defined", () => {
    expect(problemsOf("default-not-defined")).toEqual([
      'defaults.account: "claude:personal" is not one of your accounts.',
    ]);
  });

  test("a default account and log level that are valid", () => {
    const { config, problems } = validate(
      '[defaults]\naccount = "claude:personal"\n\n[log]\nlevel = "warn"\n\n[accounts."claude:personal"]\n',
    );
    expect(problems).toEqual([]);
    expect(config.defaults.account).toBe("claude:personal");
    expect(config.log.level).toBe("warn");
  });
});

describe("Problem report", () => {
  const reportOf = (text: string) => {
    const relayHome = makeRelayHome(text);
    try {
      loadConfig({ relayHome, homedir: "/Users/josue", uid: process.getuid!() });
    } catch (error) {
      if (error instanceof SettingsError) return { file: join(relayHome, "config.toml"), lines: error.lines };
      throw error;
    }
    throw new Error("expected a SettingsError");
  };

  test("two problems", () => {
    const { file, lines } = reportOf(fixture("two-problems"));
    expect(lines).toEqual([
      `relay: ${file} has 2 problems:`,
      "  colour: unknown setting.",
      "  log.level: must be debug, info, warn or error.",
      "The settings are described in docs/config.md.",
    ]);
  });

  test("one problem", () => {
    const { file, lines } = reportOf(fixture("newer-version"));
    expect(lines[0]).toBe(`relay: ${file} has 1 problem:`);
  });

  test("problems follow the order of the keys in the file", () => {
    expect(validate(fixture("file-order")).problems).toEqual([
      "version: must be 1.",
      "projects[1].path: must be an absolute path or start with ~/.",
      'projects[1].allow: "claude:personal" is listed twice.',
      'projects[1].allow: "codex:work" is not one of your accounts.',
      'projects[1].allow: account names look like provider:name in lowercase, for example "claude:personal".',
      "projects[3].path: the same path as projects[2].",
      'accounts."claude:personal".kind: must be "personal" or "work".',
      'accounts."claude:personal".credential_env: must be a list of variable names in capitals, for example "ANTHROPIC_API_KEY".',
      'accounts."codex:personal".profile_dir: the same folder as accounts."claude:personal". Each account needs its own profile folder.',
    ]);
  });

  test("a key with control characters is escaped", () => {
    expect(validate('"bad\\u001b[31m" = 1\n"c1\\u009b31m" = 1\n').problems).toEqual([
      '"bad\\u001b[31m": unknown setting.',
      '"c1\\u009b31m": unknown setting.',
    ]);
  });
});

describe("[checkpoint]", () => {
  test("max_file_size_mb is 20 unless the file sets it", () => {
    expect(validate("").config.checkpoint).toEqual({ maxFileSizeMb: 20 });
    expect(validate("[checkpoint]\nmax_file_size_mb = 1\n").config.checkpoint).toEqual({ maxFileSizeMb: 1 });
    expect(validate("[checkpoint]\nmax_file_size_mb = 1024\n").problems).toEqual([]);
  });

  test.each(["0", "1025", "2.5", '"20"'])("max_file_size_mb = %s is a problem", (value) => {
    expect(validate(`[checkpoint]\nmax_file_size_mb = ${value}\n`).problems).toEqual([
      "checkpoint.max_file_size_mb: must be a whole number from 1 to 1024.",
    ]);
  });
});
