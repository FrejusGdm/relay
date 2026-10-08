// The checks of relay run before an agent starts, one test per exit code (task 9.2).
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAccountRecord, startAccountRecord } from "../../src/accounts/record";
import type { CommandContext } from "../../src/cli/commands/registry";
import { loadConfig } from "../../src/core/config/load";
import { policyOf } from "../../src/policies/load";
import { allowOnProject } from "../../src/run/run";
import { ACCOUNTS, relayRun, runFixture, steps, workers } from "./helpers";

// add-relay-switch: a second relay run in a job continues it through a handoff, which takes longer.
setDefaultTimeout(30_000);

const finish = steps({ say: "Done." });
const config = (fixture: { relayHome: string }) => readFileSync(join(fixture.relayHome, "config.toml"), "utf8");

describe("exit 2", () => {
  test("no account named and no default", async () => {
    const fixture = await runFixture();
    try {
      expect(await relayRun(fixture, ["--headless", "--prompt", "Hi."], finish)).toEqual({
        code: 2, stdout: "", stderr: "Name an account, for example relay run claude:personal, or set defaults.account in config.toml.\n",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("headless without a prompt, both prompt options, and an unknown permission", async () => {
    const fixture = await runFixture();
    try {
      expect(await relayRun(fixture, ["codex:personal", "--headless"])).toMatchObject({ code: 2, stderr: "A headless run needs --prompt or --prompt-file.\n" });
      const file = join(fixture.scratch.root, "prompt.txt");
      writeFileSync(file, "Hi.");
      expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "a", "--prompt-file", file])).toMatchObject({
        code: 2, stderr: "relay: give --prompt or --prompt-file, not both.\n",
      });
      expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "a", "--permission", "all"])).code).toBe(2);
      expect((await relayRun(fixture, ["claude:work", "--json"])).stderr).toBe("relay: --json works only with --headless.\n");
      expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "x".repeat(101 * 1024)])).stderr)
        .toBe("The prompt is too long to pass on the command line; put it in a file under .relay/ and refer to it.\n");
      expect(workers(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("--model and --permission are refused for an agent in the terminal, and --resume needs a UUID", async () => {
    const fixture = await runFixture();
    try {
      expect(await relayRun(fixture, ["claude:work", "--model", "opus"], finish)).toMatchObject({
        code: 2, stderr: "relay: --model works only with --headless.\n",
      });
      expect(await relayRun(fixture, ["codex:personal", "--permission", "read-only"], finish)).toMatchObject({
        code: 2, stderr: "relay: --permission works only with --headless. An agent in your terminal asks you itself.\n",
      });
      expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go.", "--resume", "--help-me"], finish)).toMatchObject({ code: 2 });
      expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go.", "--resume=abc"], finish)).toMatchObject({
        code: 2, stderr: "relay: --resume needs a session ID, which is a UUID, or last.\n",
      });
      expect(workers(fixture)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("a provider with two accounts must be named", async () => {
    const fixture = await runFixture('[accounts."codex:personal"]\n\n[accounts."codex:work"]\n');
    try {
      expect(await relayRun(fixture, ["codex", "--headless", "--prompt", "Hi."], finish)).toMatchObject({
        code: 2, stderr: "relay: You have two Codex accounts: codex:personal, codex:work. Name one, for example relay run codex:personal.\n",
      });
    } finally {
      fixture.cleanup();
    }
  });
});

test("exit 20: the program is too old or missing", async () => {
  const fixture = await runFixture();
  try {
    expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], { tool_version: "2.1.100" })).toMatchObject({
      code: 20, stderr: "relay needs Claude Code 2.1.282 or newer. You have 2.1.100. Update Claude Code, then try again.\n",
    });
    expect(await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Hi."], {}, { RELAY_CODEX_BIN: join(fixture.scratch.root, "missing") }))
      .toMatchObject({ code: 20, stderr: "Codex is not installed. Install it, then try again.\n" });
  } finally {
    fixture.cleanup();
  }
});

test("exit 21: the account is not configured", async () => {
  const fixture = await runFixture();
  try {
    expect(await relayRun(fixture, ["claude:nope", "--headless", "--prompt", "Hi."])).toMatchObject({
      code: 21, stderr: "claude:nope is not one of your accounts. See relay account list.\n",
    });
  } finally {
    fixture.cleanup();
  }
});

