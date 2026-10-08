import { randomUUID } from "node:crypto";
import { UnsupportedOperation } from "../../src/adapters/types";
import { now } from "../../src/platform/clock";
import type {
  Availability, Capabilities, LimitWindow, ProviderAdapter, ProviderId, ReadingSource,
  Transport, WorkerEvent, WorkerHandle,
} from "../../src/adapters/types";
import { turnSteps, windowName, writeStepFile } from "./scenario";
import type { Scenario } from "./scenario";

export interface FakeAdapterOptions { provider: ProviderId; scenario?: Scenario; clock?: () => Date }

class EventQueue implements AsyncIterable<WorkerEvent> {
  private values: WorkerEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(event: WorkerEvent): void {
    this.values.push(event);
    if (event.kind === "exited") this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WorkerEvent> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) yield value;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

const CAPABILITIES: Record<Transport, Capabilities> = {
  "claude-print": { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  "claude-interactive": { streamingInput: false, cleanInterrupt: false, nativeResume: true, limitPercentBeforeHit: true, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  "codex-app-server": { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: true, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  "codex-exec": { streamingInput: false, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "text", observesExternalSessions: "hooks" },
  "codex-interactive": { streamingInput: false, cleanInterrupt: false, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "none", observesExternalSessions: "hooks" },
};

export function createFakeAdapter(options: FakeAdapterOptions): ProviderAdapter {
  const { provider } = options;
  const scenario: Scenario = options.scenario ?? { version: 1, turns: [] };
  const clock = options.clock ?? now;
  const claude = provider === "claude";
  const displayName = claude ? "Claude Code" : "Codex";
  const version = scenario.tool_version ?? (claude ? "2.1.282" : "0.160.0");
  const source: ReadingSource = claude ? "stream_event" : "provider_api";
  type Reading = Omit<Availability, "account">;
  // The scenario's rate_limits hold for every account until a worker of that account records a
  // reading of its own.
  let initialReading: Reading | undefined;
  const readings = new Map<string, Reading>();
  const initial = scenario.rate_limits;
  if (initial !== undefined) {
    const windows: LimitWindow[] = [];
    for (const window of [initial.primary, initial.secondary]) {
      if (window === undefined) continue;
      const minutes = window.window_minutes;
      windows.push({
        name: minutes === 300 ? "five_hour" : minutes === 10080 ? "seven_day" : `${minutes}_minutes`,
        windowMinutes: minutes, usedPercent: window.used_percent,
        resetsAt: new Date(window.resets_at), source: "provider_api",
      });
    }
    // As for Codex: the reset time is the latest one among the windows at 100 percent or more.
    const full = windows.filter((window) => window.usedPercent! >= 100).map((window) => window.resetsAt!.getTime());
    initialReading = {
      state: initial.reached != null || initial.ordinary_usage_allowed === false ? "quota_exhausted"
        : initial.ordinary_usage_allowed === null ? "unknown" : "available",
      windows, observedAt: clock(), source: "provider_api",
      ...(full.length === 0 ? {} : { retryAt: new Date(Math.max(...full)) }),
    };
  }

  function record(account: string, event: Extract<WorkerEvent, { kind: "limit_update" }>): void {
    const reading = readings.get(account) ?? initialReading;
    const windows = new Map<string, LimitWindow>(reading?.windows.map((window) => [window.name, window] as const));
    for (const window of event.windows) windows.set(window.name, window);
    readings.set(account, {
      state: event.state ?? "unknown", windows: [...windows.values()], observedAt: clock(),
      source: event.source, ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
    });
  }

  return {
    provider, displayName,
    policy: {
      provider, displayName, company: claude ? "Anthropic" : "OpenAI", checkedOn: "2026-10-07", maxAgeDays: 90, signInMethods: [],
      unattendedSubscriptionUse: claude ? "unclear" : "allowed", sameProviderAutomaticSwitching: "off", ownAccountsNote: "A fake note.",
      usageSignals: [], summary: "A fake provider for tests.", unclear: "", terms: [],
    },
    capabilities: (transport) => ({ ...CAPABILITIES[transport] }),
    async detect() { return { installed: true, path: "(in-process fake)", version }; },
    async authStatus() {
      return { signedIn: scenario.auth?.signed_in ?? true, method: scenario.auth?.method ?? (claude ? "claude.ai" : "ChatGPT") };
    },
    loginCommand: () => claude ? ["claude", "auth", "login"] : ["codex", "login"],
    hookSpec: () => claude
      ? { file: "settings.json", events: ["SessionStart", "Stop", "StopFailure", "Notification", "SessionEnd", "PreCompact"] }
      : { file: "hooks.json", events: ["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"] },
    async availability(account) {
      const reading = readings.get(account.id) ?? initialReading;
      if (reading === undefined) return { account: account.id, state: "unknown", windows: [], observedAt: clock(), source: "none" };
      const result = { account: account.id, ...reading, windows: reading.windows.map((window) => ({ ...window })) };
      if ((result.state === "quota_exhausted" || result.state === "rate_limited") && result.retryAt !== undefined && result.retryAt <= clock()) {
        delete result.retryAt;
        result.state = "unknown";
        result.detail = "The reset time has passed; relay has not measured since.";
      }
      return result;
    },
    async start(account, req) {
      if (req.mode === "headless" && req.prompt === undefined) throw new Error("A headless worker needs a prompt.");
      const headless = req.mode === "headless";
      const transport: Transport = claude ? (headless ? "claude-print" : "claude-interactive")
        : (headless ? "codex-app-server" : "codex-interactive");
      const presetSessionId = claude ? req.resumeSessionId ?? randomUUID() : undefined;
      const providerSessionId = claude ? scenario.session_id ?? presetSessionId!
        : req.resumeSessionId ?? scenario.session_id ?? randomUUID();
      const events = new EventQueue();
      let exit: { code: number | null; signal: string | null } | undefined;
      let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
      let ready = false;
      let stopping = false;
      let ignoreSigterm = false;
      let turnIndex = 0;
      let toolIndex = 0;
      let approvalIndex = 0;
      const pending: string[] = req.prompt === undefined ? [] : [req.prompt];
      let active: { interrupted: boolean; cancel: () => void; cancelled: Promise<void> } | undefined;
      let running: Promise<void> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;

      function end(code: number | null, signal: string | null): void {
        if (exit !== undefined) return;
        clearTimeout(startupTimer);
        exit = { code, signal };
        events.push({ kind: "exited", ...exit });
        resolveExit(exit);
      }

      async function runTurn(): Promise<void> {
        let cancel!: () => void;
        const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
        const turn = { interrupted: false, cancel, cancelled };
        active = turn;
        let completed = true;
        async function pause(ms?: number): Promise<void> {
          if (ms === undefined) return cancelled;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([cancelled, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
          clearTimeout(timer);
        }
        for (const step of turnSteps(scenario, turnIndex++)) {
          if (turn.interrupted || exit !== undefined) break;
          if ("say" in step) events.push({ kind: "message", text: step.say, partial: false });
          else if ("run" in step) {
            const tool = { toolId: `tool_${++toolIndex}`, name: claude ? "Bash" : "commandExecution", command: step.run };
            events.push({ kind: "tool", ...tool, status: "started" });
            await pause(step.delay_ms ?? 0);
            if (!turn.interrupted) events.push({ kind: "tool", ...tool, status: (step.exit_code ?? 0) === 0 ? "completed" : "failed", exitCode: step.exit_code ?? 0 });
          } else if ("write" in step) {
            writeStepFile(req.cwd, step.write, step.content);
            const tool = { toolId: `tool_${++toolIndex}`, name: claude ? "Write" : "fileChange", paths: [step.write] };
            events.push({ kind: "tool", ...tool, status: "started" });
            events.push({ kind: "tool", ...tool, status: "completed" });
          } else if ("limit" in step) {
            const name = windowName(step.limit.window);
            const retryAt = new Date(step.limit.resets_at);
            const rate = step.limit.kind === "rate";
            const update: Extract<WorkerEvent, { kind: "limit_update" }> = {
              kind: "limit_update", windows: [{ name, windowMinutes: name === "five_hour" ? 300 : 10080, usedPercent: 100, resetsAt: retryAt, source }],
              state: rate ? "rate_limited" : "quota_exhausted", retryAt, source,
            };
            record(account.id, update);
            events.push(update);
            events.push({ kind: "turn_failed", reason: rate ? "rate_limit" : "usage_limit", retryAt, source,
              message: rate ? "Rate limit reached." : claude
                ? name === "five_hour" ? "You've hit your session limit." : "You've hit your weekly limit."
                : "You’ve hit your usage limit." });
            completed = false;
            break;
          } else if ("error" in step) {
            events.push({ kind: "turn_failed", reason: step.error === "authentication_failed" ? "auth"
              : step.error === "billing_error" ? "billing" : step.error === "overloaded" ? "overloaded" : "other",
            message: step.error, source });
            completed = false;
            break;
          } else if ("crash" in step || "exit" in step) {
            events.push({ kind: "turn_failed", reason: "crashed", source: "none", message: "crash" in step
              ? `The agent ended by ${step.crash.signal}.` : `The agent exited with code ${step.exit} during a turn.` });
            end("exit" in step ? step.exit : null, "crash" in step ? step.crash.signal : null);
            completed = false;
            break;
          } else if ("hang" in step) await pause();
          else if ("finish" in step) break;
          else if ("approval" in step) {
            if (claude) events.push({ kind: "permission_denied", tool: step.approval.command === undefined ? "Write" : "Bash" });
            else {
              events.push({ kind: "approval_needed", requestId: `approval_${++approvalIndex}`, summary: step.approval.command === undefined
                ? `change ${step.approval.path}` : `run ${step.approval.command}` });
              await pause();
            }
          } else if ("status_line" in step) {
            const windows: LimitWindow[] = [];
            const retryAt = step.status_line.resets_at === undefined ? undefined : new Date(step.status_line.resets_at);
            for (const name of ["five_hour", "seven_day"] as const) {
              const usedPercent = step.status_line[name];
              if (usedPercent !== undefined) windows.push({ name, usedPercent, source: "status_line", ...(retryAt === undefined ? {} : { resetsAt: retryAt }) });
            }
            const exhausted = windows.some((window) => window.usedPercent! >= 100);
            const update: Extract<WorkerEvent, { kind: "limit_update" }> = {
              kind: "limit_update", windows, state: exhausted ? "quota_exhausted" : "available", source: "status_line",
              ...(exhausted && retryAt !== undefined ? { retryAt } : {}),
            };
            record(account.id, update);
            events.push(update);
          } else if ("ignore_sigterm" in step) ignoreSigterm = true;
        }
        if (turn.interrupted && exit === undefined) {
          events.push({ kind: "turn_failed", reason: "interrupted", message: "The turn was interrupted.", source: "none" });
          completed = false;
        } else if (completed && exit === undefined) {
          events.push({ kind: "turn_completed", usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50,
            ...(claude ? {} : { reasoningOutputTokens: 0 }) }, ...(claude ? { costUsdEstimate: 0.01, durationMs: 1000 } : {}) });
        }
        active = undefined;
        if (headless && pending.length === 0 && !stopping) end(completed ? 0 : 1, null);
      }

      function pump(): void {
        if (!ready || stopping || exit !== undefined || running !== undefined || pending.length === 0) return;
        pending.shift();
        // Deferring execution lets callers queue messages before an immediate turn finishes.
        running = Promise.resolve().then(runTurn).catch((error: unknown) => {
          active = undefined;
          events.push({ kind: "turn_failed", reason: "other", message: error instanceof Error ? error.message : String(error), source: "none" });
          end(1, null);
        }).finally(() => { running = undefined; pump(); });
      }

      const handle: WorkerHandle = {
        workerId: req.workerId, transport, pid: null, argv: [], ...(presetSessionId === undefined ? {} : { presetSessionId }),
        events: () => events,
        async send(text) {
          if (exit !== undefined) throw new Error("The worker has exited.");
          if (!headless) throw new UnsupportedOperation(`${displayName} in ${transport.replaceAll("-", " ")} mode cannot receive a message while it runs.`);
          pending.push(text);
          pump();
        },
        async interrupt() {
          if (exit !== undefined || active === undefined) return;
          active.interrupted = true;
          active.cancel();
          await running;
        },
        async stop() {
          if (exit !== undefined) return { how: "already_exited", exitCode: exit.code, signal: exit.signal, turnEnded: true };
          const turnEnded = active === undefined && running === undefined;
          stopping = true;
          pending.length = 0;
          // A queued turn may not have entered runTurn yet, so let it become interruptible.
          if (running !== undefined && active === undefined) await Promise.resolve();
          await handle.interrupt();
          if (headless) {
            end(0, null);
            return { how: "clean", exitCode: 0, signal: null, turnEnded: true };
          }
          const code = ignoreSigterm ? null : 143;
          const signal = ignoreSigterm ? "SIGKILL" : null;
          end(code, signal);
          return { how: ignoreSigterm ? "killed" : "terminated", exitCode: code, signal, turnEnded };
        },
        wait: () => exited,
      };
      startupTimer = setTimeout(() => {
        if (exit !== undefined) return;
        // Interactive Codex names its session only through a SessionStart hook, which runs only
        // when the person trusted relay's hooks.
        if (claude || headless || scenario.hooks_trusted === true) {
          events.push({ kind: "session_started", providerSessionId, providerVersion: version,
            ...(req.model === undefined ? {} : { model: req.model }),
            source: claude ? providerSessionId === presetSessionId ? "preset" : "stream" : headless ? "stream" : "hook" });
        }
        ready = true;
        pump();
      }, scenario.startup_delay_ms ?? 0);
      return handle;
    },
  };
}
