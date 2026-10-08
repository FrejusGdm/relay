// relay account add: every scenario of the provider-accounts spec for adding an account.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayPath } from "../../src/accounts/profile";
import { runRelayInProcess } from "../helpers/cli";
import { allFiles, fakeEnv, loggingProgram } from "../helpers/fake-programs";

const HOME = process.env.HOME!;
// A relay folder under HOME, so paths show as ~/...
const relayFolder = () => mkdtempSync(join(HOME, "relay-"));
const config = (relayHome: string) => readFileSync(join(relayHome, "config.toml"), "utf8");
const record = (relayHome: string, folder: string) =>
  JSON.parse(readFileSync(join(relayHome, "accounts", folder, "account.json"), "utf8")) as Record<string, unknown>;

test("a new Claude account: folder 0700, table appended, login in the profile, summary", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("claude");
  const result = await runRelayInProcess(["account", "add", "claude", "work"], {
    relayHome, env: { ...program.env, RELAY_BIN: "/usr/local/bin/relay" }, answers: ["y", "n"],
  });
  const profile = join(relayHome, "profiles", "claude-work");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(lstatSync(profile).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(relayHome, "profiles")).mode & 0o777).toBe(0o700);
  expect(config(relayHome)).toMatch(/^# Added by relay on \d{4}-\d{2}-\d{2}\.\n\[accounts\."claude:work"\]\n$/);
  expect(lstatSync(join(relayHome, "config.toml")).mode & 0o777).toBe(0o600);
  const login = program.calls().find((call) => call.args === "auth login");
  expect(login).toEqual({ args: "auth login", profile, apiKeySet: false });
  expect(result.stdout).toContain("Claude Code policy notes, checked 2026-10-07:\n");
  expect(result.stdout).toContain("Add claude:work? [y/N] ");
  expect(result.stdout.endsWith(
    `Added claude:work.\n  Profile    ${displayPath(profile, HOME)}\n  Signed in  yes (claude.ai)\n` +
      "Install relay's hooks, so relay can see sessions you start yourself? [y/N] " +
      "To let relay see sessions you start yourself, run relay hooks install claude:work.\n",
  )).toBe(true);
  const saved = record(relayHome, "claude-work");
  expect(saved.policy_checked_on_seen).toBe("2026-10-07");
  expect(typeof saved.policy_seen_at).toBe("string");
  expect(saved.last_auth).toMatchObject({ signed_in: true, method: "claude.ai" });
});

test("the email in the provider's status output is stored nowhere under RELAY_HOME", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("claude");
  expect((await runRelayInProcess(["account", "add", "claude", "work", "--yes"], { relayHome, env: program.env })).code).toBe(0);
  for (const file of allFiles(relayHome)) {
    expect(file.text).not.toContain("fake.user@example.com");
    expect(file.text).not.toContain("@");
  }
});

test("adding a Codex account shows the policy before the question", async () => {
  const relayHome = relayFolder();
  const result = await runRelayInProcess(["account", "add", "codex", "personal"], { relayHome, env: fakeEnv(), answers: ["yes"] });
  expect(result.code).toBe(0);
  const question = result.stdout.indexOf("Add codex:personal? [y/N] ");
  const notes = result.stdout.indexOf("Codex policy notes, checked 2026-10-07:\n");
  const terms = result.stdout.indexOf("  OpenAI Terms of Use  https://openai.com/policies/terms-of-use/\n");
  expect(notes).toBeGreaterThanOrEqual(0);
  expect(result.stdout).toContain("relay starts the Codex program you installed");
  expect(terms).toBeGreaterThan(notes);
  expect(question).toBeGreaterThan(terms);
});

