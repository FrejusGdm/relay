// What a headless relay run prints while the agent works (the agent-runs spec, "Headless progress
// output"): one line when the session starts, one per command and per changed file, and one when
// each turn ends. Commands are redacted and every value is made printable, so an agent cannot
// change what the terminal shows.
import type { FailureReason, WorkerEvent } from "../adapters/types";
import { printable } from "../core/quote";
import { now } from "../platform/clock";
import { redact } from "../secrets/redact";

const REASON_TEXT: Record<FailureReason, string> = {
  usage_limit: "usage limit",
  rate_limit: "rate limit",
  overloaded: "the service is overloaded",
  auth: "it is not signed in",
  billing: "a billing problem",
  context_full: "the conversation is too long",
  interrupted: "interrupted",
  crashed: "it crashed",
  other: "an error",
};

export function sessionLine(displayName: string, account: string, sessionId: string): string {
  return `Started ${displayName} on ${account} · session ${printable(sessionId.slice(0, 8))}`;
}

// The progress lines for one event; `paths` are the changed files relative to the worktree root.
export function progressLines(event: WorkerEvent, displayName: string, paths: string[]): string[] {
  if (event.kind === "tool" && event.status !== "started") {
    const lines: string[] = [];
    if (event.command !== undefined) {
      const command = printable(redact(event.command));
      lines.push(event.status === "declined" ? `  declined ${command}`
        : event.exitCode === undefined ? `  ran ${command}` : `  ran ${command} · exit ${event.exitCode}`);
    }
    if (event.status === "completed") lines.push(...paths.map((path) => `  changed ${printable(path)}`));
    return lines;
  }
  if (event.kind === "turn_completed" && event.durationMs !== undefined) {
    return [`Turn finished · ${Math.round(event.durationMs / 1000)} s`];
  }
  if (event.kind === "turn_completed") return ["Turn finished"];
  if (event.kind === "permission_denied") return [`  ${displayName} was not allowed to use ${printable(event.tool)}`];
  return [];
}

// "Codex stopped: usage limit, resets 15:45."
export function limitLine(displayName: string, reason: "usage_limit" | "rate_limit", retryAt?: Date): string {
  return `${displayName} stopped: ${REASON_TEXT[reason]}${retryAt === undefined ? "" : `, resets ${clockText(retryAt)}`}.`;
}

export function failureLine(displayName: string, reason: FailureReason, logPath: string | null): string {
  const details = logPath === null ? "" : ` Details are in ${printable(logPath)}.`;
  if (reason === "crashed") return `${displayName} stopped unexpectedly.${details}`;
  return `${displayName} stopped: ${REASON_TEXT[reason]}.${details}`;
}

// 24-hour local time, with the weekday when the time is not today (design decision 19).
export function clockText(time: Date): string {
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  if (time.toDateString() === now().toDateString()) return clock;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][time.getDay()]} ${clock}`;
}

// A worker event as one JSON line for --json, with the worker ID first and times in ISO 8601.
export function jsonLine(workerId: string, event: WorkerEvent): string {
  return JSON.stringify({ worker_id: workerId, ...event });
}
