// What the pure output mappers share (add-provider-adapters, design decision 8): each mapper turns
// one parsed message at a time into worker events, without a process, so fixtures can replay it.
import type { TokenUsage, WorkerEvent } from "./types";

export interface MapperContext { interruptSent: boolean }
export interface StreamMapper {
  push(message: unknown): WorkerEvent[];
  end(): WorkerEvent[];
  readonly unknown: number;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function tokenUsage(value: unknown, fields: readonly (readonly [string, keyof TokenUsage])[]): TokenUsage | undefined {
  if (!object(value)) return undefined;
  const usage: TokenUsage = {};
  for (const [from, to] of fields) {
    const count = value[from];
    if (number(count)) usage[to] = count;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function stopped(context: MapperContext): WorkerEvent {
  return {
    kind: "turn_failed", reason: context.interruptSent ? "interrupted" : "crashed",
    message: "The agent stopped before the turn ended.", source: "none",
  };
}

export function completedToolStatus(value: unknown): "completed" | "failed" | "declined" | undefined {
  return value === "completed" || value === "failed" || value === "declined" ? value : undefined;
}

export function changedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths: string[] = [];
  for (const change of value as unknown[]) {
    if (!object(change) || typeof change.path !== "string") return undefined;
    paths.push(change.path);
  }
  return paths;
}
