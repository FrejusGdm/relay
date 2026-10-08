import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities, ProviderAdapter, StartRequest } from "../../src/adapters/types";
import type { Account } from "../../src/core/config/types";
import { parseNotes } from "../../src/handoff/notes-parse";
import { NOTES_REQUEST, notesSkipReason, requestNotes, type OutgoingWorker } from "../../src/handoff/notes-request";
import { createFakeAdapter } from "../fakes/fake-adapter";
import { loadScenario, type Scenario } from "../fakes/scenario";

const SCENARIOS = join(import.meta.dir, "..", "fixtures", "scenarios");
const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
const RESUMABLE: Capabilities = { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "structured", observesExternalSessions: "hooks" };

const folder = mkdtempSync(join(realpathSync(tmpdir()), "relay-notes-"));
const account = (provider: "claude" | "codex" = "claude"): Account => ({
  id: `${provider}:personal`, provider, name: "personal", profileDir: join(folder, `${provider}-personal`),
  profileDirIsDefault: true, credentialEnv: [], kind: null,
});
const worker = (changes: Partial<OutgoingWorker> = {}): OutgoingWorker => ({
  workerId: "5d2e8f01", account: account(), accountId: "claude:personal", provider: "claude", sessionId: SESSION,
  capabilities: RESUMABLE, lastFailure: null, availability: "unknown", ...changes,
});

describe("Asking the outgoing agent only when it can answer", () => {
  test("an agent that can answer is asked", () => {
    expect(notesSkipReason(true, worker())).toBeNull();
  });

  test.each([
    ["--no-summary", "flag", {}, "you passed --no-summary"],
    ["the setting", "config", {}, "notes are turned off in config.toml"],
    ["a usage limit", true, { lastFailure: "usage_limit" }, "Claude Code was at its usage limit"],
    ["a rate limit", true, { lastFailure: "rate_limit" }, "Claude Code was at its rate limit"],
    ["a sign-in problem", true, { lastFailure: "auth" }, "Claude Code could not sign in"],
    ["a billing problem", true, { lastFailure: "billing" }, "Claude Code has a billing problem"],
    ["an exhausted quota", true, { availability: "quota_exhausted" }, "Claude Code was at its usage limit"],
    ["a rate-limited account", true, { availability: "rate_limited" }, "Claude Code was at its rate limit"],
    ["an unavailable account", true, { availability: "unavailable" }, "Claude Code is unavailable"],
    ["no resume", true, { capabilities: { ...RESUMABLE, nativeResume: false } }, "Claude Code cannot resume a session"],
    ["a removed account", true, { account: null }, "the account claude:personal was removed"],
  ] as const)("not asked because of %s", (_name, ask, changes, reason) => {
    expect(notesSkipReason(ask, worker(changes as Partial<OutgoingWorker>))).toBe(reason);
  });

  test("an interactive Codex session without a session ID is not asked", () => {
    expect(notesSkipReason(true, worker({ provider: "codex", accountId: "codex:personal", account: account("codex"), sessionId: null })))
      .toBe("Codex did not report a session ID, so it cannot be asked after it stops");
  });

  test("the first failing condition is the reason", () => {
    expect(notesSkipReason("flag", worker({ sessionId: null, lastFailure: "usage_limit" }))).toBe("you passed --no-summary");
    expect(notesSkipReason(true, worker({ sessionId: null, lastFailure: "usage_limit" }))).toContain("did not report a session ID");
    expect(notesSkipReason(true, worker({ lastFailure: "crashed", availability: "available" }))).toBeNull();
  });
});

// An in-process fake adapter that records the start request it receives.
function recording(scenario: Scenario, provider: "claude" | "codex" = "claude") {
  const adapter = createFakeAdapter({ provider, scenario });
  const requests: StartRequest[] = [];
  const wrapped: ProviderAdapter = { ...adapter, start: (acc, req) => { requests.push(req); return adapter.start(acc, req); } };
  return { adapter: wrapped, requests };
}
const ask = (adapter: ProviderAdapter, timeoutMs = 5000, provider: "claude" | "codex" = "claude") =>
  requestNotes({
    adapter, account: account(provider), sessionId: SESSION, jobId: "3f9a2c1d", workerId: "a41c7b09", cwd: folder,
    instructions: "relay's instructions", env: { ...process.env, ANTHROPIC_API_KEY: "test-value" },
    logPath: join(folder, "worker.log"), timeoutMs, stopTimeoutMs: 1000,
  });
const scenario = (name: string, program: "claude" | "codex" = "claude") => loadScenario(join(SCENARIOS, name), program);

