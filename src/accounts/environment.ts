// The environment of every agent and provider command relay starts (add-provider-adapters, design
// decision 6; docs/research/security.md section 2, "Clean the environment"). It holds no
// credential variable except the ones the account names in credential_env, and never one provider's
// variable in another provider's program.
import { SettingsError } from "../cli/errors";
import type { Account } from "../core/config/types";
import { resolveHomedir, resolveRelayHome } from "../core/paths";
import { usesProviderDefaultFolder } from "./profile";

const REMOVED_PREFIXES = ["ANTHROPIC_", "OPENAI_"];
const REMOVED_NAMES = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CURSOR_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  // Set below when a job is known; a value inherited from an outer agent would name the wrong job.
  "RELAY_JOB",
  "RELAY_TARGET",
  "RELAY_WORKER",
]);
// The test fakes read these; an agent never needs them.
const FAKE_PREFIX = "RELAY_FAKE_";

const PROFILE_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
// The credential variables each provider's account may receive. The profile variable is not one
// of them, so credential_env cannot replace the account's profile folder.
const CREDENTIAL_NAMES = {
  claude: /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_OAUTH_TOKEN)$/,
  codex: /^(?:OPENAI_[A-Z0-9_]+|CODEX_(?!HOME$)[A-Z0-9_]+)$/,
} as const;
const CREDENTIAL_HINT = {
  claude: "ANTHROPIC_ names or CLAUDE_CODE_OAUTH_TOKEN",
  codex: "OPENAI_ or CODEX_ names other than CODEX_HOME",
} as const;

export interface WorkerContext {
  jobId: string;
  workerId: string;
}

export function buildAgentEnv(
  account: Account,
  base: Record<string, string | undefined> = process.env,
  worker?: WorkerContext,
): Record<string, string> {
  const home = resolveHomedir(base);
  const keepFakes = base.RELAY_KEEP_FAKE_ENV === "1";
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || REMOVED_NAMES.has(name)) continue;
    if (REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (name.startsWith(FAKE_PREFIX) && !keepFakes) continue;
    env[name] = value;
  }

  if (!usesProviderDefaultFolder(account, home)) env[PROFILE_VARIABLE[account.provider]] = account.profileDir;

  for (const name of account.credentialEnv) {
    if (!CREDENTIAL_NAMES[account.provider].test(name)) {
      throw new SettingsError([
        `relay: ${account.id} lists ${name} in credential_env, but ${account.provider} accounts may only ` +
          `receive ${CREDENTIAL_HINT[account.provider]}. Remove it from config.toml.`,
      ]);
    }
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }

  env.RELAY_HOME = resolveRelayHome(base, home);
  if (worker !== undefined) {
    env.RELAY_JOB = worker.jobId;
    env.RELAY_TARGET = account.id;
    env.RELAY_WORKER = worker.workerId;
  }
  return env;
}
