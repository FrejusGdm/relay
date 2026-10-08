import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFixture } from "../src/fixtures.ts";
import { exportTree, git } from "../src/git.ts";
import { measureCommit } from "../src/measure.ts";
import { cleanup, commitAll, REPO, temp } from "./helpers.ts";

afterEach(cleanup);

test("The rate-limiter fixture fails at its start and passes with its solution", async () => {
  const tasksDir = join(REPO, "eval", "handoff", "tasks");
  const fixture = await loadFixture(tasksDir, "rate-limiter");
  const repo = join(temp("repo"), "repo");
  cpSync(join(fixture.dir, ".start"), repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  const start = await commitAll(repo, "start");
  cpSync(join(fixture.dir, "solution"), repo, { recursive: true, force: true });
  const solved = await commitAll(repo, "solution");
  const reports = temp("reports");
  const runnersDir = join(REPO, "eval", "handoff", "runners");

  const atStart = await measureCommit({ repo, sha: start, fixture, runnersDir, acceptanceXml: join(reports, "start.xml"), visibleXml: join(reports, "visible-start.xml") });
  expect(atStart.visible?.failed).toBe(0);
  expect(atStart.visible?.total).toBeGreaterThan(0);
  expect(atStart.acceptance.total).toBe(10);
  expect(atStart.acceptance.failed).toBeGreaterThanOrEqual(7);
  expect(atStart.acceptancePassing.length).toBe(atStart.acceptance.passed);

  const atSolution = await measureCommit({ repo, sha: solved, fixture, runnersDir, acceptanceXml: join(reports, "solution.xml") });
  expect(atSolution.visible).toBeNull();
  expect(atSolution).toMatchObject({ acceptance: { passed: 10, failed: 0, total: 10, failing: [] } });
  expect(atSolution.acceptancePassing).toHaveLength(10);
  expect(existsSync(join(reports, "visible-solution.xml"))).toBe(false);
  // The acceptance tests never reach the repository.
  expect(readdirSync(repo)).not.toContain("__acceptance__");
}, 60000);

test("An export holds exactly the committed files", async () => {
  const repo = join(temp("repo"), "repo");
  cpSync(join(REPO, "eval", "handoff", "test", "data", "fixtures", "tiny-ready", ".start"), repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  const sha = await commitAll(repo, "start");
  const target = join(temp("export"), "tree");
  await exportTree(repo, sha, target);
  expect(readdirSync(target).sort()).toEqual(["src", "test"]);
  expect(existsSync(`${target}.tar`)).toBe(false);
});
