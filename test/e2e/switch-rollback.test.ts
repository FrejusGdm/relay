// Rolling back across a handoff (task 7.7): after a switch and some Codex edits, relay rollback to
// the work checkpoint restores its files, and rolling back to the pre_rollback checkpoint brings
// Codex's edits back.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relayProcess } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

async function run(args: string[]) {
  const child = relayProcess(fixture, args);
  const code = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr() };
}

const checkpoints = async () => JSON.parse((await run(["checkpoints", "--json"])).stdout) as { number: number; kind: string }[];

test("rollback to the work checkpoint, and back to the checkpoint that holds Codex's edits", async () => {
  fixture = await e2eFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/claude.ts", content: "claude\n" }, { say: "Done." }] }] } });
  expect((await run(["run", "claude:personal", "--headless", "--prompt", "Go."])).code).toBe(0);
  expect((await run(["switch", "codex:personal", "--no-start", "--no-summary"])).code).toBe(0);
  const work = JSON.parse(readFileSync(join(fixture.scratch.repo, ".relay", "state.json"), "utf8")).last_handoff.checkpoint_number as number;
  fixture.scenarios.set({ codex: { turns: [{ steps: [{ write: "src/codex.ts", content: "codex\n" }, { write: "src/claude.ts", content: "changed by codex\n" }, { say: "Done." }] }] } });
  expect((await run(["run", "codex:personal", "--headless", "--prompt", "Go."])).code).toBe(0);

  // relay saved Codex's edits when Codex exited, so the rollback's undo point is that checkpoint
  // (a pre_rollback checkpoint is saved only when files changed since the latest one).
  const undo = (await checkpoints())[0]!;
  const back = await run(["rollback", String(work), "--yes"]);
  expect(back.code).toBe(0);
  expect(existsSync(join(fixture.scratch.repo, "src/codex.ts"))).toBe(false);
  expect(readFileSync(join(fixture.scratch.repo, "src/claude.ts"), "utf8")).toBe("claude\n");

  expect((await run(["rollback", String(undo.number), "--yes"])).code).toBe(0);
  expect(readFileSync(join(fixture.scratch.repo, "src/codex.ts"), "utf8")).toBe("codex\n");
  expect(readFileSync(join(fixture.scratch.repo, "src/claude.ts"), "utf8")).toBe("changed by codex\n");
});
