// Task 4.2: projects.list is appended only when a root is new, and read without duplicates; every
// command that resolves a job lists its project.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { projectsListPath, readProjects, registerProject } from "../../src/state/projects-list";
import { FAKE_SCANNER, relay, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

test("a root is appended once, with mode 0600, and duplicate lines are read once", () => {
  const relayHome = tempRelayHome();
  expect(readProjects(relayHome)).toEqual([]);
  registerProject(relayHome, "/projects/app");
  registerProject(relayHome, "/projects/app");
  registerProject(relayHome, "/projects/api");
  expect(readFileSync(projectsListPath(relayHome), "utf8")).toBe("/projects/app\n/projects/api\n");
  expect(statSync(projectsListPath(relayHome)).mode & 0o777).toBe(0o600);

  // Two commands that appended the same root at once, a blank line and a relative path.
  appendFileSync(projectsListPath(relayHome), "/projects/app\n\nrelative/path\n/projects/app\n");
  expect(readProjects(relayHome)).toEqual(["/projects/app", "/projects/api"]);
});

test("a relative root or one with a newline is never written", () => {
  const relayHome = tempRelayHome();
  registerProject(relayHome, "projects/app");
  registerProject(relayHome, "/projects/a\n/etc");
  expect(readProjects(relayHome)).toEqual([]);
});

test("a command that resolves a job lists its project once", async () => {
  const scratch = await setUpJob("full", undefined, FAKE_SCANNER);
  try {
    rmSync(projectsListPath(scratch.relayHome));
    expect((await relay(scratch, ["checkpoints"], { quiet: true })).code).toBe(0);
    expect((await relay(scratch, ["checkpoints"], { quiet: true })).code).toBe(0);
    expect(readFileSync(projectsListPath(scratch.relayHome), "utf8")).toBe(`${scratch.repo}\n`);
  } finally {
    scratch.cleanup();
  }
});
