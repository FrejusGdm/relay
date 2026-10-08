// Finding a provider's program and reading its version (add-provider-adapters, design decisions 2
// and 11). Shared by the Claude Code and Codex adapters.
import { isAbsolute, join } from "node:path";
import { buildAgentEnv } from "../accounts/environment";
import type { Account } from "../core/config/types";
import { resolveHomedir } from "../core/paths";
import { runShortCommand } from "./process";
import type { Detection, ProviderId } from "./types";

type Env = Record<string, string | undefined>;

const PROGRAM: Record<ProviderId, { name: string; variable: string; folder: string }> = {
  claude: { name: "claude", variable: "RELAY_CLAUDE_BIN", folder: ".claude" },
  codex: { name: "codex", variable: "RELAY_CODEX_BIN", folder: ".codex" },
};
const TIME_LIMIT_MS = 15_000;

// The absolute path of the program: RELAY_CLAUDE_BIN or RELAY_CODEX_BIN when set, otherwise the
// first match on PATH. Null when there is none.
export function findProgram(provider: ProviderId, env: Env): string | null {
  const { name, variable } = PROGRAM[provider];
  const configured = env[variable];
  if (configured) return isAbsolute(configured) ? configured : null;
  return Bun.which(name, { PATH: env.PATH ?? "" });
}

// The environment for commands that do not belong to an account, such as --version: relay's
// environment without credential variables, as for an account in the provider's own folder.
export function providerEnv(provider: ProviderId, env: Env): Record<string, string> {
  const home = resolveHomedir(env);
  const account: Account = {
    id: `${provider}:default`, provider, name: "default", profileDir: join(home, PROGRAM[provider].folder),
    profileDirIsDefault: false, credentialEnv: [], kind: null,
  };
  return buildAgentEnv(account, env);
}

export function runProgram(path: string, args: string[], env: Record<string, string>) {
  return runShortCommand({ path, args, env, timeoutMs: TIME_LIMIT_MS });
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// Runs `<program> --version` and compares the version with the oldest tested one. Newer versions
// are accepted.
export async function detectProgram(
  provider: ProviderId,
  env: Env,
  pattern: RegExp,
  tested: string[],
): Promise<Detection> {
  const path = findProgram(provider, env);
  if (path === null) return { installed: false };
  let output: { code: number | null; stdout: string };
  try {
    output = await runProgram(path, ["--version"], providerEnv(provider, env));
  } catch {
    return { installed: false };
  }
  const version = pattern.exec(output.stdout.trim())?.[1];
  if (output.code !== 0 || version === undefined) return { installed: true, path };
  const oldest = [...tested].sort(compareVersions)[0]!;
  return { installed: true, path, version, ...(compareVersions(version, oldest) < 0 ? { tooOld: { oldest } } : {}) };
}
