#!/usr/bin/env bun
import { join } from "node:path";
import { checkFixtures } from "./fixtures.ts";
import { EvalError, planCommand } from "./plan.ts";
import { runCommand } from "./campaign.ts";

const usage = `bun run eval:handoff plan <plan>
bun run eval:handoff run <plan> [--campaign <name>] [--only <run-id>] [--max-runs <n>]
                                [--retry-errors] [--keep-work] [--allow-dirty-fixtures]
bun run eval:handoff summarize <campaign>
bun run eval:handoff check-fixtures [<task-id> ...]
bun run eval:handoff annotate <campaign> <run-id> <text>`;

const [command, ...args] = process.argv.slice(2);
const io = {
  usage,
  out: (text: string) => { process.stdout.write(text); },
  err: (text: string) => { process.stderr.write(text); },
  readLine: async (): Promise<string | null> => {
    for await (const line of console) return line;
    return null;
  },
};
try {
  switch (command) {
    case "plan":
      process.exitCode = await planCommand(args, io);
      break;
    case "run":
      process.exitCode = await runCommand(args, io);
      break;
    case "summarize":
    case "annotate":
      await Bun.write(Bun.stderr, "Not built yet.\n");
      process.exitCode = 1;
      break;
    case "check-fixtures":
      process.exitCode = await checkFixtures({
        tasksDir: join(import.meta.dir, "..", "tasks"),
        taskIds: args,
        out: (text) => { process.stdout.write(text); },
        err: (text) => { process.stderr.write(text); },
      });
      break;
    default:
      await Bun.write(Bun.stderr, `${usage}\n`);
      process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof EvalError)) throw error;
  io.err(`${error.message}\n`);
  process.exitCode = error.exitCode;
}
