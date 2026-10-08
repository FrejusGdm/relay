// Runs a fixture's tests on an exported commit (add-handoff-evaluation design decision 7). The
// acceptance tests are copied only into this temporary export, never into a folder an agent uses.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTree } from "./git.ts";
import { passingTests, readJunit } from "./junit.ts";
import type { Fixture } from "./fixtures.ts";
import type { TestCounts } from "./junit.ts";

// Code written by an agent can hang its tests; a test run that takes longer is stopped and its
// missing results count as failed.
const TEST_LIMIT_MS = 15 * 60 * 1000;

export interface Measurement {
  visible: TestCounts | null;
  acceptance: TestCounts;
  acceptancePassing: string[];
}

async function runTests(cwd: string, command: string[], junit: string, runnersDir: string): Promise<void> {
  rmSync(junit, { force: true });
  const args = command.map((arg) => arg.replaceAll("{junit}", junit).replaceAll("{runners}", runnersDir));
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), TEST_LIMIT_MS);
  try {
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  } finally {
    clearTimeout(timer);
  }
}

// Exports `sha`, runs the visible tests when `visibleXml` is given, then adds the acceptance tests
// as __acceptance__/ and runs them. The JUnit reports are written to the given paths.
export async function measureCommit(options: {
  repo: string;
  sha: string;
  fixture: Fixture;
  runnersDir: string;
  acceptanceXml: string;
  visibleXml?: string;
}): Promise<Measurement> {
  const { fixture, runnersDir } = options;
  const temporary = mkdtempSync(join(tmpdir(), "relay-eval-measure-"));
  try {
    const tree = join(temporary, "tree");
    await exportTree(options.repo, options.sha, tree);
    let visible: TestCounts | null = null;
    if (options.visibleXml !== undefined) {
      await runTests(tree, fixture.visible_test_command, options.visibleXml, runnersDir);
      visible = await readJunit(options.visibleXml);
    }
    cpSync(join(fixture.dir, ".acceptance"), join(tree, "__acceptance__"), { recursive: true });
    await runTests(tree, fixture.acceptance_test_command, options.acceptanceXml, runnersDir);
    return {
      visible,
      acceptance: await readJunit(options.acceptanceXml, fixture.acceptance_total),
      acceptancePassing: await passingTests(options.acceptanceXml),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
