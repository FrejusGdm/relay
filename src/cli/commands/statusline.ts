// relay statusline claude: see src/hooks/statusline.ts.
import { runStatusLine } from "../../hooks/statusline";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function statusline(ctx: CommandContext): Promise<number> {
  if (ctx.positionals[0] !== "claude") {
    ctx.log.info("statusline ignored: only claude has a status line");
    return ExitCode.Ok;
  }
  return runStatusLine({ io: ctx.io, env: ctx.env, config: ctx.config, relayHome: ctx.relayHome, homedir: ctx.homedir });
}