test("comments in config.toml survive an add", async () => {
  const relayHome = relayFolder();
  const before = "# Mine.\nversion = 1\n\n# My work account.\n[accounts.\"claude:work\"]\nkind = \"work\"\n";
  await Bun.write(join(relayHome, "config.toml"), before);
  const { chmodSync } = await import("node:fs");
  chmodSync(join(relayHome, "config.toml"), 0o600);
  const result = await runRelayInProcess(["account", "add", "codex", "personal", "--yes"], { relayHome, env: fakeEnv() });
  expect(result.code).toBe(0);
  expect(config(relayHome).startsWith(`${before}\n# Added by relay on `)).toBe(true);
  expect(config(relayHome).endsWith('[accounts."codex:personal"]\n')).toBe(true);
});

test("adding an account again under a removed account's name starts a new record and forgets old readings", async () => {
  const relayHome = relayFolder();
  const folder = join(relayHome, "accounts", "claude-work");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const old = "2026-01-02T03:04:05.000Z";
  writeFileSync(join(folder, "account.json"), JSON.stringify({
    v: 1, account: "claude:work", added_at: old, policy_checked_on_seen: "2026-01-01", policy_seen_at: old,
    last_auth: { signed_in: true, method: "old", checked_at: old }, hooks_installed_at: old, status_line_installed_at: old,
  }));
  writeFileSync(join(folder, "availability.json"), JSON.stringify({
    v: 1, account: "claude:work", state: "quota_exhausted", retry_at: null, windows: [], observed_at: old, source: "hook",
    detail: null, spool_seen_until: null,
  }));
  const result = await runRelayInProcess(["account", "add", "claude", "work", "--yes", "--no-login"], { relayHome, env: fakeEnv() });
  expect(result.code).toBe(0);
  const saved = record(relayHome, "claude-work");
  expect(saved.added_at).not.toBe(old);
  expect(saved.policy_checked_on_seen).toBe("2026-10-07");
  expect(saved.hooks_installed_at).toBeNull();
  expect(saved.status_line_installed_at).toBeNull();
  expect(existsSync(join(folder, "availability.json"))).toBe(false);
});

test("an answer other than y or yes changes nothing and exits 7", async () => {
  for (const answer of ["n", "", "no", "maybe"]) {
    const relayHome = relayFolder();
    const result = await runRelayInProcess(["account", "add", "claude", "work"], { relayHome, env: fakeEnv(), answers: [answer] });
    expect(result.code).toBe(7);
    expect(result.stderr).toBe("Nothing changed.\n");
    expect(existsSync(join(relayHome, "config.toml"))).toBe(false);
    expect(existsSync(join(relayHome, "profiles"))).toBe(false);
    expect(existsSync(join(relayHome, "accounts"))).toBe(false);
  }
});

test("an existing account is refused with exit 2", async () => {
  const relayHome = relayFolder();
  expect((await runRelayInProcess(["account", "add", "claude", "work", "--yes"], { relayHome, env: fakeEnv() })).code).toBe(0);
  const before = config(relayHome);
  const again = await runRelayInProcess(["account", "add", "claude", "work", "--yes"], { relayHome, env: fakeEnv() });
  expect(again).toEqual({ code: 2, stdout: "", stderr: "claude:work already exists. See relay account list.\n" });
  expect(config(relayHome)).toBe(before);
});

test("a missing provider program is refused with exit 20", async () => {
  const relayHome = relayFolder();
  const result = await runRelayInProcess(["account", "add", "codex", "personal", "--yes"], {
    relayHome, env: { ...fakeEnv(), RELAY_CODEX_BIN: "/nonexistent/codex" },
  });
  expect(result).toEqual({ code: 20, stdout: "", stderr: "Codex is not installed. Install it, then run relay account add again.\n" });
  expect(existsSync(join(relayHome, "config.toml"))).toBe(false);
});

test("without a terminal and without --yes relay names its question and exits 7", async () => {
  const relayHome = relayFolder();
  const result = await runRelayInProcess(["account", "add", "claude", "work"], { relayHome, env: fakeEnv() });
  expect(result).toEqual({
    code: 7, stdout: "",
    stderr: 'relay needs your yes to the question "Add claude:work?" and has no terminal to ask it in.\nRun the command again in a terminal, or add --yes.\n',
  });
  expect(existsSync(join(relayHome, "profiles"))).toBe(false);
});

