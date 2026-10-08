import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function notBuilt(ctx: CommandContext): Promise<number> {
  ctx.io.err(`relay: ${ctx.def.name} is not built yet. This version only reads your settings and shows help.\n`);
  return ExitCode.NotAvailable;
}
