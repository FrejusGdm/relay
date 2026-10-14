// Resume at reset for T3 Code threads (add-resume-at-reset, design decisions 10 and 11). Every 60
// seconds the daemon lists the failed threads of each T3 project through T3's MCP server, reads
// each new failed run of a chosen thread once to see whether a usage limit stopped it, and after the
// reset sends the continue message to that same thread, only when it is idle and its newest run is
// still the one that stopped. T3's own "Resume at reset" is not relied on
// (pingdotgg/t3code#17808). Message texts and thread titles are read but never stored or logged.
import type { AdapterRegistry } from "../adapters/registry";
import { resetTimeInZone } from "../adapters/reset-time";
import { findAccount } from "../accounts/registry";
import type { AccountId, RelayConfig } from "../core/config/types";
import type { Logger } from "../core/log";
import { now } from "../platform/clock";
import { afterReset, checkAccount, CONTINUE_PROMPT, findResetTime, nextUnknownCheck, type ResetTime, type Timing } from "../resume/timing";
import { T3Error, type T3Client } from "./client";
import { readT3State, recordT3Event, withT3Lock, writeT3State, type T3ResumeState, type T3ThreadState } from "./resume-state";

const POLL_MS = 60_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const TAIL_ITEMS = 25;
const SENT_KEPT_MS = 7 * 86_400_000;

// The limit messages in a failed run's error item. T3 writes its own text for Claude ("Claude usage
// limit reached. Send the message again once the limit resets.", "Claude API rate limit reached.
// Try again later.", "Claude stopped: a usage limit blocked the request.") or Claude Code's own
// ("You've hit your session limit · resets 6:50pm (Europe/Berlin)"), and Codex's text for Codex
// ("You've hit your usage limit. ... try again at 6:50 PM."). Source: T3 Code at 80664d5,
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts and CodexAdapterV2.ts.
const LIMIT_TEXT = /hit your (?:session|weekly|opus|sonnet|usage) limit|rate limit reached|usage limit (?:reached|exceeded|blocked)/i;
const FIVE_HOURS_MS = 5 * 3_600_000;
const CREDITS_TEXT = /usage[- ]credits|out of included usage/i;
const RESET_TEXT = /(?:· resets|resets at|try again at)\s+(.+?(?:\s*\([^)]*\))?)(?:$|\. |\.$)/im;

export interface T3ResumerOptions {
  relayHome: string;
  env: Record<string, string | undefined>;
  log: Pick<Logger, "info" | "warn" | "error">;
  timing: Timing;
  random?: () => number;
  config: () => RelayConfig;
  registry: () => AdapterRegistry;
  // A connected client, or null when relay is not connected to T3 Code or the connection expired.
  client: () => Promise<T3Client | null>;
}

type Classification = { kind: "limit"; reset: ResetTime | null } | { kind: "credits" } | { kind: "other" };

export function t3PollMs(env: Record<string, string | undefined>): number {
  const value = Number(env.RELAY_TEST_T3_POLL_MS);
  return process.env.RELAY_TEST === "1" && Number.isInteger(value) && value > 0 ? value : POLL_MS;
}

// Reads a limit stop from the text of a failed run's error item.
export function classifyFailure(text: string, after: Date = now()): Classification {
  if (CREDITS_TEXT.test(text)) return { kind: "credits" };
  if (!LIMIT_TEXT.test(text)) return { kind: "other" };
  const time = RESET_TEXT.exec(text)?.[1];
  const at = time === undefined ? undefined : resetTimeInZone(time.trim(), after);
  return { kind: "limit", reset: at === undefined ? null : { at, source: "message_text" } };
}

