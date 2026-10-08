import { expect, test } from "bun:test";
import type { RelayEvent } from "../src/events.ts";
import { InterruptPoint, median } from "../src/interrupt.ts";

let id = 0;
function event(type: string, data: Record<string, unknown> = {}): RelayEvent {
  return { v: 1, id: ++id, ts: "2026-10-08T10:00:00.000Z", job: "3f9a2c1d", type, actor: "relay", data };
}
const edit = () => event("file_changed", { paths: ["src/a.ts"] });
const command = (text: string) => event("command_ran", { command: text, exit_code: 0 });

// The number of the step after which the point fires, or null when it never fires.
function firesAfter(point: InterruptPoint, events: RelayEvent[]): number | null {
  let steps = 0;
  for (const item of events) {
    if (item.type === "command_ran" || item.type === "file_changed") steps++;
    if (point.feed(item)) return steps;
  }
  return null;
}

test("Step points fire after their share of the median", () => {
  const steps = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? edit() : command("ls")));
  const half = new InterruptPoint("steps:50", 28, "bun test");
  expect(half.targetStep).toBe(14);
  expect(firesAfter(half, steps)).toBe(14);
  expect(firesAfter(new InterruptPoint("steps:25", 28, "bun test"), steps)).toBe(7);
  expect(firesAfter(new InterruptPoint("steps:75", 28, "bun test"), steps)).toBe(21);
  expect(firesAfter(new InterruptPoint("steps:25", 1, "bun test"), [event("worker_started"), edit()])).toBe(1);
});

test("The first test run counts only after an edit", () => {
  const point = new InterruptPoint("event:first-test-run", 28, "bun test");
  expect(point.targetStep).toBeNull();
  expect(firesAfter(point, [command("bun test"), command("ls"), edit(), command("git status"), command("bun test --watch"), command("bun test")])).toBe(5);
});

test("The untested edit is the first edit at or after half of the median", () => {
  const point = new InterruptPoint("event:untested-edit", 28, "bun test");
  expect(point.targetStep).toBe(14);
  const events = [...Array.from({ length: 13 }, () => edit()), command("bun test"), command("ls"), edit(), edit()];
  expect(firesAfter(point, events)).toBe(16);
});

test("The median of an even count is the mean of the middle two", () => {
  expect(median([])).toBeNull();
  expect(median([30, 26, 28])).toBe(28);
  expect(median([27, 30, 26, 28])).toBe(27.5);
});
