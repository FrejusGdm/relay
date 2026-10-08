import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayPath } from "../../src/accounts/profile";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";

const HOME = process.env.HOME!;
const RELAY = "/usr/local/bin/relay";
const env = { ...fakeEnv(), RELAY_BIN: RELAY };

function setup(provider: "claude" | "codex", settings?: string) {
  const relayHome = mkdtempSync(join(HOME, "relay-"));
  writeFileSync(join(relayHome, "config.toml"), `[accounts."${provider}:work"]\n`, { mode: 0o600 });
  const profile = join(relayHome, "profiles", `${provider}-work`);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = join(profile, provider === "claude" ? "settings.json" : "hooks.json");
  if (settings !== undefined) writeFileSync(file, settings, { mode: 0o644 });
  return { relayHome, profile, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}
const run = (relayHome: string, args: string[], answers?: string[]) =>
  runRelayInProcess(["hooks", ...args], { relayHome, env, ...(answers ? { answers } : {}) });

test("Claude: one entry per event with a 5-second limit, the person's settings kept", async () => {
  const { relayHome, file, read } = setup("claude", JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  const result = await run(relayHome, ["install", "claude:work", "--yes"]);
  expect(result.code).toBe(0);
  const data = read();
  expect(data.model).toBe("opus");
  expect(Object.keys(data.hooks)).toEqual(["Stop", "SessionStart", "StopFailure", "Notification", "SessionEnd", "PreCompact"]);
  expect(data.hooks.StopFailure).toEqual([{ hooks: [{ type: "command", command: "'/usr/local/bin/relay' hook claude StopFailure", timeout: 5 }] }]);
  expect(data.hooks.Stop[0]).toEqual({ hooks: [{ type: "command", command: "say done" }] });
  expect(data.hooks.Stop).toHaveLength(2);
  expect(statSync(file).mode & 0o777).toBe(0o644);
  expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
  expect(result.stdout).toContain(`relay will add these hooks to ${displayPath(file, HOME)}:\n`);
  expect(result.stdout).toContain("  StopFailure   '/usr/local/bin/relay' hook claude StopFailure  (time limit 5 s)\n");
});

test("a backup with the original bytes is kept", async () => {
  const original = '{ "hooks": {}, "theme": "dark" }';
  const { relayHome } = setup("claude", original);
  const result = await run(relayHome, ["install", "claude:work", "--yes"]);
  const folder = join(relayHome, "accounts", "claude-work", "backups");
  const [backup] = readdirSync(folder);
  expect(backup).toMatch(/^settings\.json\.\d{8}T\d{6}Z$/);
  expect(readFileSync(join(folder, backup!), "utf8")).toBe(original);
  expect(statSync(join(folder, backup!)).mode & 0o777).toBe(0o600);
  expect(result.stdout).toContain(`Saved a copy of the old file in ${displayPath(join(folder, backup!), HOME)}.\n`);
});

test("Codex: the person's SessionStart hook stays first, timeouts of 3 s, config.toml untouched", async () => {
  const mine = { hooks: [{ type: "command", command: "other-tool start" }] };
  const { relayHome, profile, read } = setup("codex", JSON.stringify({ hooks: { SessionStart: [mine] } }));
  const config = 'model = "gpt"\nnotify = ["say", "hi"]\n';
  writeFileSync(join(profile, "config.toml"), config);
  const result = await run(relayHome, ["install", "codex:work", "--yes"]);
  expect(result.code).toBe(0);
  const data = read();
  expect(data.hooks.SessionStart[0]).toEqual(mine);
  expect(data.hooks.SessionStart[1].hooks[0].command).toBe("'/usr/local/bin/relay' hook codex SessionStart");
  for (const event of ["SessionEnd", "Interrupt"]) expect(data.hooks[event][0].hooks[0].timeout).toBe(3);
  for (const event of ["SessionStart", "Stop", "PreCompact"]) expect(data.hooks[event].at(-1).hooks[0].timeout).toBe(5);
  expect(readFileSync(join(profile, "config.toml"), "utf8")).toBe(config);
  expect(result.stdout).toContain(
    `Codex asks you to trust new hooks once. Open Codex with this account (CODEX_HOME=${displayPath(profile, HOME)} codex), type /hooks, and trust the relay hooks.\n`,
  );
});

test("installing twice adds nothing the second time", async () => {
  const { relayHome, read } = setup("claude");
  expect((await run(relayHome, ["install", "claude:work", "--yes"])).code).toBe(0);
  const first = read();
  const again = await run(relayHome, ["install", "claude:work", "--yes"]);
  expect(again).toEqual({ code: 0, stdout: "relay's hooks are already installed for claude:work.\n", stderr: "" });
  expect(read()).toEqual(first);
  for (const groups of Object.values(first.hooks) as unknown[][]) expect(groups).toHaveLength(1);
});

test("removal takes only relay's entries; with only relay's hooks the hooks key goes", async () => {
  const { relayHome, read } = setup("claude", JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  await run(relayHome, ["install", "claude:work", "--yes"]);
  const removed = await run(relayHome, ["remove", "claude:work", "--yes"]);
  expect(removed.code).toBe(0);
  expect(removed.stdout).toContain("Removed relay's hooks from claude:work.\n");
  expect(read()).toEqual({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });

  const clean = setup("claude", JSON.stringify({ theme: "dark" }));
  await run(clean.relayHome, ["install", "claude:work", "--yes"]);
  await run(clean.relayHome, ["remove", "claude:work", "--yes"]);
  expect(clean.read()).toEqual({ theme: "dark" });
  expect((await run(clean.relayHome, ["remove", "claude:work", "--yes"])).stdout).toBe("relay's hooks are not installed for claude:work.\n");
});

test("a relay entry inside the person's matcher group leaves the rest of the group", async () => {
  const group = { matcher: "startup", hooks: [{ type: "command", command: "mine" }, { type: "command", command: "'/opt/relay' hook claude SessionStart" }] };
  const { relayHome, read } = setup("claude", JSON.stringify({ hooks: { SessionStart: [group] } }));
  await run(relayHome, ["remove", "claude:work", "--yes"]);
  expect(read()).toEqual({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "mine" }] }] } });
});

