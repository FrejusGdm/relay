// relay hook <provider> <event>: see src/hooks/hook-command.ts.
import { runHook } from "../../hooks/hook-command";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function hook(ctx: CommandContext): Promise<number> {
  const [provider, event] = ctx.positionals as [string, string];
  await runHook({ provider, event, io: ctx.io, log: ctx.log, env: ctx.env, relayHome: ctx.relayHome });
  return ExitCode.Ok;
}
