import { resolve } from "node:path";
import { createClaudeAdapter } from "../../src/adapters/claude/adapter";
import { createCodexAdapter } from "../../src/adapters/codex/adapter";
import type { AdapterContractEntry } from "./contract";
import { MAPPERS } from "./mappers";

export const CONTRACT_ENTRIES: AdapterContractEntry[] = [{
  provider: "claude",
  fakeProgram: resolve(import.meta.dir, "../fakes/fake-claude.ts"),
  createAdapter: () => createClaudeAdapter(),
  transports: [
    { id: "claude-print", fixtureFolder: "claude/print", mapper: MAPPERS["claude-print"] },
    { id: "claude-interactive" },
  ],
}, {
  provider: "codex",
  fakeProgram: resolve(import.meta.dir, "../fakes/fake-codex.ts"),
  createAdapter: () => createCodexAdapter(),
  transports: [
    { id: "codex-app-server", fixtureFolder: "codex/app-server", mapper: MAPPERS["codex-app-server"] },
    { id: "codex-exec", fixtureFolder: "codex/exec", mapper: MAPPERS["codex-exec"] },
    { id: "codex-interactive" },
  ],
}];