test("a damaged settings file is not overwritten", async () => {
  const { relayHome, file } = setup("claude", '{"hooks": ');
  const result = await run(relayHome, ["install", "claude:work", "--yes"]);
  expect(result).toEqual({
    code: 1, stdout: "",
    stderr: `${displayPath(file, HOME)} is not valid JSON, so relay changed nothing. Fix the file, then try again.\n`,
  });
  expect(readFileSync(file, "utf8")).toBe('{"hooks": ');
  const notObject = setup("claude", '{"hooks": []}');
  expect((await run(notObject.relayHome, ["install", "claude:work", "--yes"])).code).toBe(1);
});

test("a missing settings file is created with mode 0600", async () => {
  const { relayHome, file } = setup("claude");
  await run(relayHome, ["install", "claude:work", "--yes"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(existsSync(join(relayHome, "accounts", "claude-work", "backups"))).toBe(false);
});

test("the status line is wrapped, the original saved and restored on removal", async () => {
  const mine = { type: "command", command: "~/bin/my-status" };
  const { relayHome, read } = setup("claude", JSON.stringify({ statusLine: mine }));
  const result = await run(relayHome, ["install", "claude:work", "--status-line", "--yes"]);
  expect(result.stdout).toContain("Your status line still shows; relay runs it after recording the usage numbers.\n");
  expect(read().statusLine).toEqual({ type: "command", command: "'/usr/local/bin/relay' statusline claude" });
  expect(JSON.parse(readFileSync(join(relayHome, "accounts", "claude-work", "statusline-original.json"), "utf8"))).toEqual({ v: 1, original: mine });
  await run(relayHome, ["remove", "claude:work", "--yes"]);
  expect(read()).toEqual({ statusLine: mine });
  const plain = setup("claude");
  await run(plain.relayHome, ["install", "claude:work", "--yes"]);
  expect(plain.read().statusLine).toBeUndefined();
});

test("relay refuses to write source paths: RELAY_BIN is needed when running from source", async () => {
  const { relayHome } = setup("claude");
  const result = await runRelayInProcess(["hooks", "install", "claude:work", "--yes"], { relayHome, env: fakeEnv() });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("relay hooks install needs the installed relay program. Set RELAY_BIN when running relay from source.\n");
});

test("a profile folder others can change is refused", async () => {
  const { relayHome, profile } = setup("claude");
  chmodSync(profile, 0o777);
  expect((await run(relayHome, ["install", "claude:work", "--yes"])).code).toBe(78);
});
