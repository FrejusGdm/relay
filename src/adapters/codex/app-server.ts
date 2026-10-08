// Turns the Codex app server's messages into worker events, and its rate-limit answers into
// availability (add-provider-adapters, design decision 8; the codex-adapter spec). The fixtures in
// test/fixtures/providers/codex/app-server/ hold the expected events.
import { now } from "../../platform/clock";
import type { Availability, FailureReason, LimitWindow, TokenUsage, WorkerEvent } from "../types";
import { changedPaths, completedToolStatus, number, object, stopped, tokenUsage } from "../mapper";
import type { MapperContext, StreamMapper } from "../mapper";
import { APPROVAL_METHODS } from "./protocol";

const USAGE_FIELDS = [
  ["inputTokens", "inputTokens"], ["cachedInputTokens", "cachedInputTokens"],
  ["outputTokens", "outputTokens"], ["reasoningOutputTokens", "reasoningOutputTokens"],
] as const;
type Failure = Extract<WorkerEvent, { kind: "turn_failed" }>;

export function windowsFromSnapshot(snapshot: unknown): LimitWindow[] {
  if (!object(snapshot)) return [];
  const windows: LimitWindow[] = [];
  for (const value of [snapshot.primary, snapshot.secondary]) {
    if (!object(value) || !number(value.windowDurationMins)) continue;
    const minutes = value.windowDurationMins;
    const window: LimitWindow = {
      name: minutes === 300 ? "five_hour" : minutes === 10080 ? "seven_day" : `${minutes}_minutes`,
      windowMinutes: minutes, source: "provider_api",
    };
    if (number(value.usedPercent)) window.usedPercent = value.usedPercent;
    if (number(value.resetsAt)) {
      const date = new Date(value.resetsAt * 1000);
      if (Number.isFinite(date.getTime())) window.resetsAt = date;
    }
    windows.push(window);
  }
  return windows;
}

function retryFromWindows(windows: LimitWindow[]): Date | undefined {
  let latest: Date | undefined;
  for (const window of windows) {
    if ((window.usedPercent ?? 0) >= 100 && window.resetsAt !== undefined && (latest === undefined || window.resetsAt > latest)) latest = window.resetsAt;
  }
  return latest;
}

export function availabilityFromRateLimits(result: unknown, account: string): Availability {
  const snapshot = object(result) && object(result.rateLimits) ? result.rateLimits : {};
  const windows = windowsFromSnapshot(snapshot);
  const reached = snapshot.rateLimitReachedType !== undefined && snapshot.rateLimitReachedType !== null;
  const allowed = object(result) ? result.ordinaryUsageAllowed : undefined;
  const state = reached || allowed === false ? "quota_exhausted" : allowed === true ? "available" : "unknown";
  const retryAt = retryFromWindows(windows);
  return { account, state, windows, source: "provider_api", observedAt: now(),
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(state === "unknown" ? { detail: "Codex did not say whether usage is allowed." } : {}),
  };
}