describe("The notes request", () => {
  test("the request text is exactly the text of design.md decision 6", () => {
    const design = readFileSync(join(import.meta.dir, "..", "..", "openspec", "changes", "add-relay-switch", "design.md"), "utf8");
    const block = /The request, `NOTES_REQUEST`, is exactly:\n\n```\n([\s\S]*?)\n```/.exec(design)?.[1];
    expect(block).toBeDefined();
    expect(NOTES_REQUEST).toBe(block!);
  });

  test("relay resumes the session headless, read-only, on the outgoing account, with the request as the first message", async () => {
    const { adapter, requests } = recording(scenario("claude-answers-notes.json"));
    const answer = await ask(adapter);
    expect(answer.outcome).toBe("received");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect([request.mode, request.permission, request.resumeSessionId, request.prompt]).toEqual(["headless", "read-only", SESSION, NOTES_REQUEST]);
    expect(request.prompt!.startsWith("relay is moving this job to another coding agent. Do not change any file")).toBe(true);
    expect(request.env.CLAUDE_CONFIG_DIR).toBe(account().profileDir);
    expect(request.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request.env.RELAY_WORKER).toBe("a41c7b09");
  });

  test("the answer is the agent's last message", async () => {
    const answer = await ask(recording(scenario("claude-answers-notes.json")).adapter);
    if (answer.outcome !== "received") throw new Error(answer.reason);
    expect(answer.text.startsWith("## Done\n")).toBe(true);
    expect(parseNotes(answer.text).claims).toHaveLength(2);
  });

  test("an agent that does not answer in time is stopped", async () => {
    const answer = await ask(recording(scenario("claude-hangs-on-notes.json")).adapter, 1000);
    expect(answer).toMatchObject({ outcome: "timed_out", reason: "Claude Code did not answer within 1 second" });
  });

  test("a request for permission is never answered: the agent is stopped and the request failed", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const steps = scenario("claude-asks-approval-on-notes.json").turns;
      const answer = await ask(recording({ version: 1, turns: steps }, provider).adapter, 5000, provider);
      expect(answer).toMatchObject({ outcome: "failed", reason: "the request failed: the agent asked for permission" });
    }
  });

  test("a turn that fails gives its reason", async () => {
    const answer = await ask(recording(scenario("claude-hits-limit.json")).adapter);
    expect(answer).toMatchObject({ outcome: "failed", reason: "the request failed: usage_limit" });
  });

  test("an agent that cannot start gives the error", async () => {
    const adapter: ProviderAdapter = { ...createFakeAdapter({ provider: "claude" }), start: () => Promise.reject(new Error("no such session")) };
    expect(await ask(adapter)).toMatchObject({ outcome: "failed", reason: "the request failed: no such session" });
  });
});

describe("Reading the notes", () => {
  const notes = JSON.parse(readFileSync(join(SCENARIOS, "claude-answers-notes.json"), "utf8")).claude.turns[0].steps[0].say as string;

  test("notes in the requested format are split into the seven sections", () => {
    const withThree = notes.replace("## Problems", "- `bun run lint` passes. Check: run `bun run lint`.\n\n## Problems");
    const parsed = parseNotes(withThree);
    expect(parsed.structured).toBe(true);
    expect(Object.keys(parsed.sections)).toEqual(["Done", "In progress", "Next steps", "Decisions", "Files touched", "Claims to verify", "Problems"]);
    expect(parsed.sections["Files touched"]).toEqual(["- src/auth/callback.ts", "- src/auth/google.ts"]);
    expect(parsed.claims).toEqual([
      { text: "`bun test` passes.", how: "run `bun test`." },
      { text: "`src/auth/callback.ts` exports `handleCallback`.", how: "open the file." },
      { text: "`bun run lint` passes.", how: "run `bun run lint`." },
    ]);
  });

  test("headings match without regard to case, and unknown headings are not sections", () => {
    const parsed = parseNotes("Intro\n## DONE\n- a\n## Thoughts\n- b\n## claims to verify\n- c check: x CHECK: y\n");
    expect(parsed.sections).toEqual({ Done: ["- a"], "Claims to verify": ["- c check: x CHECK: y"] });
    expect(parsed.claims).toEqual([{ text: "c check: x", how: "y" }]);
  });

  test("notes in free form are kept whole and have no claims", () => {
    const parsed = parseNotes("I fixed the login.\nThe tests pass.\n");
    expect([parsed.structured, parsed.claims.length, parsed.text]).toEqual([false, 0, "I fixed the login.\nThe tests pass."]);
  });

  test("long notes are cut to 12,000 characters", () => {
    const parsed = parseNotes("a".repeat(15_000));
    expect(parsed.text).toBe(`${"a".repeat(12_000)}\n[relay cut the notes here: 3000 more characters]`);
  });

  test("invisible and control characters are removed and counted", () => {
    const hidden = "\u{E0041}\u{E0042}\u{E0043}‮";
    const parsed = parseNotes(`## Done\n- ${hidden}done\u0007\tnow\r\n`);
    expect(parsed.text).toBe("## Done\n- done\tnow");
    expect(parsed.invisibleRemoved).toBe(4);
  });
});
