// Runs one baseline or handoff run (add-handoff-evaluation design decisions 5 to 10 and 14): it
// prepares the scratch repository, starts `relay run`, follows the event log, switches at the
// interrupt point, measures the result on exported checkpoints and writes the result file.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { countClaims } from "./claims.ts";
import { EventReader, EventType, isStep, POLL_MS } from "./events.ts";
import type { RelayEvent } from "./events.ts";
import { loadFixture } from "./fixtures.ts";
import { checkFreeDisk } from "./guards.ts";
import { InterruptPoint, median, stepTarget } from "./interrupt.ts";
import { measureCommit } from "./measure.ts";
import type { Measurement } from "./measure.ts";
import { EvalError } from "./plan.ts";
import type { PlannedRun } from "./plan.ts";
import { toolVersions } from "./relay-cli.ts";
import type { Relay, RunningRelay, SwitchOutcome } from "./relay-cli.ts";
import { ATTEMPT_STATUSES, counts, readResult, SCHEMA_VERSION, writeResult } from "./result.ts";
import type { RunResult, RunStatus, Segment, Usage } from "./result.ts";
import { measureRework } from "./rework.ts";
import { bypassFlagIn, compareSafety, mentionsFixtures, recordSafety, removeWork } from "./safety.ts";
import { checkTopLevel, createScratchRepo, fixtureVersion } from "./scratch.ts";
import { snapshotStep } from "./snapshot.ts";

// The prompt of the first agent. The task itself is in .relay/task.md.
const PROMPT = "Do the task described in .relay/task.md. Run the tests before you finish.";

const LIMITED_STATUSES = ["rate_limited", "quota_exhausted"];
const LIMIT_REASONS = ["usage_limit", "rate_limit"];
const CONTROL_PERCENTS = [25, 50, 75];
// After this long without an exit, a second SIGINT stops the agent at once.
const SECOND_INTERRUPT_MS = 30_000;
const STILL_WORKING_MS = 5 * 60_000;
const ARTIFACTS = /^(events\.jsonl|relay-run\.log|relay-switch\.log|handoff-prompt\.md|checkpoint\.md|verify\.md|.*\.xml)$/;
const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

export interface RunContext {
  relay: Relay;
  home: string;
  campaign: string;
  campaignDir: string;
  plan: string;
  targets: Record<string, string>;
  repoRoot: string;
  segmentLimitMs: number;
  allowDirtyFixtures: boolean;
  keepWork: boolean;
  stop: AbortSignal;
  out: (text: string) => void;
  pollMs?: number;
  stillWorkingMs?: number;
}

interface RunReport {
  result: RunResult;
  // Set when a worker stopped at its account's limit.
  limit: { target: string; retryAt: string | null } | null;
}

interface Track {
  target: string;
  worker_id: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  steps: number;
  first_step_at: string | null;
  end_reason: string | null;
  exit_code: number | null;
  usage: Usage;
  last_failure: { reason: string; retry_at: string | null } | null;
}

function notReported(): Usage {
  return { source: "not reported", input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, cost_usd_estimate: null };
}

// Sums the turns of one worker. A field stays null until a turn reports it.
function addUsage(usage: Usage, data: Record<string, unknown>): void {
  const reported = typeof data.usage === "object" && data.usage !== null ? data.usage as Record<string, unknown> : null;
  if (reported === null && typeof data.cost_usd_estimate !== "number") return;
  usage.source = "turn_completed";
  for (const field of USAGE_FIELDS) {
    const value = reported?.[field];
    if (typeof value === "number") usage[field] = (usage[field] ?? 0) + value;
  }
  if (typeof data.cost_usd_estimate === "number") usage.cost_usd_estimate = (usage.cost_usd_estimate ?? 0) + data.cost_usd_estimate;
}

function seconds(from: string | null, to: string | null): number | null {
  return from === null || to === null ? null : Math.round((Date.parse(to) - Date.parse(from)) / 1000);
}

