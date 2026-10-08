// The allow list end to end (task 7.4): a "no" changes nothing and the agent keeps working; no
// terminal without and with --yes; a second Claude account with the policy note and its own
// profile; and work code moving to a personal account.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobEvents, until } from "../run/helpers";
import { relayProcess, relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const config = () => readFileSync(join(fixture.relayHome, "config.toml"), "utf8");
const QUESTION = "This sends the repository and the job notes to OpenAI through the account codex:personal. Continue? [y/N]";

async function run(args: string[], env: Record<string, string> = {}) {
  const child = relayProcess(fixture, args, env);
  const code = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr() };
}

async function claudeWorked(account = "claude:personal") {
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Done." }] }] } });
  expect((await run(["run", account, "--headless", "--prompt", "Go."])).code).toBe(0);
}

test('a "no" changes nothing, and the agent keeps working', async () => {
  fixture = await e2eFixture({ allow: ["claude:personal"] });
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working." }, { hang: true }] }] } });
  const agent = relayProcess(fixture, ["run", "claude:personal"]);
  try {
    await until(() => agent.stdout().includes("Working."));
    const before = { config: config(), events: readFileSync(join(fixture.scratch.repo, ".relay", "events.jsonl"), "utf8") };
    const b = relayTerminal(fixture, ["switch", "codex:personal"]);
    await until(() => b.output().includes("[y/N]"));
    b.type("n\r");
    expect(await b.child.exited).toBe(7);
    expect(b.output().replaceAll("\r", "")).toContain(`${QUESTION} n\nrelay: Nothing changed. Claude Code · personal is still working.\n`);
    expect({ config: config(), events: readFileSync(join(fixture.scratch.repo, ".relay", "events.jsonl"), "utf8") }).toEqual(before);
    expect(agent.child.exitCode).toBeNull();
  } finally {
    process.kill(-agent.child.pid!, "SIGTERM");
    await agent.exited;
  }
});

test("no terminal: without --yes exit 7, with --yes the account is added and recorded as given by the flag", async () => {
  fixture = await e2eFixture({ allow: ["claude:personal"] });
  await claudeWorked();
  expect(await run(["switch", "codex:personal", "--no-start"])).toEqual({
    code: 7, stdout: "",
    stderr: 'relay: codex:personal has not worked on this project before. Sending the repository to OpenAI needs your yes.\nRun "relay switch codex:personal" in a terminal, or add --yes.\n',
  });
  expect((await run(["switch", "codex:personal", "--no-start", "--yes"])).code).toBe(0);
  expect(config()).toContain('allow = ["claude:personal", "codex:personal"]');
  expect(jobEvents(fixture).find((event) => event.type === "provider_allowed")?.data).toEqual({ account: "codex:personal", company: "OpenAI", how: "flag" });
});

test("a second Claude account: the policy note, and the next Claude Code uses that account's profile", async () => {
  fixture = await e2eFixture({ allow: ["claude:personal"], accounts: '[accounts."claude:personal"]\n\n[accounts."claude:work"]\n\n[accounts."codex:personal"]\n' });
  await claudeWorked();
  const record = join(fixture.scratch.root, "record.json");
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json") });
  const result = await run(["switch", "claude:work", "--yes", "--no-summary"], { RELAY_FAKE_RECORD: record });
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("Anthropic says Pro and Max limits assume ordinary, individual use. Moving this job between your own Claude accounts is your choice.\n");
  expect(JSON.parse(readFileSync(record, "utf8")).env.CLAUDE_CONFIG_DIR).toBe(join(fixture.relayHome, "profiles", "claude-work"));
});

test("work code moving to a personal account: the warning, on every switch", async () => {
  fixture = await e2eFixture({
    allow: ["claude:work", "codex:personal"],
    accounts: '[accounts."claude:work"]\nkind = "work"\n\n[accounts."codex:personal"]\nkind = "personal"\n',
  });
  await claudeWorked("claude:work");
  expect(await run(["switch", "codex:personal", "--no-start"])).toMatchObject({ code: 7 });
  const result = await run(["switch", "codex:personal", "--no-start", "--yes", "--no-summary"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("This job ran on a work account (claude:work). codex:personal is marked personal.\n");
});
