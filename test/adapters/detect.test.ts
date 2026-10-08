import { expect, test } from "bun:test";
import { createClaudeAdapter } from "../../src/adapters/claude/adapter";
import { createCodexAdapter } from "../../src/adapters/codex/adapter";
import type { Account } from "../../src/core/config/types";
import { buildAgentEnv } from "../../src/accounts/environment";
import { FAKE_CLAUDE, FAKE_CODEX, fakeEnv } from "../helpers/fake-programs";

const env = (scenario?: Parameters<typeof fakeEnv>[0]) => ({ ...process.env, ...fakeEnv(scenario) });
const account = (provider: "claude" | "codex"): Account => ({
  id: `${provider}:work`, provider, name: "work", profileDir: `${process.env.HOME}/profile-${provider}`,
  profileDirIsDefault: false, credentialEnv: [], kind: null,
});

test("detect reads the tested versions from the fakes", async () => {
  expect(await createClaudeAdapter(env()).detect()).toEqual({ installed: true, path: FAKE_CLAUDE, version: "2.1.282" });
  expect(await createCodexAdapter(env()).detect()).toEqual({ installed: true, path: FAKE_CODEX, version: "0.160.0" });
});

test("an older version is marked too old and a newer one is accepted", async () => {
  expect((await createClaudeAdapter(env({ tool_version: "2.1.100" })).detect()).tooOld).toEqual({ oldest: "2.1.282" });
  const newer = await createCodexAdapter(env({ tool_version: "0.161.0" })).detect();
  expect(newer.version).toBe("0.161.0");
  expect(newer.tooOld).toBeUndefined();
});

test("a missing program is not installed", async () => {
  const missing = { ...process.env, RELAY_CLAUDE_BIN: undefined, RELAY_CODEX_BIN: undefined, PATH: "/nonexistent" };
  expect(await createClaudeAdapter(missing).detect()).toEqual({ installed: false });
  expect(await createCodexAdapter(missing).detect()).toEqual({ installed: false });
});

test("Claude sign-in: the method is kept and the email in the output is not", async () => {
  const adapter = createClaudeAdapter(env());
  const status = await adapter.authStatus(account("claude"), buildAgentEnv(account("claude"), env()));
  expect(status).toEqual({ signedIn: true, method: "claude.ai" });
  expect(JSON.stringify(status)).not.toContain("@");
  const signedOut = env({ auth: { signed_in: false } });
  expect(await createClaudeAdapter(signedOut).authStatus(account("claude"), buildAgentEnv(account("claude"), signedOut))).toEqual({ signedIn: false });
});

test("Codex sign-in reads only the exit code and the method phrase", async () => {
  const signedIn = env({ auth: { signed_in: true, method: "API key" } });
  expect(await createCodexAdapter(signedIn).authStatus(account("codex"), buildAgentEnv(account("codex"), signedIn))).toEqual({ signedIn: true, method: "API key" });
  const signedOut = env({ auth: { signed_in: false } });
  expect(await createCodexAdapter(signedOut).authStatus(account("codex"), buildAgentEnv(account("codex"), signedOut))).toEqual({ signedIn: false });
});

test("the login commands are the providers' own", () => {
  expect(createClaudeAdapter(env()).loginCommand(account("claude"))).toEqual(["claude", "auth", "login"]);
  expect(createCodexAdapter(env()).loginCommand(account("codex"))).toEqual(["codex", "login"]);
});
