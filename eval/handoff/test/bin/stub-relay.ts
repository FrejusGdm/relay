// The stub relay of the harness's tests. It implements the commands and JSON outputs listed in
// add-handoff-evaluation design decision 2, writes .relay/ job files, events and checkpoint
// commits under refs/relay/ like relay does, and plays the agents' work from a scenario file
// instead of starting an agent. It never starts claude or codex.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { git } from "../../src/git.ts";

type StubStep =
  | { write: string; content: string }
  | { append: string; content: string }
  | { copy: string; to: string }
  | { delete: string }
  | { run: string[] }
  | { verify: string };

export interface StubWorker {
  argv?: string[];
  model?: string;
  step_delay_ms?: number;
  steps: StubStep[];
  usage?: Record<string, number | null>;
  cost_usd_estimate?: number | null;
  end: "exited" | "usage_limit" | "rate_limit" | "failed" | "hang";
  retry_at?: string;
}

export interface StubScenario {
  workers: Record<string, StubWorker>;
  switch?: { exit_code?: number; error?: string; claims_count?: number; mismatches?: { claim: string; found: string }[] };
  status?: Record<string, { status: string; retry_at?: string | null; used_percent?: number | null }>;
}

interface CheckpointRecord {
  number: number;
  commit: string;
  ref: string;
  kind: string;
  message: string | null;
  created_at: string;
  head: string | null;
  left_out: string[];
  content_tree: string;
}

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const relayHome = process.env.RELAY_HOME || fail(2, "The stub relay needs RELAY_HOME.");
const root = process.cwd();
const relayDir = join(root, ".relay");
const JOB_FILES = ["task.md", "state.json", "checkpoint.md", "decisions.md", "events.jsonl", "verify.md"];

function scenario(): StubScenario {
  const path = process.env.RELAY_STUB_SCENARIO;
  if (!path) return { workers: {} };
  return JSON.parse(readFileSync(path, "utf8")) as StubScenario;
}

function jobId(): string {
  if (!existsSync(join(relayDir, "state.json"))) fail(3, "relay is not set up here. Run relay init first.");
  return (JSON.parse(readFileSync(join(relayDir, "state.json"), "utf8")) as { job_id: string }).job_id;
}

function jobDir(job: string): string {
  return join(relayHome, "jobs", job);
}

function randomId(): string {
  return crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16).padStart(8, "0");
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

let printEvents = false;
function appendEvent(job: string, type: string, data: Record<string, unknown>): void {
  const path = join(relayDir, "events.jsonl");
  const id = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length + 1;
  const line = JSON.stringify({ v: 1, id, ts: new Date().toISOString(), job, type, actor: "relay", data });
  appendFileSync(path, `${line}\n`);
  if (printEvents) process.stdout.write(`${line}\n`);
}

function checkpointList(job: string): CheckpointRecord[] {
  const path = join(jobDir(job), "checkpoints.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as CheckpointRecord[] : [];
}

// Builds the tree with a temporary index, like relay, so the person's index never changes.
async function writeTree(job: string, withJobFiles: boolean): Promise<string> {
  const index = join(jobDir(job), "checkpoint.index");
  mkdirSync(jobDir(job), { recursive: true });
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(root, ["add", "-A"], { env });
    const files = JOB_FILES.filter((name) => existsSync(join(relayDir, name))).map((name) => `.relay/${name}`);
    if (withJobFiles && files.length > 0) await git(root, ["add", "-f", "--", ...files], { env });
    return (await git(root, ["write-tree"], { env })).stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

async function saveCheckpoint(job: string, kind: string, message: string | null):
  Promise<{ saved: true; record: CheckpointRecord; files_changed: number } | { saved: false; latest: number }> {
  const list = checkpointList(job);
  const latest = list.at(-1);
  const contentTree = await writeTree(job, false);
  if (latest && latest.content_tree === contentTree && kind !== "handoff") return { saved: false, latest: latest.number };
  const number = (latest?.number ?? 0) + 1;
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true })).stdout.trim() || null;
  const parent = latest?.commit ?? head;
  const filesChanged = latest
    ? (await git(root, ["diff-tree", "-r", "--name-only", latest.content_tree, contentTree])).stdout.split("\n").filter(Boolean).length
    : 0;
  const tree = await writeTree(job, true);
  const commit = (await git(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `relay checkpoint ${number}${message ? `: ${message}` : ""}`])).stdout.trim();
  const ref = `refs/relay/jobs/${job}/checkpoints/${number}`;
  await git(root, ["update-ref", ref, commit]);
  await git(root, ["update-ref", `refs/relay/jobs/${job}/latest`, commit]);
  const record = { number, commit, ref, kind, message, created_at: new Date().toISOString(), head, left_out: [], content_tree: contentTree };
  writeAtomically(join(jobDir(job), "checkpoints.json"), JSON.stringify([...list, record], null, 2));
  appendEvent(job, "checkpoint_saved", { number, commit, kind, message, parent, head, branch: "main", files_changed: filesChanged, left_out: [] });
  return { saved: true, record, files_changed: filesChanged };
}

