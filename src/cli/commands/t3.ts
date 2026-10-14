// relay t3 connect and relay t3 disconnect (add-resume-at-reset, the t3-connection delta): the
// sign-in of add-t3-limit-rules (src/t3/oauth.ts), which only a command at the keyboard starts, and
// a list of T3's provider instances to map to relay accounts in config.toml. The token T3 issues
// stays in the operating system's credential store.
import { quote } from "../../core/quote";
import { VERSION } from "../../core/version";
import { createT3Client, T3Error } from "../../t3/client";
import { tokenGetter } from "../../t3/connection";
import { openT3Browser, signIn, signOut } from "../../t3/oauth";
import { osSecretStore } from "../../t3/secrets";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const T3_CODES: Record<T3Error["kind"], number> = {
  not_answering: ExitCode.T3NotAnswering, too_old: ExitCode.T3TooOld, token_rejected: ExitCode.T3Refused,
  tool_failed: ExitCode.Failed, refused_tool: ExitCode.Internal,
};

export async function t3(ctx: CommandContext): Promise<number> {
  const err = (line: string) => ctx.io.err(`${line}\n`);
  const action = ctx.positionals[0];
  const url = ctx.config.t3.url;
  const store = osSecretStore();
  try {
    if (action === "disconnect") {
      await signOut({ url, relayHome: ctx.relayHome, store });
      ctx.io.out("relay is no longer connected to T3 Code.\n");
      return ExitCode.Ok;
    }
    if (action !== "connect") {
      err(`relay: t3 takes connect or disconnect, not ${quote(action ?? "")}.`);
      err('Run "relay t3 --help" for an example.');
      return ExitCode.Usage;
    }
    if (!ctx.io.isTerminal) {
      err("relay: relay t3 connect needs a terminal, because T3 Code asks you for a pairing code. Run it in your terminal.");
      return ExitCode.NeedsPerson;
    }
    await signIn({
      url, relayHome: ctx.relayHome, version: VERSION, store, openBrowser: openT3Browser, print: (line) => ctx.io.out(`${line}\n`),
    });
    ctx.io.out("Connected to T3 Code.\n");
    const client = createT3Client({ url, token: tokenGetter(store, url), logger: ctx.log, version: VERSION });
    try {
      const capabilities = await client.call("orchestrator_capabilities", {});
      const providers = Array.isArray(capabilities.providers) ? capabilities.providers as Record<string, unknown>[] : [];
      const lines = providers.flatMap((provider) => {
        const id = provider.providerInstanceId;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) return [];
        const kind = typeof provider.driverKind === "string" ? provider.driverKind : "";
        const own = ctx.config.accounts.filter((account) => account.provider === kind);
        const account = own.length === 1 ? own[0]!.id : `<your ${kind === "" ? "" : `${kind} `}account>`;
        return [`[t3.instances.${id}]`, `account = "${account}"`, ""];
      });
      if (lines.length > 0) {
        ctx.io.out(`\nTell relay which of your accounts each T3 Code provider uses. Add these tables to config.toml:\n\n${lines.join("\n")}`);
      }
    } finally {
      await client.close().catch(() => {});
    }
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof T3Error) {
      err(`relay: ${error.message}`);
      return T3_CODES[error.kind];
    }
    if (error instanceof Error && error.message.startsWith("t3.url:")) {
      err(`relay: ${error.message}`);
      return ExitCode.Settings;
    }
    throw error;
  }
}
