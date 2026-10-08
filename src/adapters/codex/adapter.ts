// The Codex adapter (add-provider-adapters). This version finds the program, reads its version
// and sign-in state, and names its login command; starting workers comes in task group 8.
import { policyOf } from "../../policies/load";
import { detectProgram, findProgram, runProgram } from "../program";
import type { Capabilities, ProviderAdapter, Transport } from "../types";
import tested from "./tested-versions.json";

type Env = Record<string, string | undefined>;

const CAPABILITIES: Partial<Record<Transport, Capabilities>> = {
  "codex-app-server": { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: true, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  "codex-exec": { streamingInput: false, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "text", observesExternalSessions: "hooks" },
  "codex-interactive": { streamingInput: false, cleanInterrupt: false, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "none", observesExternalSessions: "hooks" },
};

export function createCodexAdapter(env: Env = process.env): ProviderAdapter {
  return {
    provider: "codex",
    displayName: "Codex",
    policy: policyOf("codex"),
    capabilities(transport) {
      const capabilities = CAPABILITIES[transport];
      if (capabilities === undefined) throw new Error(`Codex has no ${transport} transport.`);
      return capabilities;
    },
    detect: () => detectProgram("codex", env, /^codex-cli (\d+\.\d+\.\d+)/, tested.tested),
    // Only the exit code and two fixed phrases are read; the rest of the output is discarded.
    async authStatus(_account, agentEnv) {
      const path = findProgram("codex", env);
      if (path === null) return { signedIn: false };
      const { code, stdout } = await runProgram(path, ["login", "status"], agentEnv);
      if (code !== 0) return { signedIn: false };
      const method = stdout.includes("ChatGPT") ? "ChatGPT" : stdout.includes("API key") ? "API key" : undefined;
      return method === undefined ? { signedIn: true } : { signedIn: true, method };
    },
    loginCommand: () => ["codex", "login"],
    start: () => Promise.reject(new Error("Starting Codex workers is not built yet.")),
    availability: () => Promise.reject(new Error("Codex availability is not built yet.")),
    hookSpec: () => ({ file: "hooks.json", events: ["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"] }),
  };
}
