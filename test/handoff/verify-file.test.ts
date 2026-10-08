import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { countVerification, readVerifyFile } from "../../src/handoff/verify-file";
import { makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

const TABLE = `# Verification of handoff 3

| Claim | Holds | Evidence |
|---|---|---|
| \`bun test\` passes | no | 1 test fails |
| callback exported | yes | src/auth/callback.ts line 1 |
| sessions in cookies | YES | src/auth/session.ts |
| logout route | Yes | routes.ts |
| token refresh | maybe | not tested |
`;

describe("Verification file", () => {
  test("rows are counted by their Holds cell", () => {
    expect(countVerification(TABLE)).toEqual({ rows: 5, yes: 3, no: 1, unclear: 1 });
  });

  test("a table with extra columns, in another order", () => {
    const text = "| # | Claim | Evidence | Holds | Checked by |\n| --- | --- | --- | :---: | --- |\n| 1 | a | b | no | codex |\n| 2 | c | d | | codex |\n\nAfter the table.\n| not | a | row |\n";
    expect(countVerification(text)).toEqual({ rows: 2, yes: 0, no: 1, unclear: 1 });
  });

  test("a file with no table has 0 rows", () => {
    expect(countVerification("Everything holds.\n- yes\n")).toEqual({ rows: 0, yes: 0, no: 0, unclear: 0 });
    expect(countVerification("| Claim | Evidence |\n|---|---|\n| a | b |\n")).toEqual({ rows: 0, yes: 0, no: 0, unclear: 0 });
  });

  describe("in a checkpoint", () => {
    let job: Job;
    beforeAll(async () => { job = await makeJob(); });
    afterAll(() => job.scratch.cleanup());

    test("the file is read from the checkpoint that stores it", async () => {
      const without = await job.save().catch(() => null);
      job.scratch.write(".relay/verify.md", TABLE);
      const withFile = await job.save();
      const repo = await job.repo();
      expect(await readVerifyFile(repo, withFile)).toBe(TABLE);
      const baseline = job.scratch.git("rev-parse", `refs/relay/jobs/${job.jobId}/checkpoints/1`).trim();
      expect(await readVerifyFile(repo, without ?? baseline)).toBeNull();
    });
  });
});
