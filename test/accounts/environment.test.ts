import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildAgentEnv } from "../../src/accounts/environment";
import { SettingsError } from "../../src/cli/errors";
import type { Account } from "../../src/core/config/types";

const HOME = "/home/person";
const RELAY_HOME = "/home/person/.relay";

function account(provider: "claude" | "codex", profileDir: string, credentialEnv: string[] = []): Account {
  return { id: `${provider}:work`, provider, name: "work", profileDir, profileDirIsDefault: false, credentialEnv, kind: null };
}

// Fake values built at run time, so no credential-like text is committed.
const value = (name: string) => `value-of-${name.toLowerCase()}`;
const REMOVED = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_BEARER_TOKEN_BEDROCK",
  "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CURSOR_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "RELAY_FAKE_SCENARIO", "RELAY_FAKE_RECORD", "RELAY_JOB", "RELAY_TARGET", "RELAY_WORKER",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID",
];
function base(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color",
    ...Object.fromEntries(REMOVED.map((name) => [name, value(name)])), ...extra,
  };
}

test("every listed credential, profile and test variable is removed and the rest is kept", () => {
  const env = buildAgentEnv(account("claude", join(RELAY_HOME, "profiles", "claude-work")), base());
  for (const name of REMOVED.filter((name) => name !== "CLAUDE_CONFIG_DIR")) expect(env[name]).toBeUndefined();
  for (const removed of REMOVED) expect(Object.values(env)).not.toContain(value(removed));
  expect(env).toMatchObject({ HOME, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color" });
});

test("the profile variable is set to the account's folder, except for the provider's own folder", () => {
  const claude = buildAgentEnv(account("claude", "/profiles/claude-work"), base());
  expect(claude.CLAUDE_CONFIG_DIR).toBe("/profiles/claude-work");
  expect(claude.CODEX_HOME).toBeUndefined();
  const codex = buildAgentEnv(account("codex", "/profiles/codex-work"), base());
  expect(codex.CODEX_HOME).toBe("/profiles/codex-work");
  expect(codex.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(buildAgentEnv(account("claude", join(HOME, ".claude")), base()).CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(buildAgentEnv(account("codex", join(HOME, ".codex")), base()).CODEX_HOME).toBeUndefined();
});

test("credential_env names are copied from relay's environment, only for their own provider", () => {
  const claude = buildAgentEnv(account("claude", "/p", ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]), base());
  expect(claude.ANTHROPIC_API_KEY).toBe(value("ANTHROPIC_API_KEY"));
  expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBe(value("CLAUDE_CODE_OAUTH_TOKEN"));
  expect(claude.OPENAI_API_KEY).toBeUndefined();
  expect(claude.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  const codex = buildAgentEnv(account("codex", "/p", ["OPENAI_API_KEY", "CODEX_API_KEY"]), base());
  expect(codex.OPENAI_API_KEY).toBe(value("OPENAI_API_KEY"));
  expect(codex.CODEX_API_KEY).toBe(value("CODEX_API_KEY"));
  expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
  // A listed variable that relay's environment does not have is simply absent.
  expect(buildAgentEnv(account("claude", "/p", ["ANTHROPIC_API_KEY"]), { HOME }).ANTHROPIC_API_KEY).toBeUndefined();
});

test("an account cannot list another provider's variable or its own profile variable", () => {
  for (const [provider, name] of [["claude", "OPENAI_API_KEY"], ["claude", "CODEX_API_KEY"], ["codex", "ANTHROPIC_API_KEY"],
    ["codex", "CLAUDE_CODE_OAUTH_TOKEN"], ["codex", "CODEX_HOME"], ["claude", "CLAUDE_CONFIG_DIR"], ["claude", "GITHUB_TOKEN"]] as const) {
    let error: unknown;
    try { buildAgentEnv(account(provider, "/p", [name]), base()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as Error).message).toContain(`${provider}:work lists ${name} in credential_env`);
  }
});

test("RELAY_HOME is always set, and the job variables when a worker is known", () => {
  const withoutJob = buildAgentEnv(account("claude", "/p"), base({ RELAY_HOME: "/data/relay" }));
  expect(withoutJob.RELAY_HOME).toBe("/data/relay");
  expect(withoutJob.RELAY_JOB).toBeUndefined();
  expect(withoutJob.RELAY_TARGET).toBeUndefined();
  expect(withoutJob.RELAY_WORKER).toBeUndefined();
  const env = buildAgentEnv(account("claude", "/p"), base(), { jobId: "3f9a2c1d", workerId: "5d2e8f01" });
  expect(env).toMatchObject({ RELAY_HOME, RELAY_JOB: "3f9a2c1d", RELAY_TARGET: "claude:work", RELAY_WORKER: "5d2e8f01" });
});

test("test variables are kept when the test harness asks for them", () => {
  const env = buildAgentEnv(account("claude", "/p"), base({ RELAY_KEEP_FAKE_ENV: "1" }));
  expect(env.RELAY_FAKE_SCENARIO).toBe(value("RELAY_FAKE_SCENARIO"));
  expect(env.RELAY_FAKE_RECORD).toBe(value("RELAY_FAKE_RECORD"));
});
