#!/usr/bin/env bun
// This program imitates Claude Code 2.1.282 for tests, so adapters can exercise its command lines,
// output, signals and hooks without contacting a provider. docs/testing-adapters.md describes the
// scenario format and how tests use it.
import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { startRecord } from "./record";
import { crashWith, loadScenario, ScenarioError, sleep, turnSteps, unixSeconds, windowName, writeStepFile } from "./scenario";
import type { Scenario } from "./scenario";
import { runHooks, runStatusLine } from "./run-hooks";

const argv = process.argv.slice(2);
const recorder = startRecord(argv);
function fail(message: string, code = 1): never {
  writeSync(2, message + "\n");
  process.exit(code);
}
let scenario: Scenario;
try {
  scenario = loadScenario();
} catch (error) {
  if (error instanceof ScenarioError) fail(`fake-claude: ${error.message}`, 2);
  throw error;
}
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? homedir(), ".claude");
const SETTINGS = join(CONFIG_DIR, "settings.json");
const VERSION = scenario.tool_version ?? "2.1.282";
const plain = (text: string) => writeSync(1, text + "\n");
const json = (value: Record<string, unknown>) => writeSync(1, JSON.stringify(value) + "\n");
if (argv.includes("--version")) {
  plain(`${VERSION} (Claude Code)`);
  process.exit(0);
}
if (argv[0] === "auth") {
  if (argv[1] === "status") {
    const signedIn = scenario.auth?.signed_in ?? true;
    plain(JSON.stringify(signedIn
      ? { loggedIn: true, authMethod: scenario.auth?.method ?? "claude.ai", email: "fake.user@example.com", configDirectory: CONFIG_DIR }
      : { loggedIn: false, authMethod: "none", configDirectory: CONFIG_DIR }, null, 2));
    process.exit(signedIn ? 0 : 1);
  }
  if (argv[1] === "login") {
    if (!(scenario.login?.succeed ?? true)) fail("Login failed.");
    plain("Login successful.");
    process.exit(0);
  }
  fail(`error: unknown command '${argv[1] ?? ""}'`);
}
// The commands and aliases that claude --help lists in Claude Code 2.1.282, and Commander's help.
const COMMANDS = new Set(["agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
  "plugin", "plugins", "project", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade", "help"]);
const valueOptions = new Set(["--input-format", "--output-format", "--session-id", "--resume", "-r", "--permission-mode", "--permission-prompts", "--append-system-prompt", "--model"]);
const booleanOptions = new Set(["-p", "--print", "--verbose"]);
const flags = new Map<string, string>();
const switches = new Set<string>();
const prompts: string[] = [];
let unknown: string | undefined;
let missing: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  // As in Commander, the parser Claude Code uses, every argument after "--" is an operand, and a
  // long option can carry its value after "=".
  if (arg === "--") {
    prompts.push(...argv.slice(i + 1));
    break;
  }
  const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
  if (equals > 0 && valueOptions.has(arg.slice(0, equals))) flags.set(arg.slice(0, equals), arg.slice(equals + 1));
  else if (valueOptions.has(arg)) {
    const value = argv[++i];
    if (value === undefined) missing ??= arg;
    else flags.set(arg === "-r" ? "--resume" : arg, value);
  } else if (booleanOptions.has(arg)) switches.add(arg);
  else if (arg.startsWith("-")) unknown ??= arg;
  else prompts.push(arg);
}
// Commander runs a subcommand whose name equals the first operand, even one given after "--".
if (prompts[0] !== undefined && COMMANDS.has(prompts[0])) fail(`fake-claude: ran the ${prompts[0]} command, because the first operand names it.`);
if (unknown !== undefined) fail(`error: unknown option '${unknown}'`);
if (missing !== undefined) fail(`error: option '${missing}' argument missing`);
if (prompts.length > 1) fail("error: too many arguments");
const sessionIdFlag = flags.get("--session-id");
const resumeFlag = flags.get("--resume");
if (sessionIdFlag !== undefined && resumeFlag !== undefined) fail("Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.");
if (sessionIdFlag !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionIdFlag)) fail("Error: Invalid session ID. Must be a valid UUID.");
const headless = switches.has("-p") || switches.has("--print");
if (!headless && (flags.has("--input-format") || flags.has("--output-format") || switches.has("--verbose"))) fail("fake-claude: --input-format, --output-format and --verbose need -p.");
if (headless && (flags.get("--output-format") !== "stream-json" || (flags.has("--input-format") && flags.get("--input-format") !== "stream-json"))) fail("fake-claude: with -p only --input-format stream-json and --output-format stream-json are supported.");
if (headless && !switches.has("--verbose")) fail("Error: When using --print, --output-format=stream-json requires --verbose");
const SESSION_ID = scenario.session_id ?? sessionIdFlag ?? resumeFlag ?? randomUUID();
const MODEL = flags.get("--model") ?? "claude-sonnet-4-6";
const PERMISSION_MODE = flags.get("--permission-mode") ?? "default";
const CWD = process.cwd();
const TRANSCRIPT = join(CONFIG_DIR, "projects", CWD.replace(/[^A-Za-z0-9]/g, "-"), SESSION_ID + ".jsonl");
const common = (event: string) => ({ session_id: SESSION_ID, transcript_path: TRANSCRIPT, cwd: CWD, permission_mode: PERMISSION_MODE, hook_event_name: event });
async function hook(event: string, extra: Record<string, unknown>, matchValue?: string) {
  await runHooks(SETTINGS, event, { ...common(event), ...extra }, { cwd: CWD, matchValue, defaultTimeoutSeconds: 60 });
}
let active: AbortController | null = null;
let ignoreSigterm = false;
process.on("SIGINT", () => active?.abort());
process.on("SIGTERM", () => { if (!ignoreSigterm) process.exit(143); });