test("invalid providers, names, kinds and shared folders are refused without changes", async () => {
  const relayHome = relayFolder();
  const run = (args: string[]) => runRelayInProcess(["account", ...args, "--yes"], { relayHome, env: fakeEnv() });
  expect(await run(["add", "cursor", "work"])).toEqual({
    code: 2, stdout: "", stderr: "relay has no adapter for cursor yet. Supported providers: claude, codex.\n",
  });
  for (const args of [["add", "claude", "Work"], ["add", "claude", "-x"], ["add", "claude", "a".repeat(33)], ["add", "claude", "w", "--kind", "team"]]) {
    expect((await run(args)).code).toBe(2);
  }
  expect((await run(["add", "codex", "w", "--api-key-env", "ANTHROPIC_API_KEY"])).stderr).toContain(
    'codex accounts can only pass OPENAI_ or CODEX_ variables other than CODEX_HOME, not "ANTHROPIC_API_KEY".',
  );
  expect((await run(["add", "claude", "one", "--profile-dir", join(HOME, "shared")])).code).toBe(0);
  const shared = await run(["add", "claude", "two", "--profile-dir", join(HOME, "shared")]);
  expect(shared.code).toBe(2);
  expect(shared.stderr).toBe("~/shared is already the profile folder of claude:one. Each account needs its own profile folder.\n");
  expect(config(relayHome)).not.toContain("claude:two");
});

test("the provider's own folder with an existing login: no login runs", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("claude", { signedIn: true });
  const result = await runRelayInProcess(["account", "add", "claude", "personal", "--profile-dir", join(HOME, ".claude"), "--yes"], {
    relayHome, env: program.env,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("  Signed in  yes (claude.ai)\n");
  expect(result.stdout).toContain("To let relay see sessions you start yourself, run relay hooks install claude:personal.\n");
  expect(program.calls().map((call) => call.args)).toEqual(["--version", "auth status --json"]);
  expect(program.calls()[1]!.profile).toBe("unset");
  expect(config(relayHome)).toContain(`profile_dir = "${join(HOME, ".claude")}"`);
});

test("a login that fails leaves the account added and exits 22", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("codex", { loginFails: true });
  const result = await runRelayInProcess(["account", "add", "codex", "personal", "--yes"], { relayHome, env: program.env });
  expect(result.code).toBe(22);
  expect(result.stderr).toBe("Codex sign-in did not finish. The account is added; sign in later with relay account login codex:personal.\n");
  expect(config(relayHome)).toContain('[accounts."codex:personal"]');
  expect(program.calls().find((call) => call.args === "login")?.profile).toBe(join(relayHome, "profiles", "codex-personal"));
});

test("--no-login adds the account without signing in", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("codex");
  const result = await runRelayInProcess(["account", "add", "codex", "later", "--no-login", "--yes"], { relayHome, env: program.env });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("  Signed in  no\nSign in later with relay account login codex:later.\n");
  expect(program.calls().some((call) => call.args === "login")).toBe(false);
});

test("an API-key account records only the variable's name and never its value", async () => {
  const relayHome = relayFolder();
  const program = loggingProgram("claude");
  const token = ["sk", "ant", "api03", crypto.randomUUID().replaceAll("-", "")].join("-");
  const result = await runRelayInProcess(["account", "add", "claude", "api", "--api-key-env", "ANTHROPIC_API_KEY", "--yes"], {
    relayHome, env: { ...program.env, ANTHROPIC_API_KEY: token },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "claude:api uses the key in $ANTHROPIC_API_KEY. relay passes that variable to Claude Code and never stores its value.\n",
  );
  expect(config(relayHome)).toContain('[accounts."claude:api"]\ncredential_env = ["ANTHROPIC_API_KEY"]\n');
  expect(program.calls().some((call) => call.args.includes("login"))).toBe(false);
  expect(result.stdout + result.stderr).not.toContain(token);
  for (const file of allFiles(relayHome)) expect(file.text).not.toContain(token);
});
