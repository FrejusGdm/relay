import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

    test("editing state.json does not raise the ceiling", () => {
      const relayHome = join(root, "relay-home");
      writeHandoffSettings(relayHome, job("headless", "read-only"));
      writeFileSync(join(root, "state.json"), JSON.stringify({ permission: "full-access", mode: "headless" }));
      const settings = readHandoffSettings(relayHome, "3f9a2c1d")!;
      expect(nextStart(settings, { startMode: "headless", outgoingLevel: "read-only" }).permission).toBe("read-only");
      expect(refused(() => nextStart(settings, { startMode: "headless", permission: "edit-in-workspace", outgoingLevel: "read-only" })).code).toBe(32);
    });
  });
});
