// Task 10.2: relay status --json, --job, and the exit codes 0, 2 and 3.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView } from "../../src/status/model";
import { renderJson } from "../../src/status/render-json";
import { jobId, relay, setUpJob } from "../helpers/job";
import type { ScratchRepo } from "../helpers/scratch-repo";
import { NOW, SCENARIOS } from "./scenarios";

const scratches: ScratchRepo[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0).reverse()) scratch.cleanup();
});

test("every field is present, with null for what relay does not know, and no total", () => {
  const output = renderJson(buildView(SCENARIOS["after-handoff"]!), NOW);
  expect(output.endsWith("}\n")).toBe(true);
  const status = JSON.parse(output);
  expect(Object.keys(status)).toEqual(["schema", "daemon", "generated_at", "job", "checkpoint", "accounts"]);
  expect(status).toMatchObject({ schema: "relay.status/v1", daemon: "running", generated_at: "2026-10-07T14:32:00.000Z" });
  expect(status.job).toEqual({
    id: "3f9a2c1d",
    title: "Build authentication",
    state: "active",
    project_root: "/projects/app",
    current_worker: { id: "w2", target: "codex:personal", state: "running", from_handoff: true, started_at: "2026-10-07T14:20:05.000Z" },
  });
  expect(Object.keys(status.checkpoint)).toEqual(["number", "commit", "ref", "kind", "created_at", "message"]);
  expect(status.accounts.map((entry: { target: string; role: string; activity: string }) => [entry.target, entry.role, entry.activity])).toEqual([
    ["claude:work", "previous", "idle"],
    ["codex:personal", "current", "running"],
    ["claude:home", "other", "idle"],
  ]);
  expect(status.accounts[1]).toEqual({
    target: "codex:personal",
    provider: "codex",
    provider_name: "Codex",
    account: "personal",
    role: "current",
    activity: "running",
    availability: { status: "unknown", reason: null, retry_at: null, measured_at: null, source: null },
    usage: [],
  });
  expect(output).not.toContain('"total');

  const none = JSON.parse(renderJson(buildView(SCENARIOS["no-checkpoint"]!), NOW));
  expect(none).toMatchObject({ daemon: "not_running", checkpoint: null, job: { current_worker: null } });
});

test("in a project, standard output is exactly one JSON object and the exit code is 0; --job works from anywhere", async () => {
  const scratch = await setUpJob();
  scratches.push(scratch);
  const result = await relay(scratch, ["status", "--json"], { quiet: true });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  const status = JSON.parse(result.stdout);
  expect(status).toMatchObject({ schema: "relay.status/v1", daemon: "not_running", job: { id: jobId(scratch) }, checkpoint: { number: 1, kind: "baseline" } });

  const elsewhere = await relay(scratch, ["status", "--json", "--job", jobId(scratch)], { cwd: scratch.home, quiet: true });
  expect(elsewhere.code).toBe(0);
  expect(JSON.parse(elsewhere.stdout).job.id).toBe(jobId(scratch));
}, 30_000);

test("outside a project, or with an unknown --job, the exit code is 3; a wrong command line gives 2", async () => {
  const scratch = await setUpJob();
  scratches.push(scratch);
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  try {
    expect(await relay(scratch, ["status"], { cwd: outside, quiet: true })).toEqual({
      code: 3,
      stdout: "",
      stderr: "This folder is not in a relay project. Run relay init here, or pass --job <id>.\n",
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  expect(await relay(scratch, ["status", "--job", "ffffffff"], { quiet: true })).toEqual({
    code: 3,
    stdout: "",
    stderr: "No job with id ffffffff is in a project relay knows. Run relay status inside the project.\n",
  });
  expect((await relay(scratch, ["status", "--job", "nope"], { quiet: true })).code).toBe(2);
  expect((await relay(scratch, ["status", "extra"], { quiet: true })).code).toBe(2);
}, 30_000);