// The step counts of the completed baselines of a task on one target in this campaign.
function baselineSteps(campaignDir: string, task: string, target: string): number[] {
  const runs = join(campaignDir, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).flatMap((name) => {
    const path = join(runs, name, "result.json");
    if (!existsSync(path)) return [];
    const result = readResult(path);
    return result.kind === "baseline" && result.task_id === task && result.from_target === target && result.status === "completed"
      ? [result.steps_total] : [];
  });
}

export async function runOne(ctx: RunContext, run: PlannedRun): Promise<RunReport> {
  const tasksDir = join(ctx.repoRoot, "eval", "handoff", "tasks");
  const runnersDir = join(ctx.repoRoot, "eval", "handoff", "runners");
  const fixture = await loadFixture(tasksDir, run.task);
  const from = ctx.targets[run.from]!;
  const to = run.to === null ? null : ctx.targets[run.to]!;
  let baselineMedian: number | null = null;
  let baselinesUsed: number | null = null;
  if (run.kind === "handoff") {
    const steps = baselineSteps(ctx.campaignDir, run.task, from);
    if (steps.length === 0) throw new EvalError(`Run the baselines for ${run.task} on ${from} first. The handoff point depends on them.`, 3);
    baselineMedian = median(steps);
    baselinesUsed = steps.length;
  }
  await checkFreeDisk(ctx.home);
  const taskVersion = await fixtureVersion(ctx.repoRoot, run.task, ctx.allowDirtyFixtures);

  const runDir = join(ctx.campaignDir, "runs", run.id);
  mkdirSync(runDir, { recursive: true });
  for (const name of readdirSync(runDir)) if (ARTIFACTS.test(name)) rmSync(join(runDir, name), { force: true });
  const runLog = join(runDir, "relay-run.log");
  writeFileSync(runLog, "");
  const workDir = join(ctx.home, "work", run.id);
  const indexPath = join(ctx.home, "tmp", `${run.id}.index`);
  const result: RunResult = {
    schema_version: SCHEMA_VERSION, run_id: run.id, campaign: ctx.campaign, plan: ctx.plan, task_id: run.task,
    task_version: taskVersion, kind: run.kind, repetition: run.repetition, from_target: from, to_target: to,
    interrupt_point: run.point, baseline_median_steps: baselineMedian, baseline_runs_used: baselinesUsed,
    interrupt_step_target: null, steps_at_switch: null, status: "harness_error", started_at: new Date().toISOString(),
    ended_at: null, wall_seconds_total: null, steps_total: 0, tools: {}, base_sha: null, segments: [], handoff: null,
    outcome: null, control_points: null,
    safety: { ok: true, violations: [], bypass_flags_seen: false, argv_recorded: true },
    contamination: false, notes: "",
  };
  let limit: RunReport["limit"] = null;
  // Set from callbacks, so the declared types must not narrow to null.
  let running = null as RunningRelay | null;
  let exitCode = null as number | null;

  const usedPercent = async (target: string): Promise<number | null> => {
    try {
      return (await ctx.relay.status(ctx.home, runLog)).find((account) => account.target === target)?.used_percent ?? null;
    } catch {
      return null;
    }
  };

  try {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(indexPath, { force: true });
    result.tools = await toolVersions(ctx.relay.bin, ctx.home);
    const accounts = await ctx.relay.status(ctx.home, runLog);
    for (const target of to === null ? [from] : [from, to]) {
      const account = accounts.find((item) => item.target === target);
      if (account !== undefined && LIMITED_STATUSES.includes(account.status)) {
        throw new EvalError(`${target} is not available (${account.status}). It resets at ${account.retry_at ?? "an unknown time"}.`, 5);
      }
    }
    const { repo, baseSha } = await createScratchRepo({
      repoRoot: ctx.repoRoot, task: run.task, taskVersion, workDir, allowDirty: ctx.allowDirtyFixtures,
    });
    result.base_sha = baseSha;
    await ctx.relay.init(repo, `eval ${run.id}`, runLog);
    writeFileSync(join(repo, ".relay", "task.md"), readFileSync(join(fixture.dir, "task.md")));
    await checkTopLevel(repo);
    const before = await recordSafety(repo);
    // Snapshot 0 is the starting tree with the person's uncommitted note. It is the base for
    // rework, so only lines an agent wrote count as added.
    const startSha = await snapshotStep(repo, indexPath, 0, baseSha);

    // Follow the run.
    const reader = new EventReader(join(repo, ".relay", "events.jsonl"));
    const events: RelayEvent[] = [];
    const tracks: Track[] = [];
    const watcher = run.point === null ? null : new InterruptPoint(run.point, baselineMedian!, fixture.visible_test_match);
    result.interrupt_step_target = watcher?.targetStep ?? null;
    const snapshots = new Map<number, string>();
    let snapshotParent = startSha;
    let steps = 0;
    let triggered = false as boolean;
    let switched = null as SwitchOutcome | null;
    let switchStartedAt = 0;
    let stopReason = null as "person" | "bypass" | "handoff_failed" | "timeout" | null;
    let interruptedAt = 0;
    let secondInterruptSent = false;
    let bypass = null as string | null;
    // used_percent from relay status before the first agent, at the switch for both agents, and at the end.
    const firstBefore = accounts.find((account) => account.target === from)?.used_percent ?? null;
    let firstAfter: number | null = null;
    let nextBefore: number | null = null;
    const runStart = Date.now();
    let segmentStart = runStart;
    let quietSince = runStart;

    const handle = async (event: RelayEvent) => {
      events.push(event);
      if (mentionsFixtures(event, tasksDir)) result.contamination = true;
      const data = event.data;
      if (event.type === EventType.workerStarted) {
        tracks.push({
          target: String(data.target ?? ""), worker_id: String(data.worker_id ?? ""), model: null, started_at: event.ts,
          ended_at: null, steps: 0, first_step_at: null, end_reason: null, exit_code: null, usage: notReported(), last_failure: null,
        });
        if (!Array.isArray(data.argv)) result.safety.argv_recorded = false;
        bypass ??= bypassFlagIn(data.argv);
        return;
      }
      const track = tracks.find((item) => item.worker_id === data.worker_id) ?? tracks.at(-1);
      if (track !== undefined) {
        if (event.type === EventType.workerSessionIdentified && typeof data.model === "string") track.model = data.model;
        if (event.type === EventType.turnCompleted) {
          addUsage(track.usage, data);
          track.last_failure = null;
        }
        if (event.type === EventType.turnFailed) {
          track.last_failure = { reason: String(data.reason), retry_at: typeof data.retry_at === "string" ? data.retry_at : null };
        }
        if (event.type === EventType.workerEnded) {
          track.ended_at = event.ts;
          track.end_reason = typeof data.end_reason === "string" ? data.end_reason : null;
          track.exit_code = typeof data.exit_code === "number" ? data.exit_code : null;
        }
      }
      if (!isStep(event)) return;
      steps++;
      quietSince = Date.now();
      if (track !== undefined) {
        track.steps++;
        track.first_step_at ??= event.ts;
      }
      if (run.kind === "baseline") {
        snapshotParent = await snapshotStep(repo, indexPath, steps, snapshotParent);
        snapshots.set(steps, snapshotParent);
      }
      if (watcher?.feed(event) === true) {
        triggered = true;
        ctx.out(`  Step ${steps} of about ${Math.round(baselineMedian!)} on ${from}. Switching.\n`);
      }
    };

    const interrupt = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason !== null || exitCode !== null) return;
      stopReason = reason;
      interruptedAt = Date.now();
      running!.interrupt();
    };

    running = ctx.relay.startRun(repo, from, PROMPT, runLog);
    void running.exited.then((code) => { exitCode = code; });
    while (true) {
      const finished = exitCode !== null;
      for (const event of await reader.read()) await handle(event);
      if (finished) break;
      if (bypass !== null) interrupt("bypass");
      if (ctx.stop.aborted) interrupt("person");
      // When relay run has already exited, the agent ended on its own and there is nothing to switch.
      if (triggered && switched === null && stopReason === null && exitCode === null) {
        switchStartedAt = Date.now();
        switched = await ctx.relay.switchTo(repo, to!, join(runDir, "relay-switch.log"));
        if (switched.exitCode !== 0) interrupt("handoff_failed");
        else {
          ctx.out(`  Continuing on ${to}.\n`);
          segmentStart = Date.now();
          firstAfter = await usedPercent(from);
          nextBefore = await usedPercent(to!);
        }
      }
      if (stopReason === null && Date.now() - segmentStart > ctx.segmentLimitMs) interrupt("timeout");
      if (stopReason !== null && !secondInterruptSent && Date.now() - interruptedAt > SECOND_INTERRUPT_MS) {
        secondInterruptSent = true;
        running.interrupt();
      }
      if (Date.now() - quietSince >= (ctx.stillWorkingMs ?? STILL_WORKING_MS)) {
        ctx.out(`  Still working: ${steps} ${steps === 1 ? "step" : "steps"}, ${Math.floor((Date.now() - runStart) / 60_000)} min.\n`);
        quietSince = Date.now();
      }
      await Promise.race([Bun.sleep(ctx.pollMs ?? POLL_MS), running.exited]);
    }
    const atEnd = await usedPercent(tracks.at(-1)?.target ?? from);
    result.steps_total = steps;

    if (bypass !== null) {
      result.safety.bypass_flags_seen = true;
      result.safety.violations.push({ check: "bypass_flag", before: null, after: bypass });
    }
    const last = tracks.at(-1);
    const limited = exitCode === 23 || (last?.last_failure != null && LIMIT_REASONS.includes(last.last_failure.reason));
    let status: RunStatus;
    if (stopReason === "person" || ctx.stop.aborted) status = "stopped_by_person";
    else if (bypass !== null) status = "agent_failed";
    else if (limited) status = "limit_reached";
    else if (result.contamination) status = "contaminated";
    else if (stopReason === "handoff_failed") status = "handoff_failed";
    else if (stopReason === "timeout") status = "timed_out";
    else if (exitCode === 24 || last?.last_failure != null) status = "agent_failed";
    else if (exitCode !== 0) {
      status = "harness_error";
      result.notes = `relay run exited with code ${exitCode}.`;
    } else if (run.kind === "handoff" && switched === null) status = "finished_before_interrupt";
    else status = "completed";
    if (limited) limit = { target: last?.target ?? from, retryAt: last?.last_failure?.retry_at ?? null };

    result.segments = tracks.map((track, index): Segment => ({
      target: track.target, worker_id: track.worker_id, model: track.model, started_at: track.started_at,
      ended_at: track.ended_at, wall_seconds: seconds(track.started_at, track.ended_at), steps: track.steps,
      end_reason: track.end_reason, exit_code: track.exit_code, usage: track.usage,
      used_percent_before: index === 0 ? firstBefore : nextBefore,
      used_percent_after: index === tracks.length - 1 ? atEnd : firstAfter,
    }));

    if (run.kind === "handoff" && switched !== null) {
      const handoffEvent = events.find((event) => event.type === EventType.handoff);
      const verifyPath = join(repo, ".relay", "verify.md");
      const verifyText = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : null;
      if (verifyText !== null) writeFileSync(join(runDir, "verify.md"), verifyText);
      const claims = countClaims(verifyText, handoffEvent?.data.mismatches);
      let promptBytes: number | null = null;
      if (switched.result !== null) {
        const prompt = isAbsolute(switched.result.prompt_path) ? switched.result.prompt_path : join(repo, switched.result.prompt_path);
        if (existsSync(prompt)) {
          copyFileSync(prompt, join(runDir, "handoff-prompt.md"));
          promptBytes = statSync(prompt).size;
        }
      }
      const next = tracks[1];
      result.steps_at_switch = tracks[0]?.steps ?? null;
      result.handoff = {
        relay_exit_code: switched.exitCode,
        relay_error: switched.exitCode === 0 ? null : switched.error,
        checkpoint_sha: switched.result?.checkpoint_sha ?? null,
        switch_seconds: switched.seconds,
        next_first_step_seconds: next?.first_step_at ? Math.round((Date.parse(next.first_step_at) - switchStartedAt) / 1000) : null,
        prompt_bytes: promptBytes,
        claims_count: typeof handoffEvent?.data.claims_count === "number" ? handoffEvent.data.claims_count : null,
        ...claims,
        acceptance_at_handoff: null,
      };
    }

    if (!ATTEMPT_STATUSES.includes(status)) {
      const finalSha = await ctx.relay.checkpoint(repo, "eval final", runLog);
      result.wall_seconds_total = Math.round((Date.now() - runStart) / 1000);
      const final = await measureCommit({
        repo, sha: finalSha, fixture, runnersDir,
        visibleXml: join(runDir, "visible-final.xml"), acceptanceXml: join(runDir, "acceptance-final.xml"),
      });
      const regressions = (at: Measurement) => at.acceptancePassing.filter((name) => !final.acceptancePassing.includes(name));
      result.outcome = {
        final_checkpoint_sha: finalSha,
        visible_tests: counts(final.visible!),
        acceptance_tests: { ...counts(final.acceptance), failing: final.acceptance.failing },
        solved: final.acceptance.failed === 0 && final.acceptance.passed === fixture.acceptance_total,
        regressions: [], lines_added_before: null, lines_reverted: null, rework_ratio: null, files_reworked: [],
      };
      const handoffSha = result.handoff?.checkpoint_sha ?? null;
      if (handoffSha !== null) {
        const at = await measureCommit({ repo, sha: handoffSha, fixture, runnersDir, acceptanceXml: join(runDir, "acceptance-handoff.xml") });
        result.handoff!.acceptance_at_handoff = counts(at.acceptance);
        Object.assign(result.outcome, { regressions: regressions(at) }, await measureRework(repo, startSha, handoffSha, finalSha));
      }
      if (run.kind === "baseline") {
        result.control_points = [];
        for (const percent of steps === 0 ? [] : CONTROL_PERCENTS) {
          const step = stepTarget(percent, steps);
          const sha = snapshots.get(step);
          if (sha === undefined) continue;
          const at = await measureCommit({ repo, sha, fixture, runnersDir, acceptanceXml: join(runDir, `acceptance-control-steps-${percent}.xml`) });
          result.control_points.push({
            point: `steps:${percent}`, step, snapshot_sha: sha, acceptance_at_point: counts(at.acceptance),
            regressions: regressions(at), ...await measureRework(repo, startSha, sha, finalSha),
          });
        }
      }
      const tests = result.outcome.acceptance_tests;
      const claims = result.handoff === null ? "" : ` ${result.handoff.claims_found_false} ${result.handoff.claims_found_false === 1 ? "claim" : "claims"} found false.`;
      ctx.out(`  Done in ${Math.round(result.wall_seconds_total / 60)} min. Acceptance tests: ${tests.passed} of ${tests.total} passed.${claims}\n`);
    }

    for (const name of ["events.jsonl", "checkpoint.md"]) {
      if (existsSync(join(repo, ".relay", name))) copyFileSync(join(repo, ".relay", name), join(runDir, name));
    }
    result.safety.violations.unshift(...compareSafety(before, await recordSafety(repo)));
    result.safety.ok = result.safety.violations.length === 0;
    // Ctrl-C while the tests ran: the run starts again next time.
    result.status = ctx.stop.aborted ? "stopped_by_person" : status;
  } catch (error) {
    if (error instanceof EvalError) {
      await removeWork(workDir);
      throw error;
    }
    result.status = "harness_error";
    result.notes = error instanceof Error ? error.message : String(error);
  } finally {
    if (running !== null && exitCode === null) {
      running.interrupt();
      const exited = await Promise.race([running.exited.then(() => true), Bun.sleep(SECOND_INTERRUPT_MS).then(() => false)]);
      if (!exited) running.interrupt();
      await running.exited;
    }
  }
  result.ended_at = new Date().toISOString();
  writeResult(runDir, result);
  if (!ctx.keepWork) await removeWork(workDir);
  rmSync(indexPath, { force: true });
  return { result, limit };
}
