// relay switch <provider[:account]> (the agent-switch spec; add-relay-switch, design decisions 1,
// 15, 23 and 24). The preflight and the person's answers happen here. When a relay run in another
// terminal holds the job's agent, relay switch hands the switch to it and prints its lines;
// otherwise it runs the switch itself and stays to supervise the next agent, as relay run would.
import { createAdapterRegistry } from "../../adapters/registry";
import type { PermissionLevel } from "../../adapters/types";
import { CommandError } from "../../cli/errors";
import { ExitCode } from "../../cli/exit-codes";
import type { Asker } from "../../handoff/ask";
import { recoverSwitch } from "../../handoff/journal";
import { preflight } from "../../handoff/preflight";
import { findJob } from "../../checkpoint/save";
import { openRepository, RepositoryError } from "../../git/repo";
import { sendSwitchRequest } from "../../run/control";
import { checksLine, handoffEnv, JobSupervisor, parseChecks, stderrText, switchJson } from "../../run/run";
import type { CommandContext } from "./registry";

const LEVELS = ["read-only", "edit-in-workspace", "full-access"];

export async function switchCommand(ctx: CommandContext): Promise<number> {
  const json = ctx.values.json === true;
  // With --json, standard output holds only the result; questions and other lines go to standard error.
  const say = (line: string) => (json ? ctx.io.err(`${line}\n`) : ctx.io.out(`${line}\n`));
  const progress = (line: string) => {
    if (!json) ctx.io.out(`${line}\n`);
  };
  let supervisor: JobSupervisor | null = null;
  try {
    const newChecks = parseChecks(ctx.values.check as string[] | undefined);
    const permission = ctx.values.permission as string | undefined;
    if (permission !== undefined && !LEVELS.includes(permission)) {
      throw new CommandError(ExitCode.Usage, ["--permission must be read-only, edit-in-workspace or full-access."]);
    }
    if (permission === "full-access") throw new CommandError(ExitCode.Refused, ["relay does not start agents with full access in this version."]);
    let repo;
    try {
      repo = await openRepository(ctx.cwd);
    } catch (error) {
      if (error instanceof RepositoryError) throw new CommandError(ExitCode.NotPossibleHere, error.lines);
      throw error;
    }
    // 0. Recovery of a switch that did not finish.
    const recovered = await recoverSwitch(repo, findJob(repo, ctx.relayHome).job);
    if (recovered !== null) say(recovered);

    const registry = createAdapterRegistry({}, ctx.env);
    const asker: Asker = {
      terminal: ctx.io.isTerminal, yes: ctx.values.yes === true, say,
      ask: async (question) => {
        (json ? ctx.io.err : ctx.io.out)(`${question} `);
        return ctx.io.readLine();
      },
    };
    const pre = await preflight(handoffEnv(ctx, registry), {
      cwd: ctx.cwd, arg: ctx.positionals[0]!, command: "switch", startMode: ctx.values["no-start"] === true ? "none" : "interactive",
      ...(permission === undefined ? {} : { permission: permission as PermissionLevel }),
      noSummary: ctx.values["no-summary"] === true, newChecks, asker, held: null,
    });
    if (newChecks !== null) say(checksLine(newChecks));

    if (pre.supervisor !== null) {
      if (!pre.supervisor.checked) {
        throw new CommandError(ExitCode.CannotStop, [`The relay run for this job (process ${pre.supervisor.pid}) did not answer within 5 seconds. Nothing changed.`]);
      }
      const personal = pre.confirmations.find((confirmation) => confirmation.question.startsWith("This job ran on a work account"));
      const reply = await sendSwitchRequest(ctx.relayHome, pre.job.id, pre.supervisor, {
        to: pre.to.id,
        answers: {
          ...(pre.allowed === null ? {} : { newAccount: pre.allowed.how }),
          ...(personal === undefined ? {} : { personalAccount: personal.how }),
          ...(pre.instructionFiles === null ? {} : { instructionFiles: { how: pre.instructionFiles.how, paths: pre.instructionFiles.paths } }),
        },
        ask_for_notes: pre.askForNotes, new_checks: newChecks, no_start: ctx.values["no-start"] === true,
        client_pid: process.pid, created_at: new Date().toISOString(),
      }, progress);
      if (reply.exit_code !== ExitCode.Ok) {
        ctx.io.err(stderrText(reply.errors));
        return reply.exit_code;
      }
      if (json && reply.result !== null) ctx.io.out(`${JSON.stringify(reply.result)}\n`);
      return ExitCode.Ok;
    }

    supervisor = new JobSupervisor(ctx, pre.job, registry, progress, false);
    const { worker, result } = await supervisor.handoff(pre, asker);
    if (json) ctx.io.out(`${JSON.stringify(switchJson(result))}\n`);
    if (worker === null) return ExitCode.Ok;
    return await supervisor.supervise(worker);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    ctx.io.err(stderrText(error.lines));
    return error.code;
  } finally {
    supervisor?.close();
  }
}
