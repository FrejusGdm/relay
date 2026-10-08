// Runs each scenario in test/fixtures/scenarios/ once against the fake its section names, headless,
// and checks that it ends the way the handoff tests rely on.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario } from "./scenario";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "scenarios");
const FAKES = { claude: join(import.meta.dir, "fake-claude.ts"), codex: join(import.meta.dir, "fake-codex.ts") };
const ARGS = { claude: ["-p", "--output-format", "stream-json", "--verbose"], codex: ["exec", "--json"] };

interface Run { code: number | null; stdout: string; cwd: string }

// Starts the fake with a prompt argument and standard input at end of file. A fake still running
// after `waitMs` is stopped and reported with code null.
async function run(file: string, waitMs = 5000): Promise<Run> {
  const sections = Object.keys(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")));
  expect(sections).toHaveLength(1);
  const program = sections[0] as "claude" | "codex";
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "relay-scenario-"));
  const child = Bun.spawn([FAKES[program], ...ARGS[program], "Write the handoff notes."], {
    cwd,
    env: { ...process.env, RELAY_FAKE_SCENARIO: join(FIXTURES, file), CLAUDE_CONFIG_DIR: join(cwd, ".fake-claude"), CODEX_HOME: join(cwd, ".fake-codex") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([child.exited, new Promise<"running">((done) => { timer = setTimeout(() => done("running"), waitMs); })]);
  clearTimeout(timer);
  if (ended === "running") {
    child.kill("SIGKILL");
    await child.exited;
  }
  return { code: ended === "running" ? null : ended, stdout: await stdout, cwd };
}

const events = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const result = (stdout: string) => events(stdout).find((event) => event.type === "result") as { result: string; permission_denials: unknown[] };

describe("handoff scenarios", () => {
  test("the folder holds exactly the scenarios the handoff tests use", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([
      "claude-answers-notes.json", "claude-asks-approval-on-notes.json", "claude-edits-agents-md.json", "claude-edits-two-files.json",
      "claude-hangs-on-notes.json", "claude-hits-limit.json", "claude-notes-with-secret.json", "claude-plants-fsmonitor.json",
      "codex-exits-at-once.json", "codex-starts.json",
    ]);
  });

  test("claude-edits-two-files: writes both files and finishes", async () => {
    const { code, cwd } = await run("claude-edits-two-files.json");
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, "src/auth/callback.ts"), "utf8")).toContain("handleCallback");
    expect(existsSync(join(cwd, "src/auth/google.ts"))).toBe(true);
  });

  test("claude-answers-notes: answers with the seven sections", async () => {
    const { code, stdout } = await run("claude-answers-notes.json");
    expect(code).toBe(0);
    const text = result(stdout).result;
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## Done", "## In progress", "## Next steps", "## Decisions", "## Files touched", "## Claims to verify", "## Problems",
    ]);
  });

  test("claude-hits-limit: the turn fails at the usage limit", async () => {
    const { code, stdout } = await run("claude-hits-limit.json");
    expect(code).toBe(1);
    expect(events(stdout).some((event) => event.type === "rate_limit_event")).toBe(true);
  });

  test("claude-hangs-on-notes: never answers", async () => {
    const { code, stdout } = await run("claude-hangs-on-notes.json", 1000);
    expect(code).toBeNull();
    expect(stdout).not.toContain('"type":"result"');
  });

  test("claude-notes-with-secret: line 12 of the notes holds the scanner's marker", async () => {
    const { code, stdout } = await run("claude-notes-with-secret.json");
    expect(code).toBe(0);
    expect(result(stdout).result.split("\n")[11]).toContain("FAKE-SECRET:generic-api-key");
  });

  test("claude-asks-approval-on-notes: asks for a permission while answering", async () => {
    const { code, stdout } = await run("claude-asks-approval-on-notes.json");
    expect(code).toBe(0);
    expect(result(stdout).permission_denials).toHaveLength(1);
  });

  test("claude-plants-fsmonitor: writes core.fsmonitor into .git/config", async () => {
    const { code, cwd } = await run("claude-plants-fsmonitor.json");
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, ".git/config"), "utf8")).toContain("fsmonitor = ");
    expect(existsSync(join(cwd, "fsmonitor-ran"))).toBe(false);
  });

  test("claude-edits-agents-md: changes AGENTS.md and .claude/settings.json", async () => {
    const { code, cwd } = await run("claude-edits-agents-md.json");
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
  });

  test("codex-starts: keeps working", async () => {
    const { code, stdout } = await run("codex-starts.json", 1000);
    expect(code).toBeNull();
    expect(events(stdout)[0]?.type).toBe("thread.started");
  });

  test("codex-exits-at-once: exits with code 1", async () => {
    expect((await run("codex-exits-at-once.json")).code).toBe(1);
  });
});

describe("a file with one section per program", () => {
  const file = join(mkdtempSync(join(realpathSync(tmpdir()), "relay-scenario-")), "both.json");
  writeFileSync(file, JSON.stringify({ claude: { version: 1, turns: [{ steps: [{ say: "claude" }] }] } }));

  test("each program reads its own section, and a missing section is the default", () => {
    expect(loadScenario(file, "claude").turns).toEqual([{ steps: [{ say: "claude" }] }]);
    expect(loadScenario(file, "codex")).toEqual({ version: 1, turns: [] });
  });

  test("a section file needs a program", () => {
    expect(() => loadScenario(file)).toThrow("no program was named");
  });
});
