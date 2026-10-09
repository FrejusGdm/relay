import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FIXTURES_ROOT, loadFixture, replayFixture } from "./fixtures";
import { CONTRACT_ENTRIES } from "./registry";
import type { Scenario, Step } from "../fakes/scenario";

const SESSION = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31";
const RESET = "2026-10-08T15:45:00.000Z";
const scenarios: Record<string, Scenario> = {};
const steps: Record<string, Step[]> = {
  "normal-turn": [{ say: "I will run the tests." }, { run: "bun test", exit_code: 0 }, { write: "src/a.ts", content: "export const a = 1;\n" }],
  "usage-limit": [{ limit: { window: "primary", resets_at: RESET } }],
  "auth-failure": [{ error: "authentication_failed" }],
  "interrupted": [{ say: "I will run the tests." }, { hang: true }],
  "resumed": [{ say: "I finished the task." }],
};
for (const transport of ["claude/print", "codex/app-server", "codex/exec"]) {
  for (const [name, turn] of Object.entries(steps)) scenarios[`${transport}/${name}`] = {
    version: 1, session_id: SESSION, turns: [{ steps: turn }],
    ...(transport === "codex/app-server" && name === "usage-limit" ? { rate_limits: { reached: "rate_limit_reached" } } : {}),
  };
}
scenarios["codex/app-server/rate-limits-read"] = {
  version: 1, session_id: SESSION, turns: [], rate_limits: {
    primary: { used_percent: 62, window_minutes: 300, resets_at: RESET },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: "2026-10-12T16:00:00.000Z" }, ordinary_usage_allowed: true,
  },
};
scenarios["codex/app-server/hooks-list"] = { version: 1, session_id: SESSION, hooks_trusted: true, turns: [] };
type Json = Record<string, unknown>;
function object(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keyPaths(value: unknown, prefix = "", paths = new Set<string>()): string[] {
  if (Array.isArray(value)) for (const item of value) keyPaths(item, `${prefix}[]`, paths);
  else if (object(value)) for (const [key, item] of Object.entries(value)) { const path = prefix ? `${prefix}.${key}` : key; paths.add(path); keyPaths(item, path, paths); }
  return [...paths].sort();
}
function kind(value: unknown, app: boolean): string {
  if (!object(value)) return "invalid";
  if (app) return `${value.dir}:${object(value.msg) && typeof value.msg.method === "string" ? value.msg.method : "response"}`;
  const blocks = object(value.message) && Array.isArray(value.message.content) ? value.message.content.map((block) => object(block) ? block.type : "invalid") : [];
  return JSON.stringify([value.type, value.type === "system" ? value.subtype : undefined, object(value.item) ? value.item.type : undefined, blocks]);
}
for (const [name, scenario] of Object.entries(scenarios)) {
  test(`${name}: fake output matches the fixture`, async () => {
    const fixture = loadFixture(join(FIXTURES_ROOT, name));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-fixture-fake-")));
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(cwd); mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".claude"));
    const scenarioFile = join(root, "scenario.json");
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    if (fixture.name === "hooks-list") {
      const events = ["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"];
      writeFileSync(join(home, ".codex/hooks.json"), JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command: `relay hook codex ${event}` }] }]])) }));
    }
    const app = fixture.meta.transport === "codex-app-server";
    const claude = fixture.meta.provider === "claude";
    const argv = claude ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(fixture.name === "resumed" ? ["--resume", SESSION] : [])] : app ? ["app-server"] : ["exec", ...(fixture.name === "resumed" ? ["resume", SESSION] : []), "--json", ...(fixture.name === "resumed" ? [] : ["-C", cwd]), "<prompt>"];
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, `../fakes/fake-${claude ? "claude" : "codex"}.ts`), ...argv], {
      cwd, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), RELAY_FAKE_SCENARIO: scenarioFile, RELAY_FAKE_NOW: fixture.meta.recorded_at, TZ: "UTC" },
      stdin: claude || app ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const output: unknown[] = [];
    const reader = child.stdout.getReader();
    let cursor = 0;
    let serverCount = 0;
    const expectedServers = fixture.messages.filter((line) => object(line) && line.dir === "server").length;
    function send(message: unknown): void {
      if (typeof child.stdin === "object" && child.stdin !== null) { child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush(); }
    }
    function advance(): void {
      while (cursor < fixture.messages.length) {
        const expected = fixture.messages[cursor];
        if (!object(expected) || expected.dir !== "client") return;
        const message = JSON.parse(JSON.stringify(expected.msg).replaceAll("/home/user/project", cwd)) as unknown;
        output.push({ dir: "client", msg: message });
        cursor++;
        send(message);
      }
      if (serverCount === expectedServers && typeof child.stdin === "object" && child.stdin !== null) child.stdin.end();
    }
    try {
      if (app) advance();
      if (claude) send({ type: "user", message: { role: "user", content: "<prompt>" }, parent_tool_use_id: null });
      const decoder = new TextDecoder();
      let pending = "";
      function collect(line: string): void {
        if (line === "") return;
        const message: unknown = JSON.parse(line);
        if (app) { output.push({ dir: "server", msg: message }); serverCount++; cursor++; advance(); }
        else {
          output.push(message);
          const beforeInterrupt = claude ? fixture.messages.length - 2 : fixture.messages.length;
          if (fixture.name === "interrupted" && output.length === beforeInterrupt) child.kill("SIGINT");
          if (claude && object(message) && message.type === "result" && typeof child.stdin === "object" && child.stdin !== null) child.stdin.end();
        }
      }
      while (true) {
        const chunk = await reader.read();
        pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) { collect(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (chunk.done) break;
      }
      if (pending !== "") collect(pending);
      const code = await child.exited;
      expect(code).toBe(app || ["normal-turn", "resumed"].includes(fixture.name) ? 0 : 1);
      expect(await stderr).toBe("");
      const mapper = CONTRACT_ENTRIES.find((entry) => entry.provider === fixture.meta.provider)?.transports.find((entry) => entry.id === fixture.meta.transport)?.mapper;
      if (mapper !== undefined) {
        // Paths are stable in fixtures and temporary in fake runs.
        const stableOutput = JSON.stringify(output).replaceAll(cwd, "/home/user/project");
        replayFixture({ ...fixture, messages: JSON.parse(stableOutput) as unknown[] }, mapper);
      } else {
        for (let i = 0; i < Math.max(output.length, fixture.messages.length); i++) {
          const actual = output[i]; const expected = fixture.messages[i];
          if (kind(actual, app) !== kind(expected, app) || !isDeepStrictEqual(keyPaths(actual), keyPaths(expected))) {
            throw new Error(`${name}: line index ${i} differs. Expected ${kind(expected, app)} ${JSON.stringify(keyPaths(expected))}; received ${kind(actual, app)} ${JSON.stringify(keyPaths(actual))}.`);
          }
        }
      }
    } finally {
      clearTimeout(timer); reader.releaseLock(); child.kill("SIGKILL"); await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}
