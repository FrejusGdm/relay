import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { loadConfig } from "../../src/core/config/load";
import { openRepository, type Repository } from "../../src/git/repo";
import { checkAllowList, projectEntry } from "../../src/handoff/allow-list";
import type { Asker } from "../../src/handoff/ask";
import { makeRelayHome } from "../helpers/home";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";
import { fakeAsker } from "./asker";

let scratch: ScratchRepo;
let repo: Repository;
let relayHome: string;
beforeEach(async () => {
  scratch = makeScratchRepo();
  repo = await openRepository(scratch.repo);
  relayHome = makeRelayHome();
});
afterEach(() => scratch.cleanup());

const ctx = () => ({ relayHome, homedir: scratch.home, uid: process.getuid!() });
const configText = (allow: string, extra = "") => `# My relay settings.
[accounts."claude:personal"]
kind = "personal"

[accounts."claude:work"]
kind = "work"

[accounts."codex:personal"]
kind = "personal" # my own plan
${extra}
# The project I work on.
[[projects]]
path = "${scratch.repo}"
allow = ${allow} # who may see the code
`;
const write = (text: string) => writeFileSync(join(relayHome, "config.toml"), text, { mode: 0o600 });
const config = () => loadConfig({ relayHome, homedir: scratch.home, uid: process.getuid!() });
const account = (id: string) => config().accounts.find((candidate) => candidate.id === id)!;
const check = (asker: Asker, to: string, from = "claude:personal", fromRunning = true) =>
  checkAllowList({ asker, config: config(), configContext: ctx(), repo, from: account(from), fromRunning, to: account(to), command: "switch" });
async function refusal(promise: Promise<unknown>): Promise<{ code: number; lines: string[] }> {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(CommandError);
  return { code: (error as CommandError).code, lines: (error as CommandError).lines };
}
const QUESTION = "This sends the repository and the job notes to OpenAI through the account codex:personal. Continue? [y/N]";

describe("Allow list per project", () => {
  test("an account on the list asks nothing", async () => {
    write(configText('["claude:personal", "codex:personal"]'));
    const asker = fakeAsker();
    expect(await check(asker, "codex:personal")).toEqual({ allowed: null, confirmations: [] });
    expect(asker.said).toEqual([]);
  });

  test("a linked worktree uses the main worktree's entry", async () => {
    write(configText('["claude:personal", "codex:personal"]'));
    const linked = join(scratch.root, "app-auth");
    scratch.git("worktree", "add", "-q", "-b", "auth", linked);
    const linkedRepo = await openRepository(linked);
    expect(projectEntry(config(), linkedRepo)?.allow).toEqual(["claude:personal", "codex:personal"]);
  });

  test("a file in the repository cannot grant access", async () => {
    write(configText('["claude:personal"]'));
    scratch.write(".relay/allow", "codex:personal\n");
    scratch.write("relay.toml", '[[projects]]\nallow = ["codex:personal"]\n');
    const asker = fakeAsker({ answers: ["n"] });
    await refusal(check(asker, "codex:personal"));
    expect(asker.said).toEqual([QUESTION]);
  });
});

describe("First handoff to a new account asks first", () => {
  test("yes adds the account and keeps every other line of config.toml", async () => {
    const before = configText('["claude:personal"]');
    write(before);
    const result = await check(fakeAsker({ answers: ["y"] }), "codex:personal");
    expect(result).toEqual({
      allowed: { account: "codex:personal", company: "OpenAI", how: "terminal" },
      confirmations: [{ question: QUESTION, how: "terminal" }],
    });
    expect(readFileSync(join(relayHome, "config.toml"), "utf8"))
      .toBe(before.replace('allow = ["claude:personal"] #', 'allow = ["claude:personal", "codex:personal"] #'));
  });

  test("an allow list over several lines keeps its layout", async () => {
    const before = configText('[\n  "claude:personal", # first\n  # more later\n]');
    write(before);
    await check(fakeAsker({ answers: ["YES"] }), "codex:personal");
    expect(readFileSync(join(relayHome, "config.toml"), "utf8"))
      .toBe(before.replace('"claude:personal", # first', '"claude:personal", "codex:personal" # first'));
    expect(projectEntry(config(), repo)?.allow).toEqual(["claude:personal", "codex:personal"]);
  });

  test("asked once: the second handoff asks nothing", async () => {
    write(configText('["claude:personal"]'));
    await check(fakeAsker({ answers: ["y"] }), "codex:personal");
    const asker = fakeAsker();
    expect((await check(asker, "codex:personal")).allowed).toBeNull();
    expect(asker.said).toEqual([]);
  });

  test.each([[""], ["n"], ["no"], ["yep"], [null]])("the answer %p is no, and nothing changes", async (answer) => {
    const before = configText('["claude:personal"]');
    write(before);
    expect(await refusal(check(fakeAsker({ answers: [answer] }), "codex:personal"))).toEqual({
      code: 7, lines: ["Nothing changed. Claude Code · personal is still working."],
    });
    expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(before);
  });

  test("without a running agent the answer no says only that nothing changed", async () => {
    write(configText('["claude:personal"]'));
    expect((await refusal(check(fakeAsker({ answers: ["n"] }), "codex:personal", "claude:personal", false))).lines).toEqual(["Nothing changed."]);
  });

  test("a project without an entry gets one on yes", async () => {
    write(configText('["claude:personal"]').replace(scratch.repo, "/somewhere/else"));
    await check(fakeAsker({ answers: ["y"] }), "codex:personal");
    expect(projectEntry(config(), repo)?.allow).toEqual(["claude:personal", "codex:personal"]);
  });
});

