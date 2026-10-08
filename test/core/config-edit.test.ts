import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { appendTable, editConfig, removeAccountTable } from "../../src/core/config/edit";
import { makeRelayHome } from "../helpers/home";

const HOME = process.env.HOME!;
const CHILD = join(import.meta.dir, "..", "helpers", "edit-config-child.ts");
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

test("removing a table keeps the comments and blank lines that come before the next table", () => {
  const rest = '# limits: keep me\n[defaults]\naccount = "claude:a"\n';
  const text = `version = 1\n\n[accounts."claude:b"]\n# b's comment\nkind = "work"\n\n${rest}`;
  expect(removeAccountTable(text, "claude:b")).toBe(`version = 1\n\n${rest}`);
  const close = `version = 1\n\n[accounts."claude:b"]\nkind = "work"\n${rest}`;
  expect(removeAccountTable(close, "claude:b")).toBe(`version = 1\n\n${rest}`);
  const last = `version = 1\n\n[accounts."claude:b"]\nkind = "work"\n\n# the end\n`;
  expect(removeAccountTable(last, "claude:b")).toBe("version = 1\n\n# the end\n");
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

test("a config.toml that is a symbolic link is not changed, and the link stays", () => {
  const relayHome = makeRelayHome();
  const target = join(relayHome, "dotfiles.toml");
  writeFileSync(target, PERSON);
  chmodSync(target, 0o600);
  const link = join(relayHome, "config.toml");
  symlinkSync(target, link);
  let error: unknown;
  try {
    editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."codex:personal"]', DAY));
  } catch (caught) {
    error = caught;
  }
  expect((error as CommandError).code).toBe(78);
  expect((error as CommandError).lines).toEqual([
    `relay: ${link} is a symbolic link, and relay does not change config.toml through a link. ` +
      "Make the change in the file it leads to yourself, or replace the link with that file and try again.",
  ]);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(PERSON);
});

test("two processes that change config.toml at once both keep their change", async () => {
  const relayHome = makeRelayHome();
  const children = ["claude:one", "codex:two"].map((id) =>
    Bun.spawn([process.execPath, CHILD, relayHome, id], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async (child) => [await child.exited, await new Response(child.stderr).text()]));
  expect(results).toEqual([[0, ""], [0, ""]]);
  const text = readFileSync(join(relayHome, "config.toml"), "utf8");
  expect(text).toContain('[accounts."claude:one"]');
  expect(text).toContain('[accounts."codex:two"]');
  expect(existsSync(join(relayHome, "locks", "config.lock"))).toBe(false);
}, 10_000);

function writeLock(relayHome: string, pid: number): string {
  mkdirSync(join(relayHome, "locks"), { recursive: true, mode: 0o700 });
  const lock = join(relayHome, "locks", "config.lock");
  writeFileSync(lock, `${JSON.stringify({ pid, command: "edit-config", started_at: new Date().toISOString(), host: hostname() })}\n`);
  return lock;
}

test("a config lock left by a process that has ended is replaced", async () => {
  const relayHome = makeRelayHome();
  const ended = Bun.spawn([process.execPath, "--version"], { stdout: "ignore" });
  await ended.exited;
  const lock = writeLock(relayHome, ended.pid);
  editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."codex:personal"]', DAY));
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toContain('[accounts."codex:personal"]');
  expect(existsSync(lock)).toBe(false);
});

test("while a running process holds the config lock, a change waits 2 seconds and then exits 6", () => {
  const relayHome = makeRelayHome(PERSON);
  const lock = writeLock(relayHome, process.pid);
  let error: unknown;
  try {
    editConfig(ctx(relayHome), (text) => appendTable(text, '[accounts."codex:personal"]', DAY));
  } catch (caught) {
    error = caught;
  }
  expect((error as CommandError).code).toBe(6);
  expect((error as CommandError).lines).toEqual(["Another relay command is changing config.toml. Try again when it finishes."]);
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(PERSON);
  expect(existsSync(lock)).toBe(true);
}, 10_000);
