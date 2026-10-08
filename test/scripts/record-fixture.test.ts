import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeGithubToken, requireGitleaks } from "../helpers/secrets";

const script = resolve(import.meta.dir, "../../scripts/record-fixture.ts");
const fake = resolve(import.meta.dir, "../fakes/fake-claude.ts");
async function recording(text: string, permitted: boolean, check: (result: {
  code: number; stdout: string; stderr: string; root: string; destination: string; record: string;
}) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-record-test-"));
  const home = join(root, "home");
  mkdirSync(home);
  const scenario = join(root, "scenario.json");
  const record = join(root, "record.json");
  const fixtures = join(root, "fixtures");
  const destination = join(fixtures, "claude/print/normal-turn");
  writeFileSync(scenario, JSON.stringify({ version: 1, turns: [{ steps: [{ say: text }, { say: "Finished." }] }] }));
  const child = Bun.spawn([process.execPath, script, "claude", "print", "normal-turn", "--fixtures-root", fixtures], {
    env: { ...process.env, HOME: home, RELAY_HOME: join(root, "relay"), CLAUDE_CONFIG_DIR: join(home, ".claude"), RELAY_RECORD: permitted ? "1" : "", RELAY_CLAUDE_BIN: fake, RELAY_FAKE_SCENARIO: scenario, RELAY_FAKE_RECORD: record },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    check({ code, stdout, stderr, root, destination, record });
  } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; rmSync(root, { recursive: true, force: true }); }
}
test("Recording refuses to start any program without RELAY_RECORD", async () => {
  await recording("Hello.", false, ({ code, stderr, stdout, record, destination }) => {
    expect(code).toBe(2);
    expect(stderr).toBe("Recording runs the real claude program and uses your plan. Set RELAY_RECORD=1 to continue.\n");
    expect(stdout).toBe("");
    expect(existsSync(record)).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });
}, 20_000);
test("Recording redacts an email and lists each replacement", async () => {
  requireGitleaks();
  const email = ["josue", "example.com"].join("@");
  await recording(`Contact ${email}.`, true, ({ code, stderr, stdout, destination }) => {
    expect(code).toBe(0); expect(stderr).toBe("");
    const output = readFileSync(join(destination, "output.jsonl"), "utf8");
    expect(output).toContain("redacted"); expect(output).not.toContain(email);
    const meta = JSON.parse(readFileSync(join(destination, "meta.json"), "utf8")) as { source: string; tool_version: string; redactions: string[]; command: string[] };
    expect(meta.source).toBe("recorded"); expect(meta.tool_version).toBe("2.1.282");
    expect(meta.redactions.filter((entry) => entry === "email address")).toHaveLength(1);
    expect(meta.redactions.filter((entry) => entry !== "email address" && entry !== "home folder" && entry !== "temporary repository")).toEqual([]);
    // The events come from the claude-print mapper registered in test/adapters/registry.ts.
    const events = JSON.parse(readFileSync(join(destination, "expected-events.json"), "utf8")) as { kind: string; text?: string }[];
    expect(events.map((event) => event.kind)).toEqual(["session_started", "message", "message", "turn_completed"]);
    expect(events[1]?.text).toBe("Contact redacted.");
    expect(stdout).toContain('"kind": "turn_completed"');
  });
}, 20_000);
test("Recording stops before writing a fixture when the scanner finds a token", async () => {
  requireGitleaks();
  await recording(fakeGithubToken(), true, ({ code, stderr, destination }) => {
    expect(code).toBe(1);
    expect(stderr).toMatch(/^The recording contains what looks like a secret \(github-pat on line \d+\)\. Nothing was written\.\n$/);
    expect(existsSync(destination)).toBe(false);
  });
}, 20_000);