export class T3Resumer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;
  private stopped = false;
  private disconnectedLogged = false;

  constructor(private readonly options: T3ResumerOptions) {}

  start(pollMs = POLL_MS): void {
    this.timer = setInterval(() => void this.tick(), pollMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.sweeping;
  }

  async tick(): Promise<void> {
    if (this.sweeping !== null || this.stopped) return this.sweeping ?? undefined;
    this.sweeping = this.sweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweep(): Promise<void> {
    const config = this.options.config();
    const settings = config.t3.resumeAtReset;
    if (settings.accounts.length === 0 && settings.threads.length === 0) return;
    let client: T3Client | null;
    try {
      client = await this.options.client();
    } catch {
      client = null;
    }
    if (client === null) {
      if (!this.disconnectedLogged) this.options.log.warn("t3_resume_not_connected", {});
      this.disconnectedLogged = true;
      return;
    }
    this.disconnectedLogged = false;
    try {
      await this.findStops(client, config);
      await this.actOnDue(client, config);
    } catch (error) {
      this.options.log.warn("t3_resume_failed", { error_name: error instanceof T3Error ? error.kind : error instanceof Error ? error.name : typeof error });
    } finally {
      await client.close().catch(() => {});
    }
  }

  // The account a thread's runs use, when the thread is chosen: by its ID, or by its provider
  // instance's account.
  private chosenAccount(config: RelayConfig, threadId: string, instanceId: unknown): AccountId | null {
    const account = config.t3.instances.find((instance) => instance.id === instanceId)?.account ?? null;
    if (account === null) return null;
    const { accounts, threads } = config.t3.resumeAtReset;
    return threads.includes(threadId) || accounts.includes(account) ? account : null;
  }

  private async findStops(client: T3Client, config: RelayConfig): Promise<void> {
    const { relayHome } = this.options;
    for (const projectId of await listProjects(client)) {
      for (const thread of await listFailedThreads(client, projectId)) {
        if (this.stopped) return;
        const threadId = thread.threadId;
        const runId = thread.latestRunId;
        if (typeof threadId !== "string" || typeof runId !== "string") continue;
        const account = this.chosenAccount(config, threadId, thread.providerInstanceId);
        if (account === null) continue;
        const known = readT3State(relayHome);
        const entry = known.threads[threadId];
        if (known.classified[threadId] === runId) continue;
        if (entry !== undefined && entry.state !== "sent" && entry.run_id === runId) continue;
        // After max_resumes relay stays away from the thread until one of its runs completes.
        if (entry?.state === "gave_up") continue;
        const read = await this.classify(client, threadId, runId);
        const found = read?.found ?? null;
        await withT3Lock(relayHome, async () => {
          const state = readT3State(relayHome);
          const current = state.threads[threadId];
          // relay resume-at-reset off, or another sweep, handled this run while relay read it.
          if (state.classified[threadId] === runId || (current !== undefined && current.state !== "sent" && current.run_id === runId)) return;
          if (current?.state === "gave_up") return;
          if (found === null || found.kind !== "limit") {
            state.classified[threadId] = runId;
            if (current?.state === "sent") delete state.threads[threadId];
            writeT3State(relayHome, state);
            if (found?.kind === "credits") recordT3Event(relayHome, "skipped", { thread_id: threadId, run_id: runId, account, reason: "credits_required" });
            return;
          }
          await this.startWaiting(state, threadId, runId, account, found.reset, current, config, read!.at);
        });
      }
    }
  }

  // Reads the newest run's last timeline items once: a usage limit, a credits stop, or another
  // failure. Null when the thread has an active run or the run is not the failed one any more.
  // Reset times in the messages are read as the next moment after the run failed, so a stop found
  // after its reset is due at once instead of a day later.
  private async classify(client: T3Client, threadId: string, runId: string): Promise<{ found: Classification; at: Date } | null> {
    const head = await client.call("t3_thread_read", { threadId, view: "activity", limit: 1, runLimit: 1 }, { threadId });
    const detail = record(head.thread);
    const newest = Array.isArray(head.recentRuns) ? record(head.recentRuns[0]) : {};
    if (detail.activeRunId !== null && detail.activeRunId !== undefined) return null;
    if (newest.runId !== runId || newest.status !== "failed") return null;
    const ended = typeof newest.completedAt === "string" && !Number.isNaN(Date.parse(newest.completedAt)) ? new Date(newest.completedAt) : now();
    const at = ended > now() ? now() : ended;
    const count = typeof detail.itemCount === "number" && Number.isInteger(detail.itemCount) ? detail.itemCount : 0;
    const after = count - TAIL_ITEMS - 1;
    const tail = await client.call("t3_thread_read", {
      threadId, view: "activity", limit: TAIL_ITEMS, runLimit: 1, ...(after >= 0 ? { afterPosition: after } : {}),
    }, { threadId });
    const items = Array.isArray(tail.items) ? tail.items.map(record).filter((item) => item.runId === runId && typeof item.text === "string") : [];
    const errors = items.filter((item) => item.type === "error");
    for (const item of errors.reverse()) {
      const found = classifyFailure(item.text as string, at);
      if (found.kind !== "limit" || found.reset !== null) {
        if (found.kind !== "other") return { found, at };
        continue;
      }
      // T3's own text has no reset time; Claude Code's message in the same run often has it.
      for (const other of items.toReversed()) {
        const again = classifyFailure(other.text as string, at);
        if (again.kind === "limit" && again.reset !== null) return { found: again, at };
      }
      return { found, at };
    }
    return { found: { kind: "other" }, at };
  }

  private async startWaiting(
    state: T3ResumeState, threadId: string, runId: string, account: AccountId, textReset: ResetTime | null,
    current: T3ThreadState | undefined, config: RelayConfig, stoppedAt: Date,
  ): Promise<void> {
    const { relayHome, timing } = this.options;
    // A stop of the run relay's own message started counts toward max_resumes.
    const inARow = current?.state === "sent" && current.sent_run_id === runId ? current.sends_in_a_row + (current.counted ? 1 : 0) : 0;
    recordT3Event(relayHome, "limit_seen", { thread_id: threadId, run_id: runId, account });
    if (inARow >= config.t3.resumeAtReset.maxResumes) {
      state.threads[threadId] = { ...waitingEntry(account, runId, null, now()), state: "gave_up", sends_in_a_row: inARow };
      writeT3State(relayHome, state);
      recordT3Event(relayHome, "gave_up", { thread_id: threadId, run_id: runId, account, reason: "limit_again", sends_in_a_row: inARow });
      return;
    }
    const relayAccount = findAccount(config, account);
    const reset = relayAccount === undefined ? textReset : await findResetTime({
      stopReset: textReset, stoppedAt: new Date(stoppedAt.getTime() - 1), account: relayAccount,
      adapter: this.options.registry().get(relayAccount.provider), relayHome, env: this.options.env,
    });
    const next = reset !== null ? afterReset(reset.at, timing, this.options.random) : nextUnknownCheck(now(), timing, this.options.random);
    state.threads[threadId] = { ...waitingEntry(account, runId, reset, stoppedAt), next_check_at: next.toISOString(), sends_in_a_row: inARow };
    writeT3State(relayHome, state);
    recordT3Event(relayHome, "waiting", {
      thread_id: threadId, run_id: runId, account, reset_at: reset?.at.toISOString() ?? null, source: reset?.source ?? null,
      next_check_at: next.toISOString(),
    });
  }

  private async actOnDue(client: T3Client, config: RelayConfig): Promise<void> {
    const { relayHome, timing } = this.options;
    const state = readT3State(relayHome);
    for (const [threadId, entry] of Object.entries(state.threads)) {
      if (this.stopped) return;
      if (entry.state === "gave_up") {
        await this.endGaveUpOnCompletion(client, threadId, entry);
        continue;
      }
      if (entry.state === "sent" && entry.sent_at !== null && now().getTime() - Date.parse(entry.sent_at) > SENT_KEPT_MS) {
        await this.change(threadId, entry.run_id, (current) => (current.state === "sent" ? null : current));
        continue;
      }
      if (entry.state !== "waiting" || entry.next_check_at === null || Date.parse(entry.next_check_at) > now().getTime()) continue;
      const { accounts, threads } = config.t3.resumeAtReset;
      if (!threads.includes(threadId) && !accounts.includes(entry.account as AccountId)) {
        await this.drop(threadId, entry, "turned_off");
        continue;
      }
      if (entry.reset_at === null) {
        if (now().getTime() - Date.parse(entry.waiting_since) >= timing.maxUnknownMs) {
          await this.change(threadId, entry.run_id, (current) => ({ ...current, state: "gave_up" }));
          recordT3Event(relayHome, "gave_up", { thread_id: threadId, run_id: entry.run_id, account: entry.account, reason: "no_reset_time", sends_in_a_row: entry.sends_in_a_row });
          continue;
        }
        const account = findAccount(config, entry.account);
        if (account !== undefined) {
          const result = await checkAccount({
            account, adapter: this.options.registry().get(account.provider), relayHome, env: this.options.env, stoppedAt: new Date(entry.waiting_since),
          });
          // Without any reading relay does not try a send that would only fail in the person's
          // thread; it sends once 5 hours have passed, the longest a session limit lasts.
          if (result.kind === "resuming" && result.basis === "no_reading" && now().getTime() - Date.parse(entry.waiting_since) < FIVE_HOURS_MS) {
            const next = nextUnknownCheck(now(), timing, this.options.random);
            await this.change(threadId, entry.run_id, (current) => ({ ...current, next_check_at: next.toISOString() }));
            recordT3Event(relayHome, "checked", {
              thread_id: threadId, run_id: entry.run_id, account: entry.account, result: "no_reading", reset_at: null, next_check_at: next.toISOString(),
            });
            continue;
          }
          if (result.kind !== "resuming") {
            const next = result.kind === "reset_known" ? afterReset(result.reset.at, timing, this.options.random) : nextUnknownCheck(now(), timing, this.options.random);
            await this.change(threadId, entry.run_id, (current) => ({
              ...current, next_check_at: next.toISOString(),
              ...(result.kind === "reset_known" ? { reset_at: result.reset.at.toISOString(), source: result.reset.source } : {}),
            }));
            recordT3Event(relayHome, "checked", {
              thread_id: threadId, run_id: entry.run_id, account: entry.account, result: result.kind,
              reset_at: result.kind === "reset_known" ? result.reset.at.toISOString() : null, next_check_at: next.toISOString(),
            });
            continue;
          }
        }
        recordT3Event(relayHome, "checked", { thread_id: threadId, run_id: entry.run_id, account: entry.account, result: "resuming", reset_at: null, next_check_at: null });
      }
      await this.send(client, threadId, entry);
    }
  }

  // Sends continue to the thread when it is idle and its newest run is still the one that stopped.
  private async send(client: T3Client, threadId: string, entry: T3ThreadState): Promise<void> {
    const { relayHome, timing } = this.options;
    const read = await client.call("t3_thread_read", { threadId, view: "activity", limit: 1, runLimit: 1 }, { threadId });
    const detail = record(read.thread);
    const newest = Array.isArray(read.recentRuns) ? record(read.recentRuns[0]).runId : undefined;
    if (newest !== entry.run_id) {
      await this.drop(threadId, entry, "thread_moved_on");
      return;
    }
    if (detail.activeRunId !== null && detail.activeRunId !== undefined) {
      const next = nextUnknownCheck(now(), timing, this.options.random);
      await this.change(threadId, entry.run_id, (current) => ({ ...current, next_check_at: next.toISOString() }));
      recordT3Event(relayHome, "skipped", { thread_id: threadId, run_id: entry.run_id, account: entry.account, reason: "thread_busy", next_check_at: next.toISOString() });
      return;
    }
    // Recorded before the call, so a daemon that stops after the call never sends again.
    const sentAt = now().toISOString();
    const marked = await this.change(threadId, entry.run_id, (current) => (current.state === "waiting"
      ? { ...current, state: "sent", sent_at: sentAt, counted: current.reset_at !== null, next_check_at: null } : current));
    if (marked?.state !== "sent" || marked.sent_at !== sentAt) return;
    let result: Record<string, unknown>;
    try {
      result = await client.call("t3_thread_send", {
        threadId, message: CONTINUE_PROMPT, mode: "queue", clientRequestId: `relay-resume-${threadId}-${entry.run_id}`,
      }, { threadId });
    } catch (error) {
      // T3 ignores a repeated clientRequestId, so trying again later can never send twice.
      const next = nextUnknownCheck(now(), timing, this.options.random);
      await this.change(threadId, entry.run_id, (current) => ({ ...current, state: "waiting", sent_at: null, next_check_at: next.toISOString() }));
      recordT3Event(relayHome, "skipped", {
        thread_id: threadId, run_id: entry.run_id, account: entry.account, reason: error instanceof T3Error ? error.kind : "send_failed",
        next_check_at: next.toISOString(),
      });
      return;
    }
    const sentRun = typeof result.runId === "string" ? result.runId : null;
    await this.change(threadId, entry.run_id, (current) => ({ ...current, sent_run_id: sentRun }));
    recordT3Event(relayHome, "sent", { thread_id: threadId, run_id: entry.run_id, account: entry.account, new_run_id: sentRun });
    this.options.log.info("t3_resume_sent", { thread: threadId, account: entry.account });
  }

  // A thread relay gave up on is watched again once one of its runs completes.
  private async endGaveUpOnCompletion(client: T3Client, threadId: string, entry: T3ThreadState): Promise<void> {
    const read = await client.call("t3_thread_read", { threadId, view: "activity", limit: 1, runLimit: 1 }, { threadId });
    const newest = Array.isArray(read.recentRuns) ? record(read.recentRuns[0]) : {};
    if (newest.status !== "completed") return;
    await this.change(threadId, entry.run_id, (current) => (current.state === "gave_up" ? null : current));
    recordT3Event(this.options.relayHome, "watching_again", { thread_id: threadId, run_id: typeof newest.runId === "string" ? newest.runId : null, account: entry.account });
  }

  private async drop(threadId: string, entry: T3ThreadState, reason: string): Promise<void> {
    const { relayHome } = this.options;
    await withT3Lock(relayHome, () => {
      const state = readT3State(relayHome);
      if (state.threads[threadId]?.run_id !== entry.run_id) return;
      delete state.threads[threadId];
      // The stopped run is handled; a newer run is classified on its own.
      state.classified[threadId] = entry.run_id;
      writeT3State(relayHome, state);
    });
    recordT3Event(relayHome, "skipped", { thread_id: threadId, run_id: entry.run_id, account: entry.account, reason });
  }

  // Changes a thread's entry under the lock, when it still waits for the same run. `update` returns
  // the new entry, or null to forget it.
  private async change(threadId: string, runId: string, update: (current: T3ThreadState) => T3ThreadState | null): Promise<T3ThreadState | null> {
    const { relayHome } = this.options;
    return await withT3Lock(relayHome, () => {
      const state = readT3State(relayHome);
      const current = state.threads[threadId];
      if (current === undefined || current.run_id !== runId) return null;
      const next = update(current);
      if (next === null) delete state.threads[threadId];
      else state.threads[threadId] = next;
      writeT3State(relayHome, state);
      return next;
    });
  }
}

function waitingEntry(account: string, runId: string, reset: ResetTime | null, at: Date): T3ThreadState {
  return {
    account, run_id: runId, state: "waiting", reset_at: reset?.at.toISOString() ?? null, source: reset?.source ?? null,
    next_check_at: null, waiting_since: at.toISOString(), sends_in_a_row: 0, counted: false, sent_run_id: null, sent_at: null,
  };
}

async function listProjects(client: T3Client): Promise<string[]> {
  const ids: string[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.call("t3_project_list", { limit: PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) });
    const projects = Array.isArray(result.projects) ? result.projects.map(record) : [];
    for (const project of projects) if (typeof project.id === "string") ids.push(project.id);
    cursor = typeof result.nextCursor === "number" ? result.nextCursor : null;
    if (cursor === null) break;
  }
  return ids;
}

async function listFailedThreads(client: T3Client, projectId: string): Promise<Record<string, unknown>[]> {
  const threads: Record<string, unknown>[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.call("t3_thread_list", { projectId, statuses: ["failed"], limit: PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) });
    threads.push(...(Array.isArray(result.threads) ? result.threads.map(record) : []));
    cursor = typeof result.nextCursor === "number" ? result.nextCursor : null;
    if (cursor === null) break;
  }
  return threads;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
