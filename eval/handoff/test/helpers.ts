// Helpers for the harness tests that need a relay repository, a scratch repository or the stub
// relay. Nothing here starts a real provider: the stub plays scenarios instead of agents.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../src/git.ts";
import type { StubScenario } from "./bin/stub-relay.ts";

export const REPO = resolve(import.meta.dir, "..", "..", "..");
export const STUB_RELAY = join(import.meta.dir, "bin", "relay");
const FIXTURE_DATA = join(import.meta.dir, "data", "fixtures");

const folders: string[] = [];
// Each test file calls afterEach(cleanup).
export function cleanup(): void {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function temp(name = "test"): string {
  const dir = mkdtempSync(join(tmpdir(), `relay-eval-${name}-`));
  folders.push(dir);
  return dir;
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "--allow-empty", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

// A git repository with one commit, holding the given files.
export async function gitRepo(files: Record<string, string>): Promise<string> {
  const repo = join(temp("repo"), "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  await commitAll(repo, "start");
  return repo;
}

// A committed copy of the harness with the named fixtures under eval/handoff/tasks/, so that runs
// can export fixtures from it with git archive. A fixture name is taken from eval/handoff/tasks/
// or, for the tiny-* samples, from test/data/fixtures/; samples get a NOTES.md like the real ones.
export async function relayRepo(fixtures: string[]): Promise<string> {
  const root = join(temp("relay-repo"), "relay");
  for (const folder of ["src", "plans", "runners"]) {
    cpSync(join(REPO, "eval", "handoff", folder), join(root, "eval", "handoff", folder), { recursive: true });
  }
  for (const id of fixtures) {
    const target = join(root, "eval", "handoff", "tasks", id);
    if (id.startsWith("tiny-")) {
      cpSync(join(FIXTURE_DATA, id), target, { recursive: true });
      writeFileSync(join(target, ".start", "NOTES.md"), "# Notes\n\nKeep the library small.\n");
    } else {
      cpSync(join(REPO, "eval", "handoff", "tasks", id), target, { recursive: true });
    }
  }
  await git(root, ["init", "-q", "-b", "main"]);
  await commitAll(root, "harness");
  return root;
}

export function writeScenario(scenario: StubScenario): string {
  const path = join(temp("scenario"), "scenario.json");
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}

export function readEvents(repo: string): { type: string; data: Record<string, unknown> }[] {
  return readFileSync(join(repo, ".relay", "events.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

export async function stub(cwd: string, args: string[], scenario?: string) {
  const env = { ...process.env, ...(scenario === undefined ? {} : { RELAY_STUB_SCENARIO: scenario }) };
  const child = Bun.spawn([STUB_RELAY, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// Runs `bun run eval:handoff` with the given RELAY_EVAL_HOME and standard input closed.
export async function evalCommand(args: string[], home: string) {
  const child = Bun.spawn([process.execPath, "run", join(REPO, "eval", "handoff", "src", "main.ts"), ...args], {
    cwd: REPO, env: { ...process.env, RELAY_EVAL_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// A temporary RELAY_EVAL_HOME holding a copy of a sample campaign from test/data/campaigns/.
export function sampleHome(name: string): string {
  const home = temp("eval-home");
  cpSync(join(import.meta.dir, "data", "campaigns", name), join(home, "campaigns", name), { recursive: true });
  return home;
}
