// Starting the next agent (task 5.4): a start that succeeds, a program that cannot start, and an
// agent that exits with code 1 within handoff.start_check_seconds.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterRegistry } from "../../src/adapters/registry";
import type { ProviderAdapter } from "../../src/adapters/types";
import type { CommandContext } from "../../src/cli/commands/registry";
import { loadConfig } from "../../src/core/config/load";
import { JobSupervisor } from "../../src/run/run";
import { jobEvents, until, workers } from "../run/helpers";
import { relayIn, relayProcess, Scenarios, switchFixture, type SwitchFixture } from "./switch-helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

const handoff = (number: number) =>
  JSON.parse(readFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", String(number), "handoff.json"), "utf8"));

async function prepared(): Promise<void> {
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
  expect((await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"])).code).toBe(0);
}

test("a start that succeeds: worker_started with from_handoff, and the handoff is started", async () => {
  fixture = await switchFixture();
  await prepared();
  fixture.scenarios.set({ codex: { turns: [{ steps: [{ say: "Continuing." }] }] } });
  const result = await relayIn(fixture, ["run", "codex:personal", "--headless", "--prompt", "Go."]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("Using the prepared handoff 1\nStarting Codex · personal\n");
  expect(result.stdout).toContain("Continuing on Codex.\n");
  const codex = workers(fixture).find((record) => record.account === "codex:personal")!;
  expect(jobEvents(fixture).find((event) => event.type === "worker_started" && event.data.worker_id === codex.worker_id)?.data)
    .toMatchObject({ from_handoff: 1, start_checkpoint: expect.any(Number) });
  expect(handoff(1)).toMatchObject({ outcome: "started", to_worker_id: codex.worker_id });
});

test("an agent that exits with code 1 within the start check: exit 31 and the handoff stays ready", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true }] }] }, codex: Scenarios.fixture("codex-exits-at-once.json") });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  expect((await relayIn(fixture, ["switch", "codex:personal", "--no-summary"])).code).toBe(31);
  await run.exited;
  expect(handoff(1).outcome).toBe("start_failed");
  const codex = workers(fixture).find((record) => record.account === "codex:personal")!;
  expect(codex.end_reason).toBe("start_failed");
});

test("a program that cannot start: the start fails with the adapter's error and no worker starts", async () => {
  fixture = await switchFixture();
  const config = loadConfig({ relayHome: fixture.relayHome, homedir: fixture.scratch.home, uid: process.getuid!() });
  let out = "";
  const ctx = {
    io: { out: (text: string) => (out += text), err: (text: string) => (out += text), isTerminal: false },
    env: { ...process.env, ...fixture.env }, relayHome: fixture.relayHome, homedir: fixture.scratch.home, config, cwd: fixture.scratch.repo,
  } as unknown as CommandContext;
  const job = { id: fixture.jobId, worktreeRoot: fixture.scratch.repo, relayHome: fixture.relayHome };
  const registry = createAdapterRegistry({}, ctx.env);
  const broken: ProviderAdapter = { ...registry.get("codex"), start: () => Promise.reject(new Error("codex could not be started.")) };
  const supervisor = new JobSupervisor(ctx, job, registry, () => {}, false);
  try {
    const worker = await supervisor.begin({
      account: config.accounts.find((account) => account.id === "codex:personal")!, adapter: broken, mode: "interactive",
      permission: "edit-in-workspace", instructions: "i", prompt: "p", providerVersion: null, startCheckpoint: 1, fromHandoff: 1, startCheck: true,
    });
    expect(await worker.started).toEqual({ ok: false, reason: "codex could not be started" });
    expect(jobEvents(fixture).some((event) => event.type === "worker_started")).toBe(false);
  } finally {
    supervisor.close();
  }
});
