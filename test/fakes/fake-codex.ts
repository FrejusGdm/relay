#!/usr/bin/env bun
/* This program imitates Codex 0.160.0 for tests, including its app server, exec output,
 * interactive sessions and trusted hooks. docs/testing-adapters.md describes how to
 * configure its scenarios and records without calling a real provider. */
import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { startRecord } from "./record";
import { listCommandHooks, runHooks } from "./run-hooks";
import { crashWith, loadScenario, ScenarioError, sleep, turnSteps, unixSeconds, windowName, writeStepFile } from "./scenario";
import type { FakeWindow, Scenario } from "./scenario";

const argv = process.argv.slice(2);
const recorder = startRecord(argv);
function fatal(message: string, code = 2): never {
  writeSync(2, message + "\n");
  process.exit(code);
}
let scenario: Scenario;
try { scenario = loadScenario(); }
catch (error) {
  if (error instanceof ScenarioError) fatal(`fake-codex: ${error.message}`);
  throw error;
}
const CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME ?? homedir(), ".codex");
const HOOKS_FILE = join(CODEX_HOME, "hooks.json");
const TRUSTED = scenario.hooks_trusted === true;
const TRUST_STATUS = scenario.hooks_trusted === "modified" ? "modified" : TRUSTED ? "trusted" : "untrusted";
const VERSION = scenario.tool_version ?? "0.160.0";
let ignoreSigterm = false;
function terminate() {
  if (ignoreSigterm) return;
  process.removeListener("SIGTERM", terminate);
  process.kill(process.pid, "SIGTERM");
}
process.on("SIGTERM", terminate);
const json = (value: unknown) => writeSync(1, JSON.stringify(value) + "\n");
const plain = (value: string) => writeSync(1, value + "\n");
type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}
async function* inputLines(): AsyncGenerator<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        yield line;
      }
      if (done) break;
    }
    if (pending !== "") yield pending.replace(/\r$/, "");
  } finally { reader.releaseLock(); }
}

interface Options { cd?: string; model?: string; prompt?: string; json: boolean }
function unexpected(arg: string): never { return fatal(`error: unexpected argument '${arg}' found`); }
function parseOptions(args: string[], mode: "interactive" | "exec" | "exec-resume"): Options {
  const options: Options = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const cd = arg === "-C" || arg === "--cd";
    const sandbox = arg === "-s" || arg === "--sandbox";
    const config = arg === "-c" || arg === "--config";
    const model = arg === "-m" || arg === "--model";
    if ((cd && mode !== "exec-resume") || (sandbox && mode === "exec") || config || model) {
      const value = args[++i];
      if (value === undefined) fatal(`error: a value is required for '${arg}' but none was supplied`);
      if (cd) options.cd = value;
      if (model) options.model = value;
      if (sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(value)) {
        fatal(`error: invalid value '${value}' for '--sandbox <SANDBOX_MODE>'`);
      }
    } else if (mode !== "interactive" && arg === "--json") options.json = true;
    else if (mode !== "interactive" && arg === "--ephemeral") continue;
    else if (mode === "exec" && arg === "--skip-git-repo-check") continue;
    else if (arg.startsWith("-") && arg !== "-") unexpected(arg);
    else if (options.prompt !== undefined) unexpected(arg);
    else options.prompt = arg;
  }
  return options;
}

