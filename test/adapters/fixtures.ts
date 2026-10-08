import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProviderId, Transport, WorkerEvent } from "../../src/adapters/types";
import { setClock } from "../../src/platform/clock";

export const FIXTURES_ROOT = resolve(import.meta.dir, "../fixtures/providers");
export const REQUIRED_FIXTURES = ["normal-turn", "usage-limit", "auth-failure", "interrupted", "resumed"];
export const EXTRA_CODEX_FIXTURES = ["rate-limits-read", "hooks-list"];
const TRANSPORTS: Record<string, Transport> = {
  "claude/print": "claude-print", "codex/app-server": "codex-app-server", "codex/exec": "codex-exec",
};
const KINDS = new Set(["session_started", "message", "tool", "turn_completed", "turn_failed", "limit_update", "approval_needed", "permission_denied"]);
interface Fixture {
  folder: string;
  name: string;
  transportFolder: string;
  messages: unknown[];
  expectedEvents: unknown[];
  meta: {
    provider: ProviderId; transport: Transport; tool_version: string; recorded_at: string;
    source: "recorded" | "documentation"; command: string[]; redactions: string[];
  };
}
export interface ReplayMapper { push(message: unknown): WorkerEvent[]; end(): WorkerEvent[] }
export type MapperFactory = (context: { interruptSent: boolean }) => ReplayMapper;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
export function loadFixture(folder: string): Fixture {
  function fail(problem: string): never { throw new Error(`${folder}: ${problem}`); }
  let files: string[];
  try { files = readdirSync(folder).sort(); }
  catch { return fail("The fixture folder is missing or unreadable."); }
  for (const file of ["output.jsonl", "expected-events.json", "meta.json"]) {
    if (!files.includes(file)) return fail(`${file} is missing.`);
  }
  if (!isDeepStrictEqual(files, ["expected-events.json", "meta.json", "output.jsonl"])) return fail("A fixture must contain exactly output.jsonl, expected-events.json and meta.json.");
  const read = (name: string) => {
    try { return readFileSync(join(folder, name), "utf8"); }
    catch { return fail(`${name} is missing or unreadable.`); }
  };
  const parse = (text: string, name: string): unknown => {
    try { return JSON.parse(text); } catch { return fail(`${name} is not valid JSON.`); }
  };
  const meta = parse(read("meta.json"), "meta.json");
  if (!object(meta)) return fail("meta.json must be an object.");
  const transportFolder = basename(dirname(folder));
  const provider = basename(dirname(dirname(folder)));
  for (const field of ["provider", "transport", "tool_version", "recorded_at", "source", "command", "redactions"]) {
    if (!(field in meta)) return fail(`meta.json is missing ${field}.`);
  }
  if (!(provider === "claude" || provider === "codex") || meta.provider !== provider) return fail("meta.json provider does not match its folder.");
  if (TRANSPORTS[`${provider}/${transportFolder}`] === undefined || meta.transport !== TRANSPORTS[`${provider}/${transportFolder}`]) return fail("meta.json transport does not match its folder.");
  if (typeof meta.tool_version !== "string" || !/^\d+\.\d+\.\d+$/.test(meta.tool_version)) return fail("meta.json tool_version must be a version.");
  if (typeof meta.recorded_at !== "string" || !Number.isFinite(Date.parse(meta.recorded_at)) || new Date(meta.recorded_at).toISOString() !== meta.recorded_at) return fail("meta.json recorded_at must be a full ISO time.");
  if (meta.source !== "recorded" && meta.source !== "documentation") return fail("meta.json source must be recorded or documentation.");
  if (!strings(meta.command) || !strings(meta.redactions)) return fail("meta.json command and redactions must be lists of strings.");
  const expectedEvents = parse(read("expected-events.json"), "expected-events.json");
  if (!Array.isArray(expectedEvents) || !expectedEvents.every((event) => object(event) && typeof event.kind === "string" && KINDS.has(event.kind))) return fail("expected-events.json must contain worker event objects and must not contain exited.");
  const messages = read("output.jsonl").split(/\r?\n/).filter((line) => line !== "").map((line, i) => parse(line, `output.jsonl line ${i + 1}`));
  if (meta.transport === "codex-app-server") {
    for (const message of messages) {
      if (!object(message) || !["server", "client"].includes(String(message.dir)) || !object(message.msg) || "jsonrpc" in message.msg) return fail("App-server lines must contain dir and msg without jsonrpc.");
    }
  }
  return { folder, name: basename(folder), transportFolder, messages, expectedEvents, meta: meta as unknown as Fixture["meta"] };
}
export function listFixtures(root: string, provider: string, transportFolder: string): string[] {
  const folder = join(root, provider, transportFolder);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name)).sort();
}
export function checkRequiredFixtures(root: string, provider: string, transportFolder: string, extra: string[] = []): string[] {
  const names = new Set(listFixtures(root, provider, transportFolder).map((folder) => basename(folder)));
  return [...REQUIRED_FIXTURES, ...extra].filter((name) => !names.has(name)).map((name) => `${provider}/${transportFolder} is missing the required fixture ${name}.`);
}
export function checkTestedVersions(root: string, provider: string, testedVersionsFile: string): string[] {
  const versions = JSON.parse(readFileSync(testedVersionsFile, "utf8")) as { tested: string[] };
  const folder = join(root, provider);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) =>
    listFixtures(root, provider, entry.name).map(loadFixture).filter((fixture) => fixture.meta.source === "recorded" && !versions.tested.includes(fixture.meta.tool_version))
      .map((fixture) => `${provider} fixture ${fixture.name} was recorded with ${fixture.meta.tool_version}, which is not in tested-versions.json.`));
}
export function replayFixture(fixture: Fixture, factory: MapperFactory): void {
  let events: WorkerEvent[];
  const previousTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  setClock(() => new Date(fixture.meta.recorded_at));
  try {
    const mapper = factory({ interruptSent: fixture.name === "interrupted" });
    events = fixture.messages.flatMap((line) => {
      if (fixture.meta.transport !== "codex-app-server") return mapper.push(line);
      const message = line as { dir: string; msg: unknown };
      return message.dir === "server" ? mapper.push(message.msg) : [];
    });
    events.push(...mapper.end());
  } finally {
    setClock(null);
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
  const actual = JSON.parse(JSON.stringify(events)) as unknown[];
  const length = Math.max(actual.length, fixture.expectedEvents.length);
  for (let i = 0; i < length; i++) {
    if (!isDeepStrictEqual(actual[i], fixture.expectedEvents[i])) {
      const name = relative(dirname(dirname(dirname(fixture.folder))), fixture.folder).split("\\").join("/");
      const label = fixture.meta.source === "documentation" ? " (documentation fixture)" : "";
      throw new Error(`${name}${label}: event index ${i} differs. Expected ${JSON.stringify(fixture.expectedEvents[i])}; received ${JSON.stringify(actual[i])}.`);
    }
  }
}
