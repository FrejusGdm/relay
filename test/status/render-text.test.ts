// Task 10.1: the text of relay status, compared with golden files, plus the rules about
// percentages and styling. Run with TZ=UTC.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildView } from "../../src/status/model";
import { renderText } from "../../src/status/render-text";
import { job, NOW, SCENARIOS, account, worker } from "./scenarios";

const golden = (name: string) => readFileSync(join(import.meta.dir, "golden", `${name}.txt`), "utf8");
const render = (name: string, style = false) => renderText(buildView(SCENARIOS[name]!), { now: NOW, style });

test("the clock of these tests is UTC", () => {
  expect(new Date(0).getTimezoneOffset()).toBe(0);
});

test.each(Object.keys(SCENARIOS))("%s equals its golden file", (name) => {
  expect(render(name)).toBe(golden(name));
});

test("after a handoff, the text is the one in design decision 20", () => {
  expect(render("after-handoff")).toBe(
    [
      "Build authentication   job 3f9a2c1d · checkpoint 912ec1 · 2 min ago",
      "",
      "claude:work      ────────────┐      limit reached · reset unknown",
      "                             │",
      "codex:personal   ━━━━━━━━━━━━┷━━━   running · usage unknown",
      "claude:home      ────────────────   available · 9% used (5-hour window, checked 14:30)",
      "",
      "Continuing on Codex.",
      "",
    ].join("\n"),
  );
});

test("every percentage is on an account's row, and none is a total", () => {
  for (const name of Object.keys(SCENARIOS)) {
    const view = buildView(SCENARIOS[name]!);
    for (const line of render(name).split("\n").filter((text) => text.includes("%"))) {
      expect(view.rows.some((row) => line.startsWith(`${row.account.target} `))).toBe(true);
    }
  }
  expect(render("long-title")).toContain("codex:personal   ────────────────   available · 40% used (5-hour window, checked 14:00) · 60% used (7-day window, checked Tue 09:00)");
});

test("without styling there is no escape byte; with it, the current row is bold and a limited row dim", () => {
  for (const name of Object.keys(SCENARIOS)) expect(render(name)).not.toContain("\x1b");
  const lines = render("after-handoff", true).split("\n");
  expect(lines.find((line) => line.includes("codex:personal"))).toStartWith("\x1b[1m");
  expect(lines.find((line) => line.includes("claude:work"))).toStartWith("\x1b[2m");
  expect(lines.find((line) => line.includes("claude:home"))).not.toContain("\x1b");
  expect(lines.every((line) => !line.includes("\x1b") || line.endsWith("\x1b[0m"))).toBe(true);
});

test("the previous row is the newest ended worker, and none when it ran on the current account", () => {
  const claude = worker("w1", "claude:work", "ended", false, "2026-10-07T12:00:00.000Z");
  const codexBefore = worker("w2", "codex:personal", "ended", true, "2026-10-07T13:00:00.000Z");
  const codexNow = worker("w3", "codex:personal", "running", false, "2026-10-07T14:00:00.000Z");
  const view = buildView({
    job: job({ current_worker: codexNow }),
    workers: [codexNow, codexBefore, claude],
    accounts: [account("claude:work"), account("codex:personal")],
    daemon: "running",
    savedState: false,
  });
  expect(view.rows.map((row) => [row.account.target, row.role])).toEqual([
    ["codex:personal", "current"],
    ["claude:work", "other"],
  ]);
  expect(renderText(view, { now: NOW, style: false })).not.toContain("┷");
});
