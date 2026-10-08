// The Claude Code adapter (add-provider-adapters). This version finds the program, reads its
// version and sign-in state, and names its login command; starting workers comes in task group 7.
import type { Account } from "../../core/config/types";
import { policyOf } from "../../policies/load";
import { detectProgram, findProgram, runProgram } from "../program";
import type { Capabilities, ProviderAdapter, Transport } from "../types";
import tested from "./tested-versions.json";

type Env = Record<string, string | undefined>;

const CAPABILITIES: Partial<Record<Transport, Capabilities>> = {
  "claude-print": { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  "claude-interactive": { streamingInput: false, cleanInterrupt: false, nativeResume: true, limitPercentBeforeHit: true, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
};

// authMethod is kept only when it looks like a method name, so an address or an identifier that a
// later version might put there is never stored.
const METHOD = /^[A-Za-z][A-Za-z0-9._ -]{0,39}$/;

export function createClaudeAdapter(env: Env = process.env): ProviderAdapter {
  return {
    provider: "claude",
    displayName: "Claude Code",
    policy: policyOf("claude"),
    capabilities(transport) {
      const capabilities = CAPABILITIES[transport];
      if (capabilities === undefined) throw new Error(`Claude Code has no ${transport} transport.`);
      return capabilities;
    },
    detect: () => detectProgram("claude", env, /^(\d+\.\d+\.\d+) \(Claude Code\)/, tested.tested),
    async authStatus(_account: Account, agentEnv: Record<string, string>) {
      const path = findProgram("claude", env);
      if (path === null) return { signedIn: false };
      const { code, stdout } = await runProgram(path, ["auth", "status", "--json"], agentEnv);
      if (code !== 0) return { signedIn: false };
      let method: unknown;
      try {
        method = (JSON.parse(stdout) as { authMethod?: unknown }).authMethod;
      } catch {
        method = undefined;
      }
      return typeof method === "string" && METHOD.test(method) && !method.includes("@")
        ? { signedIn: true, method }
        : { signedIn: true };
    },
    loginCommand: () => ["claude", "auth", "login"],
    start: () => Promise.reject(new Error("Starting Claude Code workers is not built yet.")),
    availability: () => Promise.reject(new Error("Claude Code availability is not built yet.")),
    hookSpec: () => ({
      file: "settings.json",
      events: ["SessionStart", "Stop", "StopFailure", "Notification", "SessionEnd", "PreCompact"],
    }),
  };
}
