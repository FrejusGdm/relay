// The daemon's calls into the checkpoint engine (add-checkpoint-engine) and the switch engine
// (add-relay-switch), design.md decision 17. It is the only daemon file that imports them, so a
// renamed engine function changes one file. The project folder always comes from the index, never
// from the request, and is checked to still hold the job before an engine runs.
import { createAdapterRegistry } from "../adapters/registry";
import { ProjectMissing, TargetNotFound } from "../api/engine-errors";
import { listCheckpoints } from "../checkpoint/list";
import { findJob, saveCheckpoint } from "../checkpoint/save";
import { loadConfig } from "../core/config/load";
import type { RelayConfig } from "../core/config/types";
import type { Io } from "../cli/io";
import { openRepository, type Repository } from "../git/repo";
import type { Asker } from "../handoff/ask";
import { preflight, type HandoffEnv } from "../handoff/preflight";
import { CommandError } from "../cli/errors";
import { handSwitchOver } from "../run/control";
import { JobSupervisor, switchJson, type SupervisorContext } from "../run/run";
import type { CheckpointView } from "../state/queries";
import type { HeadlessWorkers } from "./workers";

export interface EngineContext {
  relayHome: string;
  homedir: string;
  env: Record<string, string | undefined>;
  workers: HeadlessWorkers;
}

export interface JobPlace {
  id: string;
  root: string;
}

// The daemon has no terminal: nothing is read, and the lines relay would print are dropped. Headless
// agents write their output to their own log files.
const NO_TERMINAL: Io = {
  out: () => {},
  err: () => {},
  stdinIsTTY: false,
  stdoutIsTTY: false,
  isTerminal: false,
  readStdin: async () => Buffer.alloc(0),
  readLine: async () => null,
};

// POST /v1/jobs/{job}/checkpoint: a manual checkpoint, as relay checkpoint saves it. `created` is
// false when nothing changed since the latest checkpoint, which is then the one returned.
export async function checkpointJob(
  ctx: EngineContext, job: JobPlace, message: string | undefined,
): Promise<{ created: boolean; checkpoint: CheckpointView }> {
  const config = readConfig(ctx);
  const repo = await openProject(ctx.relayHome, job);
  const saved = await saveCheckpoint(repo, {
    relayHome: ctx.relayHome, command: "checkpoint", kind: "manual", maxFileSizeMb: config.checkpoint.maxFileSizeMb, env: ctx.env,
    ...(message === undefined ? {} : { message }),
  });
  const number = saved.saved ? saved.number : saved.latest;
  const found = (await listCheckpoints(repo, job.id)).find((checkpoint) => checkpoint.number === number);
  if (found === undefined) throw new Error(`checkpoint ${number} of job ${job.id} has no ref`);
  return {
    created: saved.saved,
    checkpoint: {
      number, commit: found.commit, ref: found.ref, kind: found.kind, created_at: found.createdAt.toISOString(), message: found.message,
    },
  };
}

// POST /v1/jobs/{job}/switch: relay switch without a terminal. The preflight asks its questions
// with no one to answer them, except the first handoff to a new account when the request confirms
// it, and the next agent must start headless. When a relay process holds the job's agent (a relay
// run in a terminal, or this daemon), the switch goes to that process, as relay switch does.
// Otherwise the daemon runs the switch, and the next agent runs under a job supervisor in the
// daemon. Returns the --json result of relay switch and the next worker's ID.
export async function switchJob(
  ctx: EngineContext, job: JobPlace, target: string, confirmNewProvider: boolean,
): Promise<{ handoff: Record<string, unknown>; workerId: string | null }> {
  const config = readConfig(ctx);
  if (!config.accounts.some((account) => account.id === target)) throw new TargetNotFound(target);
  await openProject(ctx.relayHome, job);
  const registry = createAdapterRegistry({}, ctx.env);
  const env: HandoffEnv = { relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!(), env: ctx.env, config, registry };
  const asker: Asker = {
    terminal: false, yes: false, say: () => {}, ask: async () => null,
    ...(confirmNewProvider ? { preset: { newAccount: "api" as const } } : {}),
  };
  const pre = await preflight(env, {
    cwd: job.root, arg: target, command: "switch", startMode: "headless", noSummary: false, newChecks: null, asker, held: null,
  });

  if (pre.supervisor !== null) {
    const reply = await handSwitchOver(ctx.relayHome, pre, { newChecks: null, noStart: false }, () => {});
    if (reply.exit_code !== 0) throw new CommandError(reply.exit_code, reply.errors);
    const workerId = reply.result?.to_worker_id;
    return { handoff: reply.result ?? {}, workerId: typeof workerId === "string" ? workerId : null };
  }

  const supervisor = new JobSupervisor(supervisorContext(ctx, config), pre.job, registry, () => {}, false, false);
  try {
    const { worker, result } = await supervisor.handoff(pre, asker);
    if (worker === null) supervisor.close();
    else {
      ctx.workers.add(job.id, {
        running: () => supervisor.runningRecord(),
        stop: () => supervisor.stopRunning(),
        done: supervisor.supervise(worker).finally(() => supervisor.close()),
      });
    }
    return { handoff: switchJson(result), workerId: result.toWorkerId };
  } catch (error) {
    supervisor.close();
    throw error;
  }
}

// config.toml is read for each request, because relay account and the allow list change it while
// the daemon runs.
function readConfig(ctx: EngineContext): RelayConfig {
  return loadConfig({ relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!() });
}

// A job supervisor lives as long as its agents, so it reads config.toml again whenever it needs
// it, and keeps the last readable version when the file has a problem.
function supervisorContext(ctx: EngineContext, first: RelayConfig): SupervisorContext {
  let config = first;
  return {
    relayHome: ctx.relayHome,
    homedir: ctx.homedir,
    env: ctx.env,
    io: NO_TERMINAL,
    get config() {
      try {
        config = readConfig(ctx);
      } catch {
        // The last readable settings stay in use.
      }
      return config;
    },
  };
}

// The job's worktree root, checked to be a repository whose .relay/state.json names this job.
async function openProject(relayHome: string, job: JobPlace): Promise<Repository> {
  let repo: Repository;
  try {
    repo = await openRepository(job.root);
  } catch {
    throw new ProjectMissing(job.id, job.root);
  }
  if (repo.worktreeRoot !== job.root || findJob(repo, relayHome).job.id !== job.id) throw new ProjectMissing(job.id, job.root);
  return repo;
}
