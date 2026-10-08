// Whether an agent can start on an account (the agent-runs spec): its program is installed and not
// older than the oldest tested version, the account's profile folder is safe, and the account is
// signed in or its key variable is set. relay run and relay switch both check this before they
// change anything.
import { buildAgentEnv } from "../accounts/environment";
import { checkProfileFolder } from "../accounts/profile";
import { authFact, updateAccountRecord } from "../accounts/record";
import type { ProviderAdapter } from "../adapters/types";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Account } from "../core/config/types";

export async function checkAgentReady(
  ctx: { relayHome: string; homedir: string; env: Record<string, string | undefined> },
  adapter: ProviderAdapter,
  account: Account,
): Promise<{ version: string | null }> {
  const detection = await adapter.detect();
  if (!detection.installed) {
    throw new CommandError(ExitCode.ProviderMissing, [`${adapter.displayName} is not installed. Install it, then try again.`]);
  }
  if (detection.tooOld !== undefined) {
    throw new CommandError(ExitCode.ProviderMissing, [
      `relay needs ${adapter.displayName} ${detection.tooOld.oldest} or newer. You have ${detection.version}. ` +
        `Update ${adapter.displayName}, then try again.`,
    ]);
  }
  checkProfileFolder(account.profileDir, process.getuid!(), ctx.homedir);
  if (account.credentialEnv.length > 0) {
    const missing = account.credentialEnv.find((name) => !ctx.env[name]);
    if (missing !== undefined) throw new CommandError(ExitCode.NotSignedIn, [`${account.id} needs $${missing}, which is not set.`]);
  } else {
    const status = await adapter.authStatus(account, buildAgentEnv(account, ctx.env));
    updateAccountRecord(ctx.relayHome, account, { last_auth: authFact(status) });
    if (!status.signedIn) {
      throw new CommandError(ExitCode.NotSignedIn, [`${account.id} is not signed in. Run relay account login ${account.id}.`]);
    }
  }
  return { version: detection.version ?? null };
}
