import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayPath } from "../../src/accounts/profile";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv, loggingProgram } from "../helpers/fake-programs";

const HOME = process.env.HOME!;
function relayWith(configText: string): string {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), configText);
  chmodSync(join(relayHome, "config.toml"), 0o600);
  return relayHome;
}
const TWO = '[accounts."claude:work"]\nkind = "work"\n\n[accounts."codex:personal"]\n';

test("relay account list shows each account without running a provider command", async () => {
  const relayHome = relayWith(TWO);
  const claude = loggingProgram("claude", { signedIn: true });
  const codex = loggingProgram("codex");
  const env = { ...claude.env, ...codex.env };
  expect((await runRelayInProcess(["account", "status", "claude:work"], { relayHome, env })).code).toBe(0);
  const before = claude.calls().length + codex.calls().length;
  const { code, stdout } = await runRelayInProcess(["account", "list"], { relayHome, env });
  expect(code).toBe(0);
  expect(claude.calls().length + codex.calls().length).toBe(before);
  const work = displayPath(join(relayHome, "profiles", "claude-work"), HOME);
  const personal = displayPath(join(relayHome, "profiles", "codex-personal"), HOME);
  const width = personal.length + 3;
  expect(stdout).toBe(
    `claude:work      ${work.padEnd(width)}signed in (claude.ai)\n` +
      `codex:personal   ${personal.padEnd(width)}sign-in not checked yet\n`,
  );
  const json = JSON.parse((await runRelayInProcess(["account", "list", "--json"], { relayHome, env })).stdout);
  expect(json.accounts.map((entry: { id: string; signed_in: boolean | null }) => [entry.id, entry.signed_in])).toEqual([
    ["claude:work", true], ["codex:personal", null],
  ]);
});

test("relay account list with no accounts", async () => {
  const { code, stdout } = await runRelayInProcess(["account", "list"], { env: fakeEnv() });
  expect(code).toBe(0);
  expect(stdout).toBe("You have no accounts yet. Add one with relay account add <provider> <name>.\n");
});

test("relay account login runs the provider's login in the profile and reports success", async () => {
  const relayHome = relayWith(TWO);
  const codex = loggingProgram("codex");
  const result = await runRelayInProcess(["account", "login", "codex:personal"], { relayHome, env: codex.env });
  expect(result).toEqual({ code: 0, stdout: "codex:personal is signed in.\n", stderr: "" });
  const profile = join(relayHome, "profiles", "codex-personal");
  expect(codex.calls().find((call) => call.args === "login")?.profile).toBe(profile);
  expect(existsSync(profile)).toBe(true);
});

test("relay account login exits 22 when the login fails and 21 for an unknown account", async () => {
  const relayHome = relayWith(TWO);
  const codex = loggingProgram("codex", { loginFails: true });
  const failed = await runRelayInProcess(["account", "login", "codex", "personal"], { relayHome, env: codex.env });
  expect(failed.code).toBe(22);
  expect(failed.stderr).toBe("Codex sign-in did not finish. Try again with relay account login codex:personal.\n");
  const unknown = await runRelayInProcess(["account", "login", "claude:nope"], { relayHome, env: fakeEnv() });
  expect(unknown).toEqual({ code: 21, stdout: "", stderr: "claude:nope is not one of your accounts. See relay account list.\n" });
});

test("relay account remove keeps the profile folder and says how to sign out", async () => {
  const relayHome = relayWith(TWO);
  const profile = join(relayHome, "profiles", "claude-work");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, "settings.json"), "{}\n");
  const result = await runRelayInProcess(["account", "remove", "claude:work"], { relayHome, env: fakeEnv(), answers: ["y"] });
  const shown = displayPath(profile, HOME);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "Remove claude:work from config.toml? [y/N] " +
      `Removed claude:work. Its profile folder is still at ${shown}. To sign out, run CLAUDE_CONFIG_DIR=${shown} claude auth logout, then delete the folder yourself.\n`,
  );
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe('[accounts."codex:personal"]\n');
  expect(readFileSync(join(profile, "settings.json"), "utf8")).toBe("{}\n");
});

test("relay account remove refuses while a project allows the account", async () => {
  const relayHome = relayWith(`${TWO}\n[[projects]]\npath = "/srv/app"\nallow = ["claude:work"]\n`);
  const before = readFileSync(join(relayHome, "config.toml"), "utf8");
  const result = await runRelayInProcess(["account", "remove", "claude:work", "--yes"], { relayHome, env: fakeEnv() });
  expect(result).toEqual({
    code: 2, stdout: "",
    stderr: "claude:work is allowed on /srv/app. Remove it from that project's allow list in config.toml first.\n",
  });
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(before);
});

test("relay account remove refuses while [defaults] names the account", async () => {
  const relayHome = relayWith(`[defaults]\naccount = "claude:work"\n\n${TWO}`);
  const before = readFileSync(join(relayHome, "config.toml"), "utf8");
  const result = await runRelayInProcess(["account", "remove", "claude:work", "--yes"], { relayHome, env: fakeEnv() });
  expect(result).toEqual({
    code: 2, stdout: "",
    stderr: "claude:work is named in [defaults], [t3] or [limits] in config.toml. Remove it there first.\n",
  });
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(before);
});

test("relay account remove keeps the comment above the next table", async () => {
  const rest = '# limits: keep me\n[defaults]\naccount = "codex:personal"\n\n[accounts."codex:personal"]\n';
  const relayHome = relayWith(`version = 1\n\n[accounts."claude:work"]\nkind = "work"\n\n${rest}`);
  const result = await runRelayInProcess(["account", "remove", "claude:work", "--yes"], { relayHome, env: fakeEnv() });
  expect(result.code).toBe(0);
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(`version = 1\n\n${rest}`);
});

test("relay account remove: no answer changes nothing, and dotted keys are refused", async () => {
  const relayHome = relayWith(TWO);
  const no = await runRelayInProcess(["account", "remove", "claude:work"], { relayHome, env: fakeEnv(), answers: ["n"] });
  expect(no.code).toBe(7);
  expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(TWO);
  const dotted = relayWith('[accounts]\n"claude:work".kind = "work"\n');
  const refused = await runRelayInProcess(["account", "remove", "claude:work", "--yes"], { relayHome: dotted, env: fakeEnv() });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe('relay could not find the [accounts."claude:work"] table in config.toml. Remove the account there yourself.\n');
});

test("options that do not belong to the action are refused", async () => {
  const result = await runRelayInProcess(["account", "list", "--yes"], { env: fakeEnv() });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("relay: --yes does not work with relay account list.");
});
