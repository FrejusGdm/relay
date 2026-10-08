import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJunit } from "./junit.ts";
import type { TestCounts } from "./junit.ts";

export interface Fixture {
  id: string;
  title: string;
  language: "typescript" | "python";
  expected_agent_minutes: number;
  visible_test_command: string[];
  visible_test_match: string;
  acceptance_test_command: string[];
  acceptance_total: number;
  acceptance_fail_at_start_min: number;
  dir: string;
}

export async function loadFixture(tasksDir: string, taskId: string): Promise<Fixture> {
  const dir = resolve(tasksDir, taskId);
  const data = Bun.TOML.parse(await Bun.file(join(dir, "task.toml")).text()) as Record<string, unknown>;
  const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
  const command = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((arg: unknown) => typeof arg === "string");
  const fields: [string, (value: unknown) => boolean][] = [
    ["id", (value) => typeof value === "string"],
    ["title", (value) => typeof value === "string"],
    ["language", (value) => value === "typescript" || value === "python"],
    ["expected_agent_minutes", positive],
    ["visible_test_command", command],
    ["visible_test_match", (value) => typeof value === "string"],
    ["acceptance_test_command", command],
    ["acceptance_total", positive],
    ["acceptance_fail_at_start_min", (value) => typeof value === "number" && Number.isInteger(value) && value >= 0],
  ];
  for (const [field, valid] of fields) {
    if (!Object.hasOwn(data, field)) throw new Error(`Fixture ${taskId}: task.toml has no ${field}.`);
    if (!valid(data[field])) throw new Error(`Fixture ${taskId}: ${field} in task.toml has the wrong type.`);
  }
  if (data.id !== taskId) throw new Error(`Fixture ${taskId}: task.toml says its id is ${data.id}.`);
  for (const name of ["task.md", ".start/", ".acceptance/", "solution/"]) {
    if (!existsSync(join(dir, name))) throw new Error(`Fixture ${taskId}: ${name} is missing.`);
  }
  return { ...data, dir } as unknown as Fixture;
}

export async function checkFixtures(options: {
  tasksDir: string;
  taskIds: string[];
  out: (text: string) => void;
  err: (text: string) => void;
}): Promise<number> {
  const { tasksDir, out, err } = options;
  const taskIds = options.taskIds.length > 0 ? options.taskIds : readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, "task.toml")))
    .map((entry) => entry.name).sort();
  for (const id of taskIds) {
    const dir = join(tasksDir, id);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      err(`No fixture ${id} in ${tasksDir}.\n`);
      return 2;
    }
  }
  let allPassed = true;
  for (const id of taskIds) {
    const temporary: string[] = [];
    const temp = () => {
      const dir = mkdtempSync(join(tmpdir(), "relay-eval-fixture-"));
      temporary.push(dir);
      return dir;
    };
    try {
      const fixture = await loadFixture(tasksDir, id);
      const reports = temp();
      let runNumber = 0;
      const run = async (cwd: string, command: string[], expected?: number) => {
        const path = join(reports, `${++runNumber}.xml`);
        const args = command.map((arg) => arg.replaceAll("{junit}", path)
          .replaceAll("{runners}", join(import.meta.dir, "..", "runners")));
        const child = Bun.spawn(args, { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [exitCode] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { exitCode, counts: await readJunit(path, expected) };
      };
      const state = async (solution: boolean) => {
        const cwd = temp();
        cpSync(join(fixture.dir, ".start"), cwd, { recursive: true });
        if (solution) cpSync(join(fixture.dir, "solution"), cwd, { recursive: true, force: true });
        const visible = await run(cwd, fixture.visible_test_command);
        cpSync(join(fixture.dir, ".acceptance"), join(cwd, "__acceptance__"), { recursive: true });
        const acceptance = await run(cwd, fixture.acceptance_test_command, fixture.acceptance_total);
        return { visible, acceptance };
      };
      const start = await state(false);
      const solution = await state(true);
      const visiblePassed = (result: { exitCode: number; counts: TestCounts }) =>
        result.exitCode === 0 && result.counts.failed === 0 && result.counts.total > 0;
      const names = (counts: TestCounts) => { for (const name of counts.failing) err(`  ${name}\n`); };
      const tooMany = (counts: TestCounts) =>
        err(`Fixture ${id}: the acceptance tests report ${counts.total} tests, but task.toml says ${fixture.acceptance_total}.\n`);
      let passed = false;
      if (!visiblePassed(start.visible)) {
        err(`Fixture ${id}: the visible tests do not pass on the starting repository.\n`);
        names(start.visible.counts);
      } else if (start.acceptance.counts.extra > 0) {
        tooMany(start.acceptance.counts);
      } else if (start.acceptance.counts.failed < fixture.acceptance_fail_at_start_min) {
        err(`Fixture ${id}: only ${start.acceptance.counts.failed} acceptance tests fail on the starting repository, but task.toml asks for at least ${fixture.acceptance_fail_at_start_min}.\n`);
      } else if (!visiblePassed(solution.visible)) {
        err(`Fixture ${id}: the visible tests do not pass with the reference solution.\n`);
        names(solution.visible.counts);
      } else if (solution.acceptance.counts.extra > 0) {
        tooMany(solution.acceptance.counts);
      } else if (solution.acceptance.counts.failed > 0) {
        const counts = solution.acceptance.counts;
        err(`Fixture ${id}: the reference solution fails ${counts.failed} acceptance tests.\n`);
        names(counts);
        if (counts.missing > 0) err(`  ${counts.missing} tests reported no result, for example because a test file failed to load.\n`);
      } else if (solution.acceptance.exitCode !== 0) {
        err(`Fixture ${id}: the acceptance tests exit with code ${solution.acceptance.exitCode} with the reference solution.\n`);
      } else {
        passed = true;
        out(`${id} is ready.\n`);
      }
      if (!passed) allPassed = false;
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      allPassed = false;
    } finally {
      for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (allPassed && taskIds.length > 1) out(`All ${taskIds.length} fixtures are ready.\n`);
  return allPassed ? 0 : 1;
}
