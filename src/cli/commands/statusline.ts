// relay statusline claude: see src/hooks/statusline.ts.
import type { RelayConfig } from "../../core/config/types";
import { runStatusLine } from "../../hooks/statusline";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export function statusline(ctx: CommandContext): Promise<number> {
  return run(ctx, ctx.config);
}

// With invalid settings, the person's own status line still shows.
export function statuslineWithoutSettings(ctx: Omit<CommandContext, "config">): Promise<number> {
  return run(ctx, null);
}

async function run(ctx: Omit<CommandContext, "config">, config: RelayConfig | null): Promise<number> {
  if (ctx.positionals[0] !== "claude") {
    ctx.log.info("statusline ignored: only claude has a status line");
    return ExitCode.Ok;
  }
  return runStatusLine({ io: ctx.io, env: ctx.env, config, relayHome: ctx.relayHome, homedir: ctx.homedir });
}