export function createAppServerMapper(context: MapperContext): StreamMapper {
  let unknown = 0;
  let open = false;
  let usage: TokenUsage | undefined;
  let pendingFailure: Failure | undefined;
  function begin() { if (!open) { open = true; usage = undefined; } }
  return {
    get unknown() { return unknown; },
    push(message) {
      if (!object(message)) return [];
      if (!("method" in message)) {
        if ("error" in message || !("id" in message) || !object(message.result)) return [];
        const result = message.result;
        if (object(result.rateLimits) && pendingFailure !== undefined) {
          const retryAt = retryFromWindows(windowsFromSnapshot(result.rateLimits));
          const failure = pendingFailure;
          pendingFailure = undefined;
          return [{ ...failure, ...(retryAt !== undefined ? { retryAt } : {}) }];
        }
        if (object(result.thread) && typeof result.thread.id === "string") {
          return [{ kind: "session_started", providerSessionId: result.thread.id, source: "stream",
            ...(typeof result.model === "string" ? { model: result.model } : {}),
            ...(typeof result.thread.cliVersion === "string" ? { providerVersion: result.thread.cliVersion } : {}),
          }];
        }
        if (object(result.turn) && result.turn.status === "inProgress") begin();
        return [];
      }
      if (typeof message.method !== "string") return [];
      if ((APPROVAL_METHODS as readonly string[]).includes(message.method)) return [];
      const params = object(message.params) ? message.params : {};
      switch (message.method) {
        case "thread/started": case "error": return [];
        case "turn/started":
          if (object(params.turn) && params.turn.status === "inProgress") begin();
          return [];
        case "item/agentMessage/delta":
          if (typeof params.delta !== "string") return [];
          begin();
          return [{ kind: "message", text: params.delta, partial: true }];
        case "item/started": case "item/completed": {
          const item = params.item;
          if (!object(item) || typeof item.type !== "string") return [];
          const started = message.method === "item/started";
          if (item.type === "agentMessage") {
            if (started || typeof item.text !== "string") return [];
            begin();
            return [{ kind: "message", text: item.text, partial: false }];
          }
          if (typeof item.id !== "string") return [];
          if (item.type === "commandExecution") {
            const status = started ? "started" : completedToolStatus(item.status);
            if (status === undefined || typeof item.command !== "string") return [];
            begin();
            return [{ kind: "tool", toolId: item.id, name: "commandExecution", status, command: item.command,
              ...(!started && number(item.exitCode) ? { exitCode: item.exitCode } : {}),
            }];
          }
          if (item.type === "fileChange" && !started) {
            const status = completedToolStatus(item.status);
            const paths = changedPaths(item.changes);
            if (status === undefined || paths === undefined) return [];
            begin();
            return [{ kind: "tool", toolId: item.id, name: "fileChange", status, paths }];
          }
          return [];
        }
        case "thread/tokenUsage/updated":
          if (!object(params.tokenUsage)) return [];
          begin();
          usage = tokenUsage(params.tokenUsage.last, USAGE_FIELDS);
          return [];
        case "account/rateLimits/updated": {
          if (!object(params.rateLimits)) return [];
          const windows = windowsFromSnapshot(params.rateLimits);
          const retryAt = retryFromWindows(windows);
          const reached = params.rateLimits.rateLimitReachedType;
          return [{ kind: "limit_update", windows, source: "provider_api",
            ...(reached !== undefined && reached !== null ? { state: "quota_exhausted" as const } : {}),
            ...(retryAt !== undefined ? { retryAt } : {}),
          }];
        }
        case "turn/completed": {
          const turn = params.turn;
          if (!object(turn)) return [];
          if (turn.status === "completed") {
            open = false;
            const last = usage;
            usage = undefined;
            return [{ kind: "turn_completed", ...(last !== undefined ? { usage: last } : {}) }];
          }
          if (turn.status === "interrupted") {
            open = false;
            usage = undefined;
            return [{ kind: "turn_failed", reason: "interrupted", message: "Interrupted.", source: "stream_event" }];
          }
          if (turn.status !== "failed" || !object(turn.error) || typeof turn.error.message !== "string") return [];
          open = false;
          usage = undefined;
          const info = turn.error.codexErrorInfo;
          const reason: FailureReason = info === "usageLimitExceeded" ? "usage_limit" : info === "rateLimitExceeded" ? "rate_limit"
            : info === "serverOverloaded" ? "overloaded" : info === "unauthorized" ? "auth" : info === "contextWindowExceeded" ? "context_full" : "other";
          const failure: Failure = { kind: "turn_failed", reason, message: turn.error.message.slice(0, 300), source: reason === "usage_limit" ? "provider_api" : "stream_event" };
          if (reason === "usage_limit") { pendingFailure = failure; return []; }
          return [failure];
        }
        default: unknown++; return [];
      }
    },
    end() {
      const events: WorkerEvent[] = [];
      if (pendingFailure !== undefined) { events.push(pendingFailure); pendingFailure = undefined; }
      if (open) { events.push(stopped(context)); open = false; }
      return events;
    },
  };
}
