import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/result.ts";
import { cleanup, evalCommand, sampleHome } from "./helpers.ts";

afterEach(cleanup);

const RUN = "ledger-import__handoff__claude-to-codex__steps-50__r2";

test("A note is saved in result.json and shown in summary.md", async () => {
  const home = sampleHome("all-rules-pass");
  const note = "Reworked src/csv.ts for the same purpose: quoting.";
  expect(await evalCommand(["annotate", "all-rules-pass", RUN, note], home))
    .toEqual({ exitCode: 0, stdout: `Saved the note for ${RUN}.\n`, stderr: "" });
  const path = join(home, "campaigns", "all-rules-pass", "runs", RUN, "result.json");
  const result = JSON.parse(readFileSync(path, "utf8")) as RunResult;
  expect(result.notes).toBe(note);
  expect(result.status).toBe("completed");
  expect((await evalCommand(["summarize", "all-rules-pass"], home)).exitCode).toBe(0);
  expect(readFileSync(join(home, "campaigns", "all-rules-pass", "summary.md"), "utf8"))
    .toContain(`- [${RUN}](runs/${RUN}/): 1 regression; 2 claims found false; note: ${note}\n`);
}, 30000);

test("An unknown run ID is refused with exit code 2", async () => {
  const home = sampleHome("all-rules-pass");
  for (const id of ["nope", "../all-rules-pass"]) {
    expect(await evalCommand(["annotate", "all-rules-pass", id, "text"], home))
      .toEqual({ exitCode: 2, stdout: "", stderr: `No run ${id} in campaign all-rules-pass.\n` });
  }
}, 30000);