describe("One process records the answer", () => {
  test("a write from settings read before another process added the account leaves config.toml as it is", async () => {
    write(configText('["claude:personal"]'));
    const stale = config();
    const after = configText('["claude:personal", "codex:personal"]');
    write(after);
    const result = await checkAllowList({
      asker: fakeAsker({ yes: true }), config: stale, configContext: ctx(), repo, from: account("claude:personal"), fromRunning: true, to: account("codex:personal"), command: "switch",
    });
    expect(result.allowed).toEqual({ account: "codex:personal", company: "OpenAI", how: "flag" });
    expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(after);
  });

  test("a project without an entry in old settings is not given a second entry", async () => {
    const after = configText('["claude:personal"]');
    write(after.replace(scratch.repo, "/somewhere/else"));
    const stale = config();
    write(after);
    await checkAllowList({
      asker: fakeAsker({ yes: true }), config: stale, configContext: ctx(), repo, from: account("claude:personal"), fromRunning: true, to: account("codex:personal"), command: "switch",
    });
    expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(after.replace('allow = ["claude:personal"] #', 'allow = ["claude:personal", "codex:personal"] #'));
  });

  test("answers from relay switch in another terminal are used, and the relay run neither asks nor writes", async () => {
    const before = configText('["claude:personal"]');
    write(before);
    const asker = { ...fakeAsker({ terminal: false }), preset: { newAccount: "flag" as const } };
    const result = await check(asker, "codex:personal");
    expect(result).toEqual({
      allowed: { account: "codex:personal", company: "OpenAI", how: "flag" },
      confirmations: [{ question: QUESTION, how: "flag" }],
    });
    expect(asker.said).toEqual([]);
    expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(before);
  });

  test("without an answer for a new account, the relay run does not ask from its old settings", async () => {
    write(configText('["claude:personal"]'));
    const asker = { ...fakeAsker({ terminal: false }), preset: {} };
    expect(await check(asker, "codex:personal")).toEqual({ allowed: null, confirmations: [] });
  });
});

describe("The question needs a terminal or --yes", () => {
  test("a script without --yes is refused", async () => {
    write(configText('["claude:personal"]'));
    expect(await refusal(check(fakeAsker({ terminal: false }), "codex:personal"))).toEqual({
      code: 7,
      lines: [
        "codex:personal has not worked on this project before. Sending the repository to OpenAI needs your yes.",
        'Run "relay switch codex:personal" in a terminal, or add --yes.',
      ],
    });
  });

  test("a script with --yes adds the account, recorded as given by the flag", async () => {
    write(configText('["claude:personal"]'));
    const asker = fakeAsker({ terminal: false, yes: true });
    expect((await check(asker, "codex:personal")).allowed).toEqual({ account: "codex:personal", company: "OpenAI", how: "flag" });
    expect(asker.said).toEqual([]);
    expect(projectEntry(config(), repo)?.allow).toContain("codex:personal");
  });
});

describe("Second account of the same provider", () => {
  test("the policy's note comes before the question", async () => {
    write(configText('["claude:personal"]'));
    const asker = fakeAsker({ answers: ["y"] });
    expect((await check(asker, "claude:work")).allowed).toMatchObject({ account: "claude:work", company: "Anthropic" });
    expect(asker.said).toEqual([
      "Anthropic says Pro and Max limits assume ordinary, individual use. Moving this job between your own Claude accounts is your choice.",
      "This sends the repository and the job notes to Anthropic through the account claude:work. Continue? [y/N]",
    ]);
  });
});

describe("--yes still shows the note and the warning", () => {
  test("the same-provider note is printed when --yes answers", async () => {
    write(configText('["claude:personal"]'));
    const asker = fakeAsker({ terminal: false, yes: true });
    expect((await check(asker, "claude:work")).allowed).toMatchObject({ how: "flag" });
    expect(asker.said).toEqual([
      "Anthropic says Pro and Max limits assume ordinary, individual use. Moving this job between your own Claude accounts is your choice.",
    ]);
  });

  test("the work-to-personal warning is printed when --yes answers", async () => {
    write(configText('["claude:work", "codex:personal"]'));
    const asker = fakeAsker({ terminal: false, yes: true });
    expect((await check(asker, "codex:personal", "claude:work")).confirmations).toEqual([
      { question: "This job ran on a work account (claude:work). codex:personal is marked personal.", how: "flag" },
    ]);
    expect(asker.said).toEqual(["This job ran on a work account (claude:work). codex:personal is marked personal."]);
  });
});

describe("Work code moving to a personal account", () => {
  const WARNING = "This job ran on a work account (claude:work). codex:personal is marked personal.";

  test("asks on every switch, even for an account on the list", async () => {
    write(configText('["claude:work", "codex:personal"]'));
    for (let i = 0; i < 2; i++) {
      const asker = fakeAsker({ answers: ["y"] });
      expect(await check(asker, "codex:personal", "claude:work")).toEqual({ allowed: null, confirmations: [{ question: WARNING, how: "terminal" }] });
      expect(asker.said).toEqual([WARNING, "Continue? [y/N]"]);
    }
  });

  test("a no after the first question leaves config.toml as it was", async () => {
    const before = configText('["claude:work"]');
    write(before);
    await refusal(check(fakeAsker({ answers: ["y", "n"] }), "codex:personal", "claude:work"));
    expect(readFileSync(join(relayHome, "config.toml"), "utf8")).toBe(before);
  });

  test("personal to work asks nothing", async () => {
    write(configText('["codex:personal", "claude:work"]'));
    const asker = fakeAsker();
    expect(await check(asker, "claude:work", "codex:personal")).toEqual({ allowed: null, confirmations: [] });
    expect(asker.said).toEqual([]);
  });
});