test("exit 22: signed out, or the key variable is missing", async () => {
  const fixture = await runFixture(`${'[accounts."claude:work"]\n\n'}[accounts."claude:api"]\ncredential_env = ["ANTHROPIC_API_KEY"]\n`);
  try {
    expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], { auth: { signed_in: false } })).toMatchObject({
      code: 22, stderr: "claude:work is not signed in. Run relay account login claude:work.\n",
    });
    expect(readAccountRecord(fixture.relayHome, { id: "claude:work", provider: "claude", name: "work" }).last_auth?.signed_in).toBe(false);
    expect(await relayRun(fixture, ["claude:api", "--headless", "--prompt", "Hi."])).toMatchObject({
      code: 22, stderr: "claude:api needs $ANTHROPIC_API_KEY, which is not set.\n",
    });
  } finally {
    fixture.cleanup();
  }
});

test("exit 25: full access, and an account the project's allow list does not name", async () => {
  const fixture = await runFixture();
  try {
    expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi.", "--permission", "full-access"], finish)).toMatchObject({
      code: 25, stderr: "relay does not start agents with full access in this version.\n",
    });
    expect(config(fixture)).not.toContain("[[projects]]");

    const first = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], finish);
    expect(first.code).toBe(0);
    expect(first.stdout.split("\n")[0]).toBe("Allowed claude:work on this project.");
    expect(config(fixture)).toEndWith(`[[projects]]\npath = ${JSON.stringify(fixture.scratch.repo)}\nallow = ["claude:work"]\n`);
    expect((await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], finish)).stdout).not.toContain("Allowed");

    // add-relay-switch: an account the list does not name is asked about instead of refused.
    expect(await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Hi."], finish)).toMatchObject({
      code: 7,
      stderr: 'codex:personal has not worked on this project before. Sending the repository to OpenAI needs your yes.\nRun "relay run codex:personal" in a terminal, or add --yes.\n',
    });
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("exit 78: a profile folder other users can change", async () => {
  const fixture = await runFixture();
  try {
    const profile = join(fixture.relayHome, "profiles", "claude-work");
    mkdirSync(profile, { recursive: true });
    chmodSync(profile, 0o777);
    expect(await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Hi."], finish)).toMatchObject({
      code: 78, stderr: `Other users can change ${profile}. Run chmod 700 on it, then try again.\n`,
    });
  } finally {
    fixture.cleanup();
  }
});

test("a provider alone means its only account, and a changed policy is announced once", async () => {
  const fixture = await runFixture();
  try {
    startAccountRecord(fixture.relayHome, { id: "claude:work", provider: "claude", name: "work" }, { policy_checked_on_seen: "2026-01-01" });
    const notice = "The Claude Code policy notes changed since you last saw them. Read them with relay policy show claude.";
    const first = await relayRun(fixture, ["claude", "--headless", "--prompt", "Hi."], finish);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`${notice}\n`);
    expect(readAccountRecord(fixture.relayHome, { id: "claude:work", provider: "claude", name: "work" }).policy_checked_on_seen)
      .toBe(policyOf("claude").checkedOn);
    expect((await relayRun(fixture, ["claude", "--headless", "--prompt", "Hi."], finish)).stdout).not.toContain(notice);
  } finally {
    fixture.cleanup();
  }
});

test("a project entry added by another relay run after the settings were read is not added twice", async () => {
  const fixture = await runFixture();
  try {
    const entry = (allow: string) => `\n[[projects]]\npath = ${JSON.stringify(fixture.scratch.repo)}\nallow = ["${allow}"]\n`;
    const loaded = loadConfig({ relayHome: fixture.relayHome, homedir: fixture.scratch.home, uid: process.getuid!() });
    const ctx = { config: loaded, relayHome: fixture.relayHome, homedir: fixture.scratch.home } as unknown as CommandContext;
    const work = loaded.accounts.find((account) => account.id === "claude:work")!;
    const codex = loaded.accounts.find((account) => account.id === "codex:personal")!;
    // The other run's entry appears between the load above and this run's change.
    writeFileSync(join(fixture.relayHome, "config.toml"), ACCOUNTS + entry("claude:work"), { mode: 0o600 });
    const said: string[] = [];
    allowOnProject(ctx, work, fixture.scratch.repo, (line: string) => said.push(line));
    expect(said).toEqual([]);
    expect(config(fixture).match(/\[\[projects\]\]/g)).toHaveLength(1);
    // add-relay-switch: an account the entry does not name is asked about later, not refused here.
    expect(allowOnProject(ctx, codex, fixture.scratch.repo, () => {})).toBe(false);
    expect(config(fixture).match(/\[\[projects\]\]/g)).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
});
