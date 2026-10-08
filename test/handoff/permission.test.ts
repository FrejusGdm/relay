import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { nextStart } from "../../src/handoff/permission";
import { readHandoffSettings, writeHandoffSettings, type HandoffSettings } from "../../src/handoff/settings";

const job = (mode: "interactive" | "headless", permission: HandoffSettings["permission"]): HandoffSettings => ({
  schema_version: 1, job_id: "3f9a2c1d", mode, permission, checks: [], next_handoff: 1,
});
function refused(run: () => unknown): { code: number; lines: string[] } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    return { code: (error as CommandError).code, lines: (error as CommandError).lines };
  }
  throw new Error("not refused");
}

describe("Supervision never goes down", () => {
  test("a headless start of an interactive job is refused", () => {
    expect(refused(() => nextStart(job("interactive", null), { startMode: "headless", outgoingLevel: null }))).toEqual({
      code: 32,
      lines: ["This job runs agents in your terminal. relay switch never starts the next agent with less supervision than that."],
    });
  });

  test("an interactive job starts the next agent in the terminal, with no permission level", () => {
    expect(nextStart(job("interactive", null), { startMode: "interactive", outgoingLevel: null })).toEqual({ mode: "interactive", permission: null });
    expect(nextStart(job("interactive", null), { startMode: "none", outgoingLevel: null })).toEqual({ mode: "none", permission: null });
  });

  test("a headless job starts the next agent headless", () => {
    expect(nextStart(job("headless", "read-only"), { startMode: "interactive", outgoingLevel: "read-only" })).toEqual({ mode: "headless", permission: "read-only" });
  });
});

describe("Permission never goes up", () => {
  test("a level above the ceiling is refused", () => {
    expect(refused(() => nextStart(job("headless", "read-only"), { startMode: "headless", permission: "edit-in-workspace", outgoingLevel: "read-only" }))).toEqual({
      code: 32, lines: ["This job allows read-only. relay switch never gives the next agent more than that."],
    });
  });

  test("a lower level is accepted, and the ceiling stays", () => {
    const settings = job("headless", "edit-in-workspace");
    expect(nextStart(settings, { startMode: "headless", permission: "read-only", outgoingLevel: "edit-in-workspace" })).toEqual({ mode: "headless", permission: "read-only" });
    expect(settings.permission).toBe("edit-in-workspace");
  });

  test("without --permission the next agent gets the outgoing worker's level", () => {
    expect(nextStart(job("headless", "edit-in-workspace"), { startMode: "headless", outgoingLevel: "read-only" }).permission).toBe("read-only");
    expect(nextStart(job("headless", "edit-in-workspace"), { startMode: "headless", outgoingLevel: null }).permission).toBe("edit-in-workspace");
  });

  describe("the ceiling comes from RELAY_HOME", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), "relay-permission-")); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    test("editing state.json does not raise the ceiling: the ceiling is read from handoff-settings.json", () => {
      const relayHome = join(root, "relay-home");
      writeHandoffSettings(relayHome, job("headless", "read-only"));
      const relayDir = join(root, "repo", ".relay");
      mkdirSync(relayDir, { recursive: true });
      writeFileSync(join(relayDir, "state.json"), JSON.stringify({ permission: "full-access", mode: "headless", ceiling: "edit-in-workspace" }));
      const settings = readHandoffSettings(relayHome, "3f9a2c1d")!;
      expect(settings.permission).toBe("read-only");
      expect(nextStart(settings, { startMode: "headless", outgoingLevel: "read-only" }).permission).toBe("read-only");
      // A caller that took the level from state.json is refused, whatever the level is called.
      const forged = JSON.parse(readFileSync(join(relayDir, "state.json"), "utf8"));
      for (const permission of [forged.permission, forged.ceiling]) {
        expect(refused(() => nextStart(settings, { startMode: "headless", permission, outgoingLevel: "read-only" })).code).toBe(32);
      }
    });

    test("a level relay does not know is above every ceiling", () => {
      const settings = job("headless", "edit-in-workspace");
      for (const permission of ["full-access", "__proto__", "toString"]) {
        expect(refused(() => nextStart(settings, { startMode: "headless", permission: permission as "read-only", outgoingLevel: null }))).toEqual({
          code: 32, lines: ["This job allows edit-in-workspace. relay switch never gives the next agent more than that."],
        });
      }
      expect(refused(() => nextStart(settings, { startMode: "headless", outgoingLevel: "full-access" as "read-only" })).code).toBe(32);
    });
  });
});

describe("No bypass flags", () => {
  const BYPASS = ["--dangerously-skip-permissions", "bypassPermissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "danger-full-access"];

  test("the argument lists and messages the real adapters send hold none of the bypass strings", async () => {
    const { switchFixture } = await import("./switch-helpers");
    const { createAdapterRegistry } = await import("../../src/adapters/registry");
    const { buildAgentEnv } = await import("../../src/accounts/environment");
    const { loadConfig } = await import("../../src/core/config/load");
    const { NOTES_REQUEST } = await import("../../src/handoff/notes-request");
    const fixture = await switchFixture();
    try {
      fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Ok." }] }] }, codex: { turns: [{ steps: [{ say: "Ok." }] }] } });
      const config = loadConfig({ relayHome: fixture.relayHome, homedir: fixture.scratch.home, uid: process.getuid!() });
      const env = { ...process.env, ...fixture.env };
      const registry = createAdapterRegistry({}, env);
      const cases = [
        { mode: "interactive", permission: "edit-in-workspace", prompt: "Start." },
        { mode: "headless", permission: "read-only", prompt: "Start." },
        { mode: "headless", permission: "edit-in-workspace", prompt: "Start." },
        { mode: "headless", permission: "read-only", prompt: NOTES_REQUEST, resume: "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f" },
      ] as const;
      let index = 0;
      for (const account of config.accounts) {
        for (const item of cases) {
          const record = join(fixture.scratch.root, `record-${index++}.json`);
          const workerId = "0000000" + String(index % 10);
          const handle = await registry.get(account.provider).start(account, {
            jobId: fixture.jobId, workerId, cwd: fixture.scratch.repo, mode: item.mode, instructions: "Instructions.", prompt: item.prompt,
            permission: item.permission, ...("resume" in item ? { resumeSessionId: item.resume } : {}),
            env: { ...buildAgentEnv(account, env, { jobId: fixture.jobId, workerId }), RELAY_FAKE_RECORD: record, RELAY_KEEP_FAKE_ENV: "1" },
            logPath: join(fixture.relayHome, "logs", "workers", `${fixture.jobId}-${workerId}.log`),
          });
          await Bun.sleep(300);
          await handle.stop({ timeoutMs: 2000 });
          const seen = `${JSON.stringify(handle.argv)}\n${readFileSync(record, "utf8")}`;
          for (const flag of BYPASS) expect(seen).not.toContain(flag);
        }
      }
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});
