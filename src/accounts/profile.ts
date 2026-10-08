// Account profile folders (add-provider-adapters, design decision 10).
import { resolve } from "node:path";
import type { Account } from "../core/config/types";
import { resolveHomedir } from "../core/paths";

const DEFAULT_FOLDERS = { claude: ".claude", codex: ".codex" } as const;

// True when the account uses the provider's own folder, ~/.claude or ~/.codex. relay then leaves
// the profile variable unset (design decision 6).
export function usesProviderDefaultFolder(account: Account, home = resolveHomedir(process.env)): boolean {
  return account.profileDir === resolve(home, DEFAULT_FOLDERS[account.provider]);
}
