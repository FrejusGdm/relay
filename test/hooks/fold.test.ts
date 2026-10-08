import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import type { Account, RelayConfig } from "../../src/core/config/types";
import { spoolLine } from "../../src/hooks/fields";
import { spoolLineAccount } from "../../src/hooks/fold";
import { statusLineAccount } from "../../src/hooks/statusline";

const HOME = process.env.HOME!;
const profile = join(HOME, "relay-profiles", "claude-work");
const work: Account = { id: "claude:work", provider: "claude", name: "work", profileDir: profile, profileDirIsDefault: false, credentialEnv: [], kind: null };
const config = { accounts: [work] } as unknown as RelayConfig;

// The status line resolves CLAUDE_CONFIG_DIR; a hook line written with the same value must name
// the same account.
for (const dir of [`${profile}/`, join(profile, "..", "claude-work"), relative(process.cwd(), profile)]) {
  test(`a hook line and the status line find the same account for CLAUDE_CONFIG_DIR=${dir}`, () => {
    const line = spoolLine("claude", "Stop", {}, { CLAUDE_CONFIG_DIR: dir }, new Date());
    expect(line.profile).toBe(profile);
    expect(spoolLineAccount(line, config, HOME)?.id).toBe("claude:work");
    expect(spoolLineAccount({ ...line, profile: dir }, config, HOME)?.id).toBe("claude:work");
    expect(statusLineAccount(config, { CLAUDE_CONFIG_DIR: dir }, HOME)?.id).toBe("claude:work");
  });
}