// A referenced timer keeps a hung turn alive even after standard input has closed.
function wait(signal: AbortSignal, ms?: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    const timer = ms === undefined ? setInterval(() => {}, 60_000) : setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      clearInterval(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
const queue = [...prompts];
let inputEnded = false;
let wake: (() => void) | undefined;
let partial = "";
function inputText(line: string): string {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const user = value as Record<string, unknown>;
    const message = user.message;
    if (user.type !== "user" || typeof message !== "object" || message === null || Array.isArray(message)) throw new Error();
    const body = message as Record<string, unknown>;
    if (body.role !== "user") throw new Error();
    if (typeof body.content === "string") return body.content;
    if (!Array.isArray(body.content)) throw new Error();
    return body.content.flatMap((block: unknown) => {
      if (typeof block !== "object" || block === null || Array.isArray(block)) throw new Error();
      const item = block as Record<string, unknown>;
      if (item.type !== "text") return [];
      if (typeof item.text !== "string") throw new Error();
      return [item.text];
    }).join("");
  } catch {
    fail("Error: fake-claude could not read the input line.");
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  partial += chunk;
  let newline: number;
  while ((newline = partial.indexOf("\n")) !== -1) {
    const line = partial.slice(0, newline);
    partial = partial.slice(newline + 1);
    if (line === "") continue;
    recorder?.input(line);
    if (!headless) queue.push(line);
    else if (flags.has("--input-format")) queue.push(inputText(line));
    wake?.();
  }
});
process.stdin.on("end", () => { inputEnded = true; wake?.(); });
let initialized = false;
let messageCount = 0;
let toolCount = 0;
let lastResultError = false;
function assistant(block: Record<string, unknown>, error?: string) {
  json({ type: "assistant", message: { id: `msg_fake_${String(++messageCount).padStart(4, "0")}`, type: "message", role: "assistant", model: MODEL, content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } }, parent_tool_use_id: null, session_id: SESSION_ID, uuid: randomUUID(), ...(error === undefined ? {} : { error }) });
}
function user(content: Record<string, unknown>[]) {
  json({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: SESSION_ID, uuid: randomUUID() });
}
const errors = {
  authentication_failed: ["Invalid API key · Please run /login", "401 Unauthorized"],
  overloaded: ["API Error: Repeated 529 Overloaded errors", "529 Overloaded"],
  billing_error: ["Credit balance is too low", "400 Bad Request"],
  server_error: ["API Error: 500 Internal server error", "500 Internal Server Error"],
} as const;
function limitText(time: string, weekly: boolean): string {
  const date = new Date(time);
  const hour = date.getHours();
  const clock = `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]!;
  return weekly ? `You've hit your weekly limit · resets ${day} ${clock}` : `You've hit your session limit · resets ${clock}`;
}
async function turn(index: number) {
  const controller = new AbortController();
  active = controller;
  const signal = controller.signal;
  let lastSay = "";
  let uses = 0;
  const denials: Record<string, unknown>[] = [];
  function result(error: boolean, text?: string, interrupted = false) {
    lastResultError = error;
    if (!headless) return;
    json({ type: "result", subtype: interrupted ? "error_during_execution" : "success", is_error: error, duration_ms: 1000, duration_api_ms: 800, num_turns: 1 + uses, ...(interrupted ? {} : { result: text ?? lastSay }), session_id: SESSION_ID, total_cost_usd: error ? 0 : 0.01, usage: { input_tokens: error ? 0 : 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: error ? 0 : 200, output_tokens: error ? 0 : 50 }, permission_denials: denials, uuid: randomUUID() });
  }
  function tool(name: string, input: Record<string, unknown>): string {
    uses++;
    const id = `toolu_fake_${String(++toolCount).padStart(4, "0")}`;
    if (headless) assistant({ type: "tool_use", id, name, input });
    return id;
  }
  function toolResult(id: string, text: string, error: boolean) {
    if (headless) user([{ tool_use_id: id, type: "tool_result", content: text, is_error: error }]);
  }
  async function failure(error: string, text: string, details: string) {
    active = null;
    if (headless) assistant({ type: "text", text }, error);
    else plain(text);
    result(true, text);
    await hook("StopFailure", { error, error_details: details, last_assistant_message: text }, error);
  }
  if (headless && !initialized) {
    initialized = true;
    json({ type: "system", subtype: "init", cwd: CWD, session_id: SESSION_ID, tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"], mcp_servers: [], model: MODEL, permissionMode: PERMISSION_MODE, slash_commands: [], apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none", claude_code_version: VERSION, output_style: "default", capabilities: [], uuid: randomUUID() });
  }
  for (const step of turnSteps(scenario, index)) {
    if (signal.aborted) break;
    if ("say" in step) {
      lastSay = step.say;
      if (headless) assistant({ type: "text", text: step.say }); else plain(step.say);
    } else if ("run" in step) {
      const id = tool("Bash", { command: step.run });
      await wait(signal, step.delay_ms ?? 0);
      if (signal.aborted) break;
      const code = step.exit_code ?? 0;
      if (headless) toolResult(id, code === 0 ? "" : `Exit code ${code}`, code !== 0);
      else plain(`Ran ${step.run} (exit code ${code})`);
    } else if ("write" in step) {
      const absolute = resolve(CWD, step.write);
      const id = tool("Write", { file_path: absolute, content: step.content });
      try {
        const written = writeStepFile(CWD, step.write, step.content);
        if (headless) toolResult(id, written.created ? `File created successfully at: ${absolute}` : `The file ${absolute} has been updated successfully.`, false);
        else plain(`Wrote ${step.write}`);
      } catch (error) {
        if (error instanceof ScenarioError) fail(`fake-claude: ${error.message}`, 2);
        throw error;
      }
    } else if ("approval" in step) {
      const command = step.approval.command;
      const name = command !== undefined ? "Bash" : "Write";
      const input = command !== undefined ? { command } : { file_path: resolve(CWD, step.approval.path!), content: "" };
      if (headless) {
        const id = tool(name, input);
        toolResult(id, `Claude requested permissions to use ${name}, but you haven't granted it yet.`, true);
        denials.push({ tool_name: name, tool_use_id: id, tool_input: input });
      } else {
        await hook("Notification", { message: `Claude needs your permission to use ${name}`, notification_type: "permission_prompt" }, "permission_prompt");
        if (signal.aborted) break;
        plain(`Permission needed for ${name}: ${command ?? step.approval.path}`);
      }
    } else if ("limit" in step) {
      const usage = step.limit.kind !== "rate";
      const name = windowName(step.limit.window);
      if (headless && usage) json({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: unixSeconds(step.limit.resets_at), rate_limit_type: name, utilization: 1 }, session_id: SESSION_ID, uuid: randomUUID() });
      await failure("rate_limit", usage ? limitText(step.limit.resets_at, name === "seven_day") : "API Error: Rate limit reached", "429 Too Many Requests");
      return;
    } else if ("error" in step) {
      const [text, details] = errors[step.error];
      await failure(step.error, text, details);
      return;
    } else if ("crash" in step) {
      crashWith(step.crash.signal);
      await new Promise<never>(() => { setInterval(() => {}, 60_000); });
    } else if ("exit" in step) process.exit(step.exit);
    else if ("hang" in step) await wait(signal);
    else if ("finish" in step) break;
    else if ("stderr" in step) writeSync(2, step.stderr + "\n");
    else if ("raw" in step) writeSync(1, step.raw + "\n");
    else if ("ignore_sigterm" in step) ignoreSigterm = true;
    else if ("notification" in step) await hook("Notification", { message: step.notification, notification_type: step.notification }, step.notification);
    else if ("status_line" in step && !headless) {
      const limits: Record<string, unknown> = {};
      for (const name of ["five_hour", "seven_day"] as const) {
        const percent = step.status_line[name];
        if (percent !== undefined) limits[name] = { used_percentage: percent, ...(step.status_line.resets_at === undefined ? {} : { resets_at: unixSeconds(step.status_line.resets_at) }) };
      }
      await runStatusLine(SETTINGS, { hook_event_name: "Status", session_id: SESSION_ID, transcript_path: TRANSCRIPT, cwd: CWD, model: { id: MODEL, display_name: MODEL }, workspace: { current_dir: CWD, project_dir: CWD }, version: VERSION, output_style: { name: "default" }, cost: { total_cost_usd: 0.01, total_duration_ms: 1000, total_api_duration_ms: 800, total_lines_added: 0, total_lines_removed: 0 }, rate_limits: limits }, CWD);
    }
  }
  active = null;
  if (signal.aborted) {
    if (headless) user([{ type: "text", text: "[Request interrupted by user]" }]);
    else plain("Interrupted.");
    result(true, undefined, true);
    return;
  }
  result(false);
  await hook("Stop", { stop_hook_active: false, last_assistant_message: lastSay });
}
await sleep(scenario.startup_delay_ms ?? 0);
const source = resumeFlag !== undefined ? "resume" : "startup";
await hook("SessionStart", { source, model: MODEL }, source);
if (!headless) plain(`Claude Code ${VERSION} (fake), session ${SESSION_ID}`);
let turnNumber = 0;
while (true) {
  if (queue.length > 0) {
    queue.shift();
    await turn(turnNumber++);
  } else if (inputEnded) break;
  else await new Promise<void>((done) => { wake = done; });
  wake = undefined;
}
const reason = headless ? "other" : "prompt_input_exit";
await hook("SessionEnd", { reason }, reason);
process.exit(headless && lastResultError ? 1 : 0);
