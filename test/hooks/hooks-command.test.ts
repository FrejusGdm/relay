import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv, loggingProgram } from "../helpers/fake-programs";

const HOME = process.env.HOME!;
const RELAY = "/usr/local/bin/relay";

function relayWith(config: string): string {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), config, { mode: 0o600 });
  return relayHome;
}

test("relay shows the entries and asks; no answer changes nothing", async () => {
  const relayHome = relayWith('[accounts."claude:work"]\n');
  mkdirSync(join(relayHome, "profiles", "claude-work"), { recursive: true, mode: 0o700 });
  const settings = join(relayHome, "profiles", "claude-work", "settings.json");
  const no = await runRelayInProcess(["hooks", "install", "claude:work"], { relayHome, env: { ...fakeEnv(), RELAY_BIN: RELAY }, answers: ["n"] });
  expect(no.code).toBe(7);
  expect(no.stdout).toContain("  SessionStart  '/usr/local/bin/relay' hook claude SessionStart  (time limit 5 s)\n");
  expect(no.stdout.endsWith("Install these hooks? [y/N] ")).toBe(true);
  expect(no.stderr).toBe("Nothing changed.\n");
  expect(existsSync(settings)).toBe(false);
  const noTerminal = await runRelayInProcess(["hooks", "install", "claude:work"], { relayHome, env: { ...fakeEnv(), RELAY_BIN: RELAY } });
  expect(noTerminal.code).toBe(7);
  const yes = await runRelayInProcess(["hooks", "install", "claude:work"], { relayHome, env: { ...fakeEnv(), RELAY_BIN: RELAY }, answers: ["y"] });
  expect(yes.code).toBe(0);
  expect(yes.stdout).toContain("Installed relay's hooks for claude:work.\n");
  expect(existsSync(settings)).toBe(true);
});

test("relay hooks status lists each event and the status line", async () => {
  const relayHome = relayWith('[accounts."claude:work"]\n');
  const env = { ...fakeEnv(), RELAY_BIN: RELAY };
  mkdirSync(join(relayHome, "profiles", "claude-work"), { recursive: true, mode: 0o700 });
  expect((await runRelayInProcess(["hooks", "status", "claude:work"], { relayHome, env })).stdout).toContain("Hooks: not installed\n");
  await runRelayInProcess(["hooks", "install", "claude:work", "--yes"], { relayHome, env });
  const { code, stdout } = await runRelayInProcess(["hooks", "status", "claude:work"], { relayHome, env });
  expect(code).toBe(0);
  expect(stdout).toContain("Hooks: installed\n");
  expect(stdout).toContain("  StopFailure   present\n");
  expect(stdout).toContain("Status line: not installed\n");
  expect((await runRelayInProcess(["hooks", "status", "claude:nope"], { relayHome, env })).code).toBe(21);
  expect((await runRelayInProcess(["hooks", "check", "claude:work"], { relayHome, env })).code).toBe(2);
});

test("relay account add offers hooks for a folder relay creates", async () => {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  const program = loggingProgram("claude", { signedIn: true });
  const result = await runRelayInProcess(["account", "add", "claude", "work"], {
    relayHome, env: { ...program.env, RELAY_BIN: RELAY }, answers: ["y", "y"],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Install relay's hooks, so relay can see sessions you start yourself? [y/N] ");
  expect(result.stdout).toContain("Installed relay's hooks for claude:work.\n");
  const settings = JSON.parse(readFileSync(join(relayHome, "profiles", "claude-work", "settings.json"), "utf8"));
  expect(Object.keys(settings.hooks)).toHaveLength(6);
});

test("with --profile-dir ~/.claude relay only prints the hint", async () => {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  const program = loggingProgram("claude", { signedIn: true });
  const result = await runRelayInProcess(["account", "add", "claude", "personal", "--profile-dir", join(HOME, ".claude")], {
    relayHome, env: { ...program.env, RELAY_BIN: RELAY }, answers: ["y"],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("Install relay's hooks");
  expect(result.stdout.endsWith("To let relay see sessions you start yourself, run relay hooks install claude:personal.\n")).toBe(true);
  expect(existsSync(join(HOME, ".claude", "settings.json"))).toBe(false);
});

test.each([
  [true, "Hooks: installed and trusted\n"],
  [false, "Hooks: installed, waiting for you to trust them in Codex (/hooks).\n"],
  ["modified", "Hooks: installed, but changed since you trusted them. Trust them again in Codex (/hooks).\n"],
] as const)("relay hooks status for Codex reports the trust state %p", async (trusted, line) => {
  const relayHome = relayWith('[accounts."codex:personal"]\n');
  mkdirSync(join(relayHome, "profiles", "codex-personal"), { recursive: true, mode: 0o700 });
  const env = { ...fakeEnv({ hooks_trusted: trusted }), RELAY_BIN: RELAY };
  expect((await runRelayInProcess(["hooks", "install", "codex:personal", "--yes"], { relayHome, env })).code).toBe(0);
  const { code, stdout } = await runRelayInProcess(["hooks", "status", "codex:personal"], { relayHome, env });
  expect(code).toBe(0);
  expect(stdout).toContain(line);
});
