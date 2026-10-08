import { afterEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventReader, isStep } from "../src/events.ts";
import { cleanup, temp } from "./helpers.ts";

afterEach(cleanup);

function line(id: number, type: string, data: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ v: 1, id, ts: "2026-10-08T10:00:00.000Z", job: "3f9a2c1d", type, actor: "relay", data })}\n`;
}

test("The reader waits for a line written in two halves and counts steps", async () => {
  const path = join(temp("events"), "events.jsonl");
  const reader = new EventReader(path);
  expect(await reader.read()).toEqual([]);
  const third = line(3, "file_changed", { worker_id: "5d2e8f01", paths: ["src/é.ts"] });
  // Cut inside the two bytes of é, so the first half also ends in the middle of a character.
  const bytes = Buffer.from(third);
  const cut = bytes.indexOf(Buffer.from("é")) + 1;
  writeFileSync(path, Buffer.concat([
    Buffer.from(line(1, "worker_started") + line(2, "command_ran", { command: "bun test", exit_code: 0 })),
    bytes.subarray(0, cut),
  ]));
  const first = await reader.read();
  expect(first.map((event) => event.type)).toEqual(["worker_started", "command_ran"]);
  expect(await reader.read()).toEqual([]);
  appendFileSync(path, bytes.subarray(cut));
  const second = await reader.read();
  expect(second).toHaveLength(1);
  expect(second[0]!.data.paths).toEqual(["src/é.ts"]);
  appendFileSync(path, `not an event\n${line(4, "turn_completed")}`);
  const third2 = await reader.read();
  expect(third2.map((event) => event.id)).toEqual([4]);
  expect([...first, ...second, ...third2].filter(isStep)).toHaveLength(2);
});
