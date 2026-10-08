import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkRequiredFixtures, checkTestedVersions, EXTRA_CODEX_FIXTURES, FIXTURES_ROOT, listFixtures, loadFixture, replayFixture } from "./fixtures";
import type { MapperFactory } from "./fixtures";
import { now, setClock } from "../../src/platform/clock";

test("Every provider fixture folder loads", () => {
  for (const provider of readdirSync(FIXTURES_ROOT, { withFileTypes: true })) {
    expect(provider.isDirectory()).toBe(true);
    for (const transport of readdirSync(join(FIXTURES_ROOT, provider.name), { withFileTypes: true })) {
      expect(transport.isDirectory()).toBe(true);
      for (const folder of listFixtures(FIXTURES_ROOT, provider.name, transport.name)) loadFixture(folder);
    }
  }
});
const transports = [["claude", "print"], ["codex", "app-server"], ["codex", "exec"]] as const;
for (const [provider, transport] of transports) {
  test(`${provider}/${transport}: required fixtures exist and load`, () => {
    expect(checkRequiredFixtures(FIXTURES_ROOT, provider, transport, transport === "app-server" ? EXTRA_CODEX_FIXTURES : [])).toEqual([]);
    for (const folder of listFixtures(FIXTURES_ROOT, provider, transport)) loadFixture(folder);
  });
}
for (const provider of ["claude", "codex"]) test(`${provider}: recorded versions are tested`, () => {
  expect(checkTestedVersions(FIXTURES_ROOT, provider, resolve(import.meta.dir, `../../src/adapters/${provider}/tested-versions.json`))).toEqual([]);
});
function temporary(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "relay-fixture-test-"));
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function fixture(root: string, source = "documentation", version = "0.160.0"): string {
  const folder = join(root, "codex/exec/normal-turn");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "output.jsonl"), '{"text":"Hello."}\n');
  writeFileSync(join(folder, "expected-events.json"), '[{"kind":"message","text":"Hello.","partial":false}]\n');
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ provider: "codex", transport: "codex-exec", tool_version: version, recorded_at: "2026-10-08T12:00:00.000Z", source, command: ["exec", "--json", "<prompt>"], redactions: [] }));
  return folder;
}
test("A missing required fixture has the specified message", () => temporary((root) => {
  cpSync(FIXTURES_ROOT, root, { recursive: true });
  rmSync(join(root, "claude/print/usage-limit"), { recursive: true });
  expect(checkRequiredFixtures(root, "claude", "print")).toEqual(["claude/print is missing the required fixture usage-limit."]);
}));
test("An untested recorded version has the specified message", () => temporary((root) => {
  fixture(root, "recorded", "0.161.0");
  const versions = join(root, "tested-versions.json");
  writeFileSync(versions, '{"tested":["0.160.0"]}');
  expect(checkTestedVersions(root, "codex", versions)).toEqual(["codex fixture normal-turn was recorded with 0.161.0, which is not in tested-versions.json."]);
}));
test("Replay uses the fixture clock and names the first differing event", () => temporary((root) => {
  const loaded = loadFixture(fixture(root));
  const factory: MapperFactory = ({ interruptSent }) => ({
    push(message) {
      expect(interruptSent).toBe(false);
      expect(now().toISOString()).toBe(loaded.meta.recorded_at);
      return [{ kind: "message", text: (message as { text: string }).text, partial: false }];
    }, end: () => [],
  });
  try {
    replayFixture(loaded, factory);
    expect(() => replayFixture({ ...loaded, expectedEvents: [{ kind: "message", text: "Changed.", partial: false }] }, factory)).toThrow("codex/exec/normal-turn (documentation fixture): event index 0 differs.");
    expect(() => replayFixture({ ...loaded, expectedEvents: [] }, factory)).toThrow("received");
  } finally { setClock(null); }
}));
test("Missing files, wrong metadata and exited events are rejected", () => temporary((root) => {
  const folder = fixture(root);
  rmSync(join(folder, "output.jsonl"));
  expect(() => loadFixture(folder)).toThrow(folder);
  fixture(root);
  writeFileSync(join(folder, "meta.json"), '{}');
  expect(() => loadFixture(folder)).toThrow("missing provider");
  fixture(root);
  writeFileSync(join(folder, "expected-events.json"), '[{"kind":"exited","code":0,"signal":null}]');
  expect(() => loadFixture(folder)).toThrow("must not contain exited");
}));
test("App-server replay skips client messages and sets interruption context", () => temporary((root) => {
  const folder = join(root, "codex/app-server/interrupted");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ provider: "codex", transport: "codex-app-server", tool_version: "0.160.0", recorded_at: "2026-10-08T12:00:00.000Z", source: "documentation", command: ["app-server"], redactions: [] }));
  writeFileSync(join(folder, "output.jsonl"), '{"dir":"client","msg":{"method":"initialize"}}\n{"dir":"server","msg":{"method":"done"}}\n');
  writeFileSync(join(folder, "expected-events.json"), '[]');
  let calls = 0;
  replayFixture(loadFixture(folder), ({ interruptSent }) => {
    expect(interruptSent).toBe(true);
    return { push(message) { calls++; expect(message).toEqual({ method: "done" }); return []; }, end: () => [] };
  });
  expect(calls).toBe(1);
}));
test("Replay serializes reset dates and omits undefined fields", () => temporary((root) => {
  const folder = fixture(root);
  writeFileSync(join(folder, "expected-events.json"), '[{"kind":"turn_failed","reason":"usage_limit","message":"Limit reached.","retryAt":"2026-10-08T15:45:00.000Z","source":"message_text"}]');
  replayFixture(loadFixture(folder), () => ({ push: () => [{ kind: "turn_failed", reason: "usage_limit", message: "Limit reached.", retryAt: new Date("2026-10-08T15:45:00.000Z"), source: "message_text" }], end: () => [] }));
  writeFileSync(join(folder, "expected-events.json"), '[{"kind":"turn_completed"}]');
  replayFixture(loadFixture(folder), () => ({ push: () => [{ kind: "turn_completed", usage: undefined }], end: () => [] }));
}));
test("Metadata with a wrong provider, transport, source or date is rejected", () => temporary((root) => {
  for (const [field, value] of [["provider", "claude"], ["transport", "claude-print"], ["source", "unknown"], ["recorded_at", "2026-10-08"], ["command", "exec"]]) {
    const folder = fixture(root);
    const meta = { provider: "codex", transport: "codex-exec", tool_version: "0.160.0", recorded_at: "2026-10-08T12:00:00.000Z", source: "documentation", command: ["exec"], redactions: [], [field!]: value };
    writeFileSync(join(folder, "meta.json"), JSON.stringify(meta));
    expect(() => loadFixture(folder)).toThrow(folder);
  }
}));