interface Session { id: string; root: string; model: string; turnId: string | null; completed: number }
interface Turn { session: Session; id: string; controller: AbortController }
let active: Turn | null = null;
let shuttingDown = false;
async function hook(session: Session, event: string, source?: "startup" | "resume") {
  if (!TRUSTED) return;
  await runHooks(HOOKS_FILE, event, {
    session_id: session.id,
    transcript_path: join(CODEX_HOME, "sessions", "fake", `rollout-${session.id}.jsonl`),
    cwd: session.root, hook_event_name: event,
    turn_id: active?.session === session ? active.id : null, model: session.model,
    ...(source === undefined ? {} : { source }),
  }, { cwd: session.root, matchValue: source, defaultTimeoutSeconds: 60 });
}
// A pending promise alone does not keep an exec process alive when its input is ignored.
function wait(ms: number | null, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    const timer = ms === null ? setInterval(() => {}, 1000) : setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      clearInterval(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
const ERROR_MESSAGES = {
  authentication_failed: "unexpected status 401 Unauthorized",
  overloaded: "Selected model is at capacity. Please try a different model.",
  billing_error: "unexpected status 402 Payment Required",
  server_error: "unexpected status 500 Internal Server Error",
};
const ERROR_INFO = {
  authentication_failed: "unauthorized", overloaded: "serverOverloaded",
  billing_error: "other", server_error: "internalServerError",
};
function usageMessage(time: string): string {
  const reset = new Date(time);
  const now = new Date();
  const hours = reset.getHours();
  const clock = `${hours % 12 || 12}:${String(reset.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
  const today = reset.getFullYear() === now.getFullYear() && reset.getMonth() === now.getMonth() && reset.getDate() === now.getDate();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // As codex-rs/protocol/src/error.rs (format_retry_timestamp) writes another day: "Oct 9th, 2026 3:45 PM".
  const day = reset.getDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  const formatted = today ? clock : `${months[reset.getMonth()]} ${day}${suffix}, ${reset.getFullYear()} ${clock}`;
  return `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${formatted}.`;
}
const RATE_MESSAGE = "exceeded retry limit, last status: 429 Too Many Requests";
const EXEC_USAGE = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 0 };
const LAST_USAGE = { totalTokens: 1250, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 0 };
function window(value?: FakeWindow) {
  return value === undefined ? null : { usedPercent: value.used_percent, windowDurationMins: value.window_minutes, resetsAt: unixSeconds(value.resets_at) };
}
const snapshot = {
  primary: window(scenario.rate_limits?.primary), secondary: window(scenario.rate_limits?.secondary),
  credits: null, planType: "plus", rateLimitReachedType: scenario.rate_limits?.reached ?? null,
};
let allowed: boolean | null = scenario.rate_limits?.ordinary_usage_allowed === undefined ? true : scenario.rate_limits.ordinary_usage_allowed;
let itemCounter = 0;
let requestCounter = 0;
const approvals = new Map<number, (response: Json) => void>();
const notify = (method: string, params: unknown) => json({ method, params });
async function approvalAnswer(method: string, params: Json, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const id = requestCounter++;
  return new Promise((done) => {
    function finish(response?: Json) {
      approvals.delete(id);
      signal.removeEventListener("abort", abort);
      const decision = object(response?.result)?.decision;
      done(decision === "accept" || decision === "acceptForSession");
    }
    const abort = () => finish();
    approvals.set(id, finish);
    signal.addEventListener("abort", abort, { once: true });
    json({ id, method, params });
  });
}

async function runTurn(turn: Turn, index: number, mode: "app" | "exec" | "interactive"): Promise<"completed" | "failed" | "interrupted"> {
  const { session, id: turnId, controller } = turn;
  const signal = controller.signal;
  const base = { threadId: session.id, turnId };
  const itemEvent = (event: string, item: Json) => mode === "app" ? notify(`item/${event}`, { ...base, item }) : json({ type: `item.${event}`, item });
  let failure: { message: string; codexErrorInfo: string; additionalDetails: null } | null = null;
  for (const step of turnSteps(scenario, index)) {
    if (signal.aborted) break;
    if ("finish" in step) break;
    if ("hang" in step) await wait(null, signal);
    else if ("ignore_sigterm" in step) ignoreSigterm = true;
    else if ("crash" in step) { crashWith(step.crash.signal); await wait(null, signal); }
    else if ("exit" in step) process.exit(step.exit);
    else if ("stderr" in step) writeSync(2, step.stderr + "\n");
    else if ("raw" in step) writeSync(1, step.raw + "\n");
    else if ("say" in step) {
      if (mode === "interactive") plain(step.say);
      else if (mode === "exec") itemEvent("completed", { id: `item_${itemCounter++}`, type: "agent_message", text: step.say });
      else {
        const id = `msg_${++itemCounter}`;
        itemEvent("started", { type: "agentMessage", id, text: "" });
        notify("item/agentMessage/delta", { ...base, itemId: id, delta: step.say });
        itemEvent("completed", { type: "agentMessage", id, text: step.say });
      }
    } else if ("run" in step || "approval" in step) {
      const approval = "approval" in step;
      const command = "run" in step ? step.run : step.approval.command;
      const path = "approval" in step ? step.approval.path : undefined;
      const exitCode = "run" in step ? step.exit_code ?? 0 : 0;
      const delay = "run" in step ? step.delay_ms ?? 0 : 0;
      if (mode === "interactive") {
        if (approval) plain(`Approval needed: ${command ?? path}`);
        else { await wait(delay, signal); if (!signal.aborted) plain(`Ran ${command} (exit code ${exitCode})`); }
      } else if (mode === "exec") {
        const id = `item_${itemCounter++}`;
        if (path !== undefined) itemEvent("completed", { id, type: "file_change", changes: [{ path, kind: "add" }], status: "failed" });
        else {
          const item = { id, type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" };
          if (!approval) { itemEvent("started", item); await wait(delay, signal); }
          if (!signal.aborted) itemEvent("completed", { ...item, exit_code: approval ? null : exitCode, status: approval ? "declined" : exitCode === 0 ? "completed" : "failed" });
        }
      } else {
        const id = `${path === undefined ? "cmd" : "patch"}_${++itemCounter}`;
        const item: Json = path === undefined ? {
          type: "commandExecution", id, command, cwd: session.root, processId: null, status: "inProgress",
          commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        } : { type: "fileChange", id, changes: [{ path, kind: "add", diff: "" }], status: "inProgress" };
        itemEvent("started", item);
        let accepted = true;
        if (approval) accepted = await approvalAnswer(path === undefined ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval", {
          ...base, itemId: id, reason: null, ...(path === undefined ? { command, cwd: session.root } : { grantRoot: null }),
        }, signal);
        else await wait(delay, signal);
        if (!signal.aborted) itemEvent("completed", {
          ...item, status: !accepted ? "declined" : exitCode === 0 ? "completed" : "failed",
          ...(path === undefined && accepted ? { aggregatedOutput: "", exitCode, durationMs: delay } : {}),
        });
      }
    } else if ("write" in step) {
      const kind = writeStepFile(session.root, step.write, step.content).created ? "add" : "update";
      if (mode === "interactive") plain(`Edited ${step.write}`);
      else if (mode === "exec") itemEvent("completed", { id: `item_${itemCounter++}`, type: "file_change", changes: [{ path: step.write, kind }], status: "completed" });
      else {
        const item = { type: "fileChange", id: `patch_${++itemCounter}`, changes: [{ path: step.write, kind, diff: step.content.split("\n").map((line) => "+" + line).join("\n") }], status: "inProgress" };
        itemEvent("started", item);
        itemEvent("completed", { ...item, status: "completed" });
      }
    } else if ("limit" in step || "error" in step) {
      const rate = "limit" in step && step.limit.kind === "rate";
      failure = {
        message: "error" in step ? ERROR_MESSAGES[step.error] : rate ? RATE_MESSAGE : usageMessage(step.limit.resets_at),
        codexErrorInfo: "error" in step ? ERROR_INFO[step.error] : rate ? "rateLimitExceeded" : "usageLimitExceeded",
        additionalDetails: null,
      };
      if (mode === "app") {
        if ("limit" in step && !rate) {
          const name = windowName(step.limit.window) === "five_hour" ? "primary" : "secondary";
          snapshot[name] = { usedPercent: 100, windowDurationMins: snapshot[name]?.windowDurationMins ?? (name === "primary" ? 300 : 10080), resetsAt: unixSeconds(step.limit.resets_at) };
          allowed = false;
          notify("account/rateLimits/updated", { rateLimits: snapshot });
        }
        notify("error", { error: failure, willRetry: false, ...base });
      } else if (mode === "exec") {
        json({ type: "error", message: failure.message });
        json({ type: "turn.failed", error: { message: failure.message } });
      } else plain(failure.message);
      break;
    }
  }
  if (signal.aborted) {
    if (shuttingDown) return "interrupted";
    if (mode === "interactive") plain("Interrupted.");
    await hook(session, "Interrupt");
    if (active === turn) active = null;
    if (mode === "app") notify("turn/completed", { threadId: session.id, turn: { id: turnId, items: [], status: "interrupted", error: null } });
    return "interrupted";
  }
  if (failure === null) {
    if (mode === "exec") json({ type: "turn.completed", usage: EXEC_USAGE });
    if (mode === "app") {
      session.completed++;
      const total = Object.fromEntries(Object.entries(LAST_USAGE).map(([key, value]) => [key, value * session.completed]));
      notify("thread/tokenUsage/updated", { ...base, tokenUsage: { total, last: LAST_USAGE, modelContextWindow: 272000 } });
    }
  }
  await hook(session, "Stop");
  // The app server can receive an interrupt while a Stop hook is running.
  if (signal.aborted) {
    if (shuttingDown) return "interrupted";
    if (mode === "interactive") plain("Interrupted.");
    await hook(session, "Interrupt");
    if (active === turn) active = null;
    if (mode === "app") notify("turn/completed", { threadId: session.id, turn: { id: turnId, items: [], status: "interrupted", error: null } });
    return "interrupted";
  }
  if (active === turn) active = null;
  if (mode === "app") notify("turn/completed", { threadId: session.id, turn: { id: turnId, items: [], status: failure === null ? "completed" : "failed", error: failure } });
  return failure === null ? "completed" : "failed";
}
function beginTurn(session: Session, index: number): Turn {
  session.turnId = `turn_${index + 1}`;
  const turn = { session, id: session.turnId, controller: new AbortController() };
  active = turn;
  return turn;
}
function sessionFor(options: Options, resumeId?: string): Session {
  return { id: scenario.session_id ?? resumeId ?? randomUUID(), root: options.cd === undefined ? process.cwd() : resolve(process.cwd(), options.cd), model: options.model ?? "gpt-6.1-sol", turnId: null, completed: 0 };
}
async function execMode(options: Options, resumeId?: string) {
  process.on("SIGINT", () => { if (active) active.controller.abort(); else process.exit(1); });
  if (!options.json) fatal("fake-codex: exec supports only --json output.");
  let prompt = options.prompt;
  if (prompt === undefined || prompt === "-") {
    const lines: string[] = [];
    for await (const line of inputLines()) { recorder?.input(line); lines.push(line); }
    prompt = lines.join("\n");
  }
  if (prompt === "") fatal("No prompt provided.", 1);
  const session = sessionFor(options, resumeId);
  await sleep(scenario.startup_delay_ms ?? 0);
  json({ type: "thread.started", thread_id: session.id });
  await hook(session, "SessionStart", resumeId === undefined ? "startup" : "resume");
  json({ type: "turn.started" });
  const result = await runTurn(beginTurn(session, 0), 0, "exec");
  await hook(session, "SessionEnd");
  process.exit(result === "completed" ? 0 : 1);
}
async function interactiveMode(options: Options, resumeId?: string) {
  process.on("SIGINT", () => active?.controller.abort());
  const session = sessionFor(options, resumeId);
  const queue: string[] = options.prompt === undefined || options.prompt === "" ? [] : [options.prompt];
  let ended = false;
  let wake: (() => void) | undefined;
  const reading = (async () => {
    for await (const line of inputLines()) {
      recorder?.input(line);
      if (line !== "") queue.push(line);
      wake?.();
    }
    ended = true;
    wake?.();
  })();
  await sleep(scenario.startup_delay_ms ?? 0);
  plain(`Codex ${VERSION} (fake), session ${session.id}`);
  await hook(session, "SessionStart", resumeId === undefined ? "startup" : "resume");
  let index = 0;
  while (!ended || queue.length !== 0) {
    if (queue.length === 0) { await new Promise<void>((done) => { wake = done; }); wake = undefined; continue; }
    queue.shift();
    await runTurn(beginTurn(session, index), index++, "interactive");
  }
  await reading;
  await hook(session, "SessionEnd");
  process.exit(0);
}
async function appServer() {
  if (scenario.app_server === "exit_immediately") fatal("fake-codex: the app server stopped at start.");
  let initialized = false;
  let session: Session | null = null;
  let turns = 0;
  let handling = Promise.resolve();
  const ready = sleep(scenario.startup_delay_ms ?? 0);
  const reply = (id: unknown, result: unknown) => json({ id, result });
  const error = (id: unknown, code: number, message: string) => json({ id, error: { code, message } });
  async function handle(line: string) {
    await ready;
    if (scenario.app_server === "no_answer") return;
    let message: Json | null;
    try { message = object(JSON.parse(line)); } catch { message = null; }
    if (!message) { error(null, -32700, "Parse error"); return; }
    const id = message.id;
    if (typeof message.method !== "string") {
      if (typeof id === "number") approvals.get(id)?.(message);
      return;
    }
    if (!("id" in message)) return;
    const params = object(message.params) ?? {};
    const method = message.method;
    if (method === "initialize") {
      if (initialized) error(id, -32600, "Already initialized");
      else { reply(id, { userAgent: `codex_cli_rs/${VERSION}` }); initialized = true; }
      return;
    }
    if (!initialized) { error(id, -32600, "Not initialized"); return; }
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/start" && scenario.app_server === "method_not_found") { error(id, -32601, "Method not found"); return; }
      if (method === "thread/resume" && typeof params.threadId !== "string") { error(id, -32602, "Invalid params: threadId is required"); return; }
      session = { id: method === "thread/resume" ? params.threadId as string : scenario.session_id ?? randomUUID(), root: typeof params.cwd === "string" ? params.cwd : process.cwd(), model: typeof params.model === "string" ? params.model : "gpt-6.1-sol", turnId: null, completed: 0 };
      const now = Math.floor(Date.now() / 1000);
      const thread = { id: session.id, preview: "", modelProvider: "openai", createdAt: now, updatedAt: now, path: null, cwd: session.root, cliVersion: VERSION, source: "appServer", gitInfo: null, turns: [] };
      reply(id, { thread, model: session.model, modelProvider: "openai", cwd: session.root, approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: { type: params.sandbox === "read-only" ? "readOnly" : params.sandbox === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite" }, reasoningEffort: null });
      notify("thread/started", { thread });
      await hook(session, "SessionStart", method === "thread/resume" ? "resume" : "startup");
    } else if (method === "turn/start") {
      if (!session || params.threadId !== session.id) { error(id, -32600, `Thread not found: ${params.threadId}`); return; }
      if (active) { error(id, -32600, "A turn is already running on this thread."); return; }
      const index = turns++;
      const turn = beginTurn(session, index);
      const value = { id: turn.id, items: [], status: "inProgress", error: null };
      reply(id, { turn: value });
      notify("turn/started", { threadId: session.id, turn: value });
      void runTurn(turn, index, "app").catch(handleFailure);
    } else if (method === "turn/steer") {
      if (!active) error(id, -32600, "No active turn to steer.");
      else if (params.expectedTurnId !== active.id) error(id, -32600, `Expected turn ${params.expectedTurnId}, but the active turn is ${active.id}.`);
      else reply(id, { turnId: active.id });
    } else if (method === "turn/interrupt") {
      if (!active || params.turnId !== active.id) error(id, -32600, "No active turn to interrupt.");
      else { reply(id, {}); active.controller.abort(); }
    } else if (method === "account/rateLimits/read") {
      if (scenario.auth?.signed_in === false) error(id, -32600, "codex account authentication required to read rate limits");
      else reply(id, { rateLimits: snapshot, rateLimitsByLimitId: null, ordinaryUsageAllowed: allowed });
    } else if (method === "hooks/list") {
      const cwds = Array.isArray(params.cwds) ? params.cwds : [process.cwd()];
      reply(id, { data: cwds.map((cwd) => ({ cwd, hooks: listCommandHooks(HOOKS_FILE).map((entry) => ({ eventName: entry.event, matcher: entry.matcher, command: entry.command, timeout: entry.timeout, sourcePath: HOOKS_FILE, trustStatus: TRUST_STATUS })) })) });
    } else error(id, -32601, "Method not found");
  }
  for await (const line of inputLines()) {
    if (line === "") continue;
    recorder?.input(line);
    handling = handling.then(() => handle(line));
    void handling.catch(handleFailure);
  }
  // End of input stops the server without waiting for an unfinished turn.
  shuttingDown = true;
  active?.controller.abort();
  if (session) await hook(session, "SessionEnd");
  process.exit(0);
}
function handleFailure(error: unknown): never {
  if (error instanceof ScenarioError) fatal(`fake-codex: ${error.message}`);
  throw error;
}
async function main() {
  const first = argv[0];
  if (first === "--version" || first === "-V") { plain(`codex-cli ${VERSION}`); process.exit(0); }
  if (first === "login") {
    if (argv[1] === undefined) {
      if (scenario.login?.succeed ?? true) { plain("Successfully logged in"); process.exit(0); }
      fatal("Error logging in", 1);
    }
    if (argv[1] !== "status") unexpected(argv[1]);
    if (argv[2] !== undefined) unexpected(argv[2]);
    if (!(scenario.auth?.signed_in ?? true)) { plain("Not logged in"); process.exit(1); }
    const method = scenario.auth?.method ?? "ChatGPT";
    plain(method === "API key" ? "Logged in using an API key" : `Logged in using ${method}`);
    process.exit(0);
  }
  if (first === "app-server") {
    if (argv[1] !== undefined) unexpected(argv[1]);
    await appServer();
    return;
  }
  const exec = first === "exec";
  const offset = exec ? 1 : 0;
  const resume = argv[offset] === "resume";
  const resumeId = resume ? argv[offset + 1] : undefined;
  if (resume && (resumeId === undefined || resumeId.startsWith("-"))) fatal("error: a value is required for '<SESSION_ID>' but none was supplied");
  const options = parseOptions(argv.slice(offset + (resume ? 2 : 0)), exec ? resume ? "exec-resume" : "exec" : "interactive");
  if (exec) await execMode(options, resumeId);
  else await interactiveMode(options, resumeId);
}
await main().catch(handleFailure);
