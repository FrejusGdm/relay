import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { appendTable, editConfig, removeAccountTable } from "../../src/core/config/edit";
import { makeRelayHome } from "../helpers/home";

const HOME = process.env.HOME!;
const ctx = (relayHome: string) => ({ relayHome, homedir: HOME, uid: process.getuid!() });
const DAY = new Date(2026, 9, 8, 12);
const PERSON = `# My relay settings.
version = 1

# Work account, signed in on Monday.
[accounts."claude:work"]
kind = "work"   # the startup

[[projects]]
path = "~/app"
allow = ["claude:work"]
`;

test("appending keeps every line, in order, and adds a dated comment", () => {
  const after = appendTable(PERSON, '[accounts."codex:personal"]', DAY);
  expect(after).toBe(`${PERSON}\n# Added by relay on 2026-10-08.\n[accounts."codex:personal"]\n`);
  expect(appendTable("", "[accounts.\"codex:a\"]", DAY)).toBe("# Added by relay on 2026-10-08.\n[accounts.\"codex:a\"]\n");
  expect(appendTable("version = 1", "[x]\n", DAY)).toBe("version = 1\n\n# Added by relay on 2026-10-08.\n[x]\n");
});

test("removing an appended table gives back the bytes from before", () => {
  const after = appendTable(PERSON, '[accounts."codex:personal"]\nkind = "personal"', DAY);
  expect(removeAccountTable(after, "codex:personal")).toBe(PERSON);
});

test("removing a table in the middle keeps the rest and the comments around it", () => {
  const text = `version = 1\n\n[accounts."claude:a"]\nkind = "work"\n\n[accounts."claude:b"]\n# b's comment\nkind = "personal"\n\n[[projects]]\npath = "/x"\nallow = []\n`;
  expect(removeAccountTable(text, "claude:b")).toBe(`version = 1\n\n[accounts."claude:a"]\nkind = "work"\n\n[[projects]]\npath = "/x"\nallow = []\n`);
});

test("an account written with dotted keys or inline is refused", () => {
  for (const text of ['[accounts]\n"claude:work".kind = "work"\n', 'accounts = { "claude:work" = {} }\n']) {
    let error: unknown;
    try {
      removeAccountTable(text, "claude:work");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe(1);
    expect((error as CommandError).lines).toEqual([
      'relay could not find the [accounts."claude:work"] table in config.toml. Remove the account there yourself.',
    ]);
  }
});

test("a change that fails validation leaves the file byte for byte unchanged", () => {
  const relayHome = makeRelayHome(PERSON);
  const file = join(relayHome, "config.toml");
  const before = readFileSync(file);
  let error: unknown;
  try {
    editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."claude:new"]\npassword = "x"'));
  } catch (caught) {
    error = caught;
  }
  expect((error as CommandError).code).toBe(70);
  expect((error as CommandError).lines).toEqual([
    "relay made a change to config.toml that does not pass its own checks. Nothing was saved. Please report this.",
  ]);
  expect(readFileSync(file).equals(before)).toBe(true);
  // Removing an account that a project still allows breaks the settings too.
  expect(() => editConfig(ctx(relayHome), (text) => removeAccountTable(text, "claude:work"))).toThrow(CommandError);
  expect(readFileSync(file).equals(before)).toBe(true);
});

test("a missing file is created with mode 0600 and a written file keeps mode 0600", () => {
  const relayHome = makeRelayHome();
  const config = editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."codex:personal"]', DAY));
  expect(config.accounts.map((account) => account.id)).toEqual(["codex:personal"]);
  const file = join(relayHome, "config.toml");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeFileSync(file, readFileSync(file));
  editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."claude:work"]', DAY));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain('[accounts."claude:work"]');
});

test("the check function can refuse a result", () => {
  const relayHome = makeRelayHome(PERSON);
  expect(() => editConfig(ctx(relayHome), (text) => text, () => false)).toThrow("does not pass its own checks");
});
