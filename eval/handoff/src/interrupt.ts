// The interrupt points of add-handoff-evaluation design decision 5. N is the median step count of
// the completed baselines for the same task and starting target.
import { EventType, isStep } from "./events.ts";
import type { RelayEvent } from "./events.ts";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function stepTarget(percent: number, median: number): number {
  return Math.max(1, Math.round((percent / 100) * median));
}

export class InterruptPoint {
  // The step after which the switch happens, or the first step that may trigger it for
  // event:untested-edit. Null for event:first-test-run, which depends on what the agent does.
  readonly targetStep: number | null;
  private steps = 0;
  private edited = false;
  private fired = false;

  constructor(readonly point: string, median: number, private readonly testMatch: string) {
    if (point.startsWith("steps:")) this.targetStep = stepTarget(Number(point.slice("steps:".length)), median);
    else if (point === "event:untested-edit") this.targetStep = stepTarget(50, median);
    else if (point === "event:first-test-run") this.targetStep = null;
    else throw new Error(`Unknown interrupt point ${point}.`);
  }

  // True for the one event right after which relay should switch.
  feed(event: RelayEvent): boolean {
    if (this.fired || !isStep(event)) return false;
    this.steps++;
    const edit = event.type === EventType.fileChanged;
    let fire: boolean;
    if (this.point === "event:first-test-run") {
      fire = !edit && this.edited && String(event.data.command ?? "").includes(this.testMatch);
    } else if (this.point === "event:untested-edit") {
      fire = edit && this.steps >= this.targetStep!;
    } else {
      fire = this.steps >= this.targetStep!;
    }
    if (edit) this.edited = true;
    this.fired = fire;
    return fire;
  }
}
