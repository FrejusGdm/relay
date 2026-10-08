// relay run [<account>] (the agent-runs spec). src/run/run.ts does the work.
import { ProfileError } from "../../accounts/profile";
import { parseChecks, runAgent } from "../../run/run";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function run(ctx: CommandContext): Promise<number> {
  const text = (name: string) => ctx.values[name] as string | undefined;
  try {
    return await runAgent(ctx, {
      account: ctx.positionals[0], headless: ctx.values.headless === true, prompt: text("prompt"),
      promptFile: text("prompt-file"), resume: text("resume"), permission: text("permission"), model: text("model"),
      json: ctx.values.json === true, checks: parseChecks(ctx.values.check as string[] | undefined),
      yes: ctx.values.yes === true, noSummary: ctx.values["no-summary"] === true,
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      ctx.io.err(`${error.message}\n`);
      return ExitCode.Settings;
    }
    if (error instanceof CommandError) {
      ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return error.code;
    }
    throw error;
  }
}