function option(args: string[], ...names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  return index === -1 ? undefined : args[index + 1];
}

async function init(args: string[]): Promise<void> {
  if (existsSync(relayDir)) fail(3, "relay init: this repository already has a job.");
  const job = randomId();
  mkdirSync(relayDir);
  writeFileSync(join(relayDir, "task.md"), "# Task\n\nDescribe the task here.\n");
  writeFileSync(join(relayDir, "state.json"), `${JSON.stringify({ job_id: job, title: option(args, "--title") ?? null }, null, 2)}\n`);
  writeFileSync(join(relayDir, "checkpoint.md"), "No handoff yet.\n");
  writeFileSync(join(relayDir, "decisions.md"), "# Decisions\n");
  writeFileSync(join(relayDir, "events.jsonl"), "");
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  appendFileSync(join(root, ".git", "info", "exclude"), "\n# relay: job files stay local\n/.relay/\n");
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true })).stdout.trim() || null;
  appendEvent(job, "job_started", { title: option(args, "--title") ?? null, worktree_root: root, head, branch: "main", detached: false, linked_worktree: false });
  await saveCheckpoint(job, "baseline", null);
  process.stdout.write(`Started job ${job}.\n`);
}

async function checkpoint(args: string[]): Promise<void> {
  const job = jobId();
  const result = await saveCheckpoint(job, "manual", option(args, "-m", "--message") ?? null);
  if (!args.includes("--json")) {
    process.stdout.write(result.saved ? `Saved checkpoint ${result.record.number}.\n` : "Nothing changed since the last checkpoint.\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(result.saved
    ? { saved: true, number: result.record.number, commit: result.record.commit, ref: result.record.ref, files_changed: result.files_changed, left_out: [] }
    : { saved: false, latest: result.latest })}\n`);
}

function checkpoints(): void {
  const list = checkpointList(jobId()).reverse().map(({ content_tree: _tree, ...record }) => record);
  process.stdout.write(`${JSON.stringify(list)}\n`);
}

function status(): void {
  const stub = scenario();
  const targets = [...new Set([...Object.keys(stub.workers), ...Object.keys(stub.status ?? {})])];
  const accounts = targets.map((target) => {
    const state = stub.status?.[target];
    return {
      target,
      availability: { status: state?.status ?? "available", retry_at: state?.retry_at ?? null },
      usage: state?.used_percent === undefined || state.used_percent === null ? [] : [{ window: "five_hour", used_percent: state.used_percent }],
    };
  });
  process.stdout.write(`${JSON.stringify({ accounts })}\n`);
}

function switchDir(job: string): string {
  return join(jobDir(job), "stub-switch");
}

// relay switch hands the request to the relay run that supervises the job and waits for its
// answer, as relay does on a headless job.
async function switchCommand(args: string[]): Promise<void> {
  const target = args[0];
  if (!target || target.startsWith("-")) fail(2, "Usage: relay switch <target> --yes --json");
  if (!args.includes("--yes")) fail(7, "relay switch needs --yes when it cannot ask.");
  const dir = switchDir(jobId());
  rmSync(join(dir, "response.json"), { force: true });
  writeAtomically(join(dir, "request.json"), JSON.stringify({ target }));
  const deadline = Date.now() + 10000;
  while (!existsSync(join(dir, "response.json"))) {
    if (Date.now() > deadline) {
      rmSync(join(dir, "request.json"), { force: true });
      fail(1, "relay run did not take the switch request.");
    }
    await Bun.sleep(20);
  }
  const response = JSON.parse(readFileSync(join(dir, "response.json"), "utf8")) as { exit_code: number; error?: string; json?: unknown };
  rmSync(join(dir, "response.json"), { force: true });
  if (response.exit_code !== 0) fail(response.exit_code, response.error ?? "relay switch failed.");
  process.stdout.write(`${JSON.stringify(response.json)}\n`);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

async function performStep(job: string, workerId: string, step: StubStep): Promise<void> {
  if ("run" in step) {
    const child = Bun.spawn(step.run, { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const exitCode = await child.exited;
    appendEvent(job, "command_ran", { worker_id: workerId, command: step.run.join(" "), exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed" });
    return;
  }
  let paths: string[];
  if ("write" in step || "append" in step) {
    const path = "write" in step ? step.write : step.append;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if ("write" in step) writeFileSync(join(root, path), step.content);
    else appendFileSync(join(root, path), step.content);
    paths = [path];
  } else if ("copy" in step) {
    if (statSync(step.copy).isDirectory()) {
      cpSync(step.copy, join(root, step.to), { recursive: true, force: true });
      paths = listFiles(step.copy).map((path) => join(step.to, path).replace(/^\.\//, ""));
    } else {
      mkdirSync(dirname(join(root, step.to)), { recursive: true });
      cpSync(step.copy, join(root, step.to));
      paths = [step.to];
    }
  } else if ("delete" in step) {
    rmSync(join(root, step.delete), { force: true });
    paths = [step.delete];
  } else {
    writeFileSync(join(relayDir, "verify.md"), step.verify);
    paths = [".relay/verify.md"];
  }
  appendEvent(job, "file_changed", { worker_id: workerId, paths });
}

async function run(args: string[]): Promise<void> {
  let target = args[0];
  if (!target || target.startsWith("-") || !args.includes("--headless")) fail(2, "Usage: relay run <target> --headless --prompt <text> --json");
  printEvents = args.includes("--json");
  const job = jobId();
  const stub = scenario();
  const requestPath = join(switchDir(job), "request.json");
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
  });

  async function wait(ms: number): Promise<"interrupt" | "switch" | null> {
    const end = Date.now() + ms;
    while (true) {
      if (interrupts > 0) return "interrupt";
      if (existsSync(requestPath)) return "switch";
      if (Date.now() >= end) return null;
      await Bun.sleep(Math.min(20, end - Date.now()));
    }
  }

  let fromHandoff: number | null = null;
  let workerId = randomId();
  const startWorker = (account: string) => {
    const spec = stub.workers[account] ?? fail(3, `The stub has no scenario for ${account}.`);
    const provider = account.split(":")[0]!;
    const argv = spec.argv ?? (provider === "codex"
      ? ["codex", "app-server", "--sandbox", "workspace-write", "--ask-for-approval", "never"]
      : ["claude", "-p", "<prompt>", "--permission-mode", "acceptEdits", "--permission-prompts", "none"]);
    appendEvent(job, "worker_started", {
      worker_id: workerId, target: account, provider, mode: "headless", transport: "stub", provider_version: "0.0.0",
      permission: "default", pid: process.pid, provider_session_id: null, argv, resumed_from: null,
      from_handoff: fromHandoff, start_checkpoint: checkpointList(job).at(-1)?.number ?? null,
    });
    appendEvent(job, "worker_session_identified", { worker_id: workerId, provider_session_id: `stub-${workerId}`, model: spec.model ?? "stub-model", source: "stub" });
    return { spec, started: Date.now() };
  };
  let worker = startWorker(target);
  let stepIndex = 0;

  const end = (fields: { exit_code: number | null; signal: string | null; end_reason: string }) => {
    appendEvent(job, "worker_ended", { worker_id: workerId, ...fields, stop_how: null, seconds: Math.round((Date.now() - worker.started) / 1000) });
  };

  async function handleSwitch(): Promise<void> {
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as { target: string };
    rmSync(requestPath, { force: true });
    const respond = (response: unknown) => writeAtomically(join(switchDir(job), "response.json"), JSON.stringify(response));
    const settings = stub.switch ?? {};
    const handoffsDir = join(jobDir(job), "handoffs");
    const number = (existsSync(handoffsDir) ? readdirSync(handoffsDir).length : 0) + 1;
    if ((settings.exit_code ?? 0) !== 0) {
      appendEvent(job, "handoff_failed", { number, to_target: request.target, step: "start", reason: settings.error ?? "stub failure", exit_code: settings.exit_code, kept_checkpoint: null });
      respond({ exit_code: settings.exit_code, error: settings.error ?? "relay could not start the next agent." });
      return;
    }
    end({ exit_code: 0, signal: null, end_reason: "stopped_by_switch" });
    writeFileSync(join(relayDir, "checkpoint.md"), `# Handoff ${number}\n\nThe previous agent worked on the task in .relay/task.md.\n`);
    rmSync(join(relayDir, "verify.md"), { force: true });
    const saved = await saveCheckpoint(job, "handoff", `handoff ${number}`);
    if (!saved.saved) fail(1, "The stub could not save the handoff checkpoint.");
    const promptPath = join(jobDir(job), "handoffs", String(number), "prompt.md");
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, "Continue the job. Read .relay/task.md and .relay/checkpoint.md first, then check the previous agent's claims in .relay/verify.md.\n");
    const fromWorker = workerId;
    workerId = randomId();
    appendEvent(job, "handoff", {
      number, from_worker_id: fromWorker, from_target: target, to_target: request.target, to_worker_id: workerId,
      checkpoint_number: saved.record.number, checkpoint_commit: saved.record.commit, handoff_ref: null,
      notes_source: "agent", notes_reason: null, tiers: [0, 1], claims_count: settings.claims_count ?? 0,
      mismatches: settings.mismatches ?? [], checks: [], instruction_files_changed: false, confirmations: [],
      invisible_removed: 0, prompt_path: promptPath,
    });
    target = request.target;
    fromHandoff = number;
    worker = startWorker(target);
    stepIndex = 0;
    respond({
      exit_code: 0,
      json: {
        handoff_id: number, checkpoint_sha: saved.record.commit, prompt_path: promptPath, to_worker_id: workerId,
        outcome: "started", notes_source: "agent", mismatches: (settings.mismatches ?? []).length,
      },
    });
  }

  while (true) {
    const { spec } = worker;
    const delay = spec.step_delay_ms ?? 100;
    const signal = await wait(stepIndex < spec.steps.length || spec.end === "hang" ? delay : 0);
    if (signal === "interrupt") {
      end({ exit_code: null, signal: "SIGINT", end_reason: "interrupted" });
      process.exit(130);
    }
    if (signal === "switch") {
      await handleSwitch();
      continue;
    }
    const step = spec.steps[stepIndex];
    if (step !== undefined) {
      stepIndex++;
      await performStep(job, workerId, step);
      continue;
    }
    if (spec.end === "hang") continue;
    if (spec.end === "exited") {
      appendEvent(job, "turn_completed", { worker_id: workerId, duration_ms: Date.now() - worker.started, usage: spec.usage ?? null, cost_usd_estimate: spec.cost_usd_estimate ?? null });
      end({ exit_code: 0, signal: null, end_reason: "exited" });
      process.exit(0);
    }
    const reason = spec.end === "failed" ? "crashed" : spec.end;
    appendEvent(job, "turn_failed", { worker_id: workerId, reason, retry_at: spec.retry_at ?? null, source: "stub" });
    end({ exit_code: 1, signal: null, end_reason: "exited" });
    process.exit(spec.end === "failed" ? 24 : 23);
  }
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "--version":
    process.stdout.write("relay 0.0.0-stub\n");
    break;
  case "init":
    await init(args);
    break;
  case "checkpoint":
    await checkpoint(args);
    break;
  case "checkpoints":
    checkpoints();
    break;
  case "status":
    status();
    break;
  case "switch":
    await switchCommand(args);
    break;
  case "run":
    await run(args);
    break;
  default:
    fail(2, `The stub relay does not know ${command ?? "an empty command"}.`);
}
