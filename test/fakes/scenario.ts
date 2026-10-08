// The scenario format that fake-claude, fake-codex and the in-process fake adapter follow
// (add-provider-adapters, design decision 17). docs/testing-adapters.md describes every field.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

export interface Scenario {
  version: 1;
  tool_version?: string;              // what --version prints; the default is the tested version
  startup_delay_ms?: number;
  session_id?: string;
  auth?: { signed_in: boolean; method?: string };
  login?: { succeed: boolean };
  rate_limits?: { primary?: FakeWindow; secondary?: FakeWindow; reached?: string | null; ordinary_usage_allowed?: boolean | null };
  hooks_trusted?: boolean | "modified";   // "modified": changed since the person trusted them
  app_server?: "ok" | "exit_immediately" | "no_answer" | "method_not_found";
  turns: { steps: Step[] }[];
}
export interface FakeWindow { used_percent: number; window_minutes: number; resets_at: string }
export type Step =
  | { say: string } | { run: string; exit_code?: number; delay_ms?: number }
  | { write: string; content: string }
  | { limit: { window: "primary" | "secondary" | "five_hour" | "seven_day"; resets_at: string; kind?: "usage" | "rate" } }
  | { error: "authentication_failed" | "overloaded" | "billing_error" | "server_error" }
  | { crash: { signal: "SIGKILL" | "SIGSEGV" } } | { exit: number } | { hang: true } | { finish: true }
  | { stderr: string } | { raw: string } | { approval: { command?: string; path?: string } } | { ignore_sigterm: true }
  | { status_line: { five_hour?: number; seven_day?: number; resets_at?: string } }
  | { notification: string };

export class ScenarioError extends Error {}

// Used for every turn the scenario does not list, and for every turn when there is no scenario.
export const DEFAULT_STEPS: Step[] = [{ say: "I finished the task." }];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function onlyKeys(value: Json, allowed: string[]): string | null {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? null : `unknown field "${extra}"`;
}

// Returns why the step is invalid, or null when it is valid.
function stepProblem(step: unknown): string | null {
  if (!isObject(step)) return "a step must be an object";
  const kinds = Object.keys(step).filter((key) => STEP_CHECKS[key] !== undefined);
  if (kinds.length !== 1) return "a step must have exactly one of " + Object.keys(STEP_CHECKS).join(", ");
  const kind = kinds[0]!;
  return STEP_CHECKS[kind]!(step);
}

const STEP_CHECKS: Record<string, (step: Json) => string | null> = {
  say: (s) => onlyKeys(s, ["say"]) ?? (typeof s.say === "string" ? null : "say must be text"),
  run: (s) =>
    onlyKeys(s, ["run", "exit_code", "delay_ms"]) ??
    (typeof s.run !== "string" || s.run === "" ? "run must be a command"
      : s.exit_code !== undefined && !(isCount(s.exit_code) && s.exit_code <= 255) ? "exit_code must be a whole number from 0 to 255"
      : s.delay_ms !== undefined && !isCount(s.delay_ms) ? "delay_ms must be a whole number of milliseconds"
      : null),
  write: (s) =>
    onlyKeys(s, ["write", "content"]) ??
    (typeof s.write !== "string" || s.write === "" || isAbsolute(s.write) ? "write must be a relative file path"
      : typeof s.content !== "string" ? "content must be text"
      : null),
  limit: (s) => {
    const limit = s.limit;
    if (!isObject(limit)) return "limit must be an object";
    return onlyKeys(s, ["limit"]) ?? onlyKeys(limit, ["window", "resets_at", "kind"]) ??
      (!["primary", "secondary", "five_hour", "seven_day"].includes(limit.window as string)
        ? "limit.window must be primary, secondary, five_hour or seven_day"
        : !isTime(limit.resets_at) ? "limit.resets_at must be an ISO 8601 time"
        : limit.kind !== undefined && !["usage", "rate"].includes(limit.kind as string) ? "limit.kind must be usage or rate"
        : null);
  },
  error: (s) =>
    onlyKeys(s, ["error"]) ??
    (["authentication_failed", "overloaded", "billing_error", "server_error"].includes(s.error as string)
      ? null : "error must be authentication_failed, overloaded, billing_error or server_error"),
  crash: (s) => {
    const crash = s.crash;
    if (!isObject(crash)) return "crash must be an object";
    return onlyKeys(s, ["crash"]) ?? onlyKeys(crash, ["signal"]) ??
      (["SIGKILL", "SIGSEGV"].includes(crash.signal as string) ? null : "crash.signal must be SIGKILL or SIGSEGV");
  },
  exit: (s) => onlyKeys(s, ["exit"]) ?? (isCount(s.exit) && s.exit <= 255 ? null : "exit must be a whole number from 0 to 255"),
  hang: (s) => onlyKeys(s, ["hang"]) ?? (s.hang === true ? null : "hang must be true"),
  finish: (s) => onlyKeys(s, ["finish"]) ?? (s.finish === true ? null : "finish must be true"),
  stderr: (s) => onlyKeys(s, ["stderr"]) ?? (typeof s.stderr === "string" ? null : "stderr must be text"),
  raw: (s) => onlyKeys(s, ["raw"]) ?? (typeof s.raw === "string" && !s.raw.includes("\n") ? null : "raw must be one line of text"),
  approval: (s) => {
    const approval = s.approval;
    if (!isObject(approval)) return "approval must be an object";
    const given = ["command", "path"].filter((key) => approval[key] !== undefined);
    return onlyKeys(s, ["approval"]) ?? onlyKeys(approval, ["command", "path"]) ??
      (given.length !== 1 ? "approval must have exactly one of command and path"
        : given.some((key) => typeof approval[key] !== "string" || approval[key] === "") ? `approval.${given[0]} must be text`
        : null);
  },
  ignore_sigterm: (s) => onlyKeys(s, ["ignore_sigterm"]) ?? (s.ignore_sigterm === true ? null : "ignore_sigterm must be true"),
  status_line: (s) => {
    const line = s.status_line;
    if (!isObject(line)) return "status_line must be an object";
    return onlyKeys(s, ["status_line"]) ?? onlyKeys(line, ["five_hour", "seven_day", "resets_at"]) ??
      (line.five_hour === undefined && line.seven_day === undefined ? "status_line needs five_hour or seven_day"
        : [line.five_hour, line.seven_day].some((v) => v !== undefined && !isPercent(v)) ? "status_line percentages must be numbers from 0"
        : line.resets_at !== undefined && !isTime(line.resets_at) ? "status_line.resets_at must be an ISO 8601 time"
        : null);
  },
  notification: (s) => onlyKeys(s, ["notification"]) ?? (typeof s.notification === "string" && s.notification !== "" ? null : "notification must be text"),
};

function windowProblem(name: string, value: unknown): string | null {
  if (!isObject(value)) return `${name} must be an object`;
  return onlyKeys(value, ["used_percent", "window_minutes", "resets_at"]) ??
    (!isPercent(value.used_percent) ? `${name}.used_percent must be a number from 0`
      : !(isCount(value.window_minutes) && value.window_minutes > 0) ? `${name}.window_minutes must be a whole number above 0`
      : !isTime(value.resets_at) ? `${name}.resets_at must be an ISO 8601 time`
      : null);
}

function scenarioProblem(value: Json): string | null {
  const unknown = onlyKeys(value, [
    "version", "tool_version", "startup_delay_ms", "session_id", "auth", "login", "rate_limits", "hooks_trusted", "app_server", "turns",
  ]);
  if (unknown !== null) return unknown;
  if (value.version !== 1) return "version must be 1";
  if (value.tool_version !== undefined && !(typeof value.tool_version === "string" && /^\d+\.\d+\.\d+$/.test(value.tool_version))) {
    return "tool_version must be a version such as 2.1.282";
  }
  if (value.startup_delay_ms !== undefined && !isCount(value.startup_delay_ms)) return "startup_delay_ms must be a whole number of milliseconds";
  if (value.session_id !== undefined && (typeof value.session_id !== "string" || value.session_id === "")) return "session_id must be text";
  const auth = value.auth;
  if (auth !== undefined) {
    if (!isObject(auth)) return "auth must be an object";
    const problem = onlyKeys(auth, ["signed_in", "method"]);
    if (problem !== null) return `auth: ${problem}`;
    if (typeof auth.signed_in !== "boolean") return "auth.signed_in must be true or false";
    if (auth.method !== undefined && typeof auth.method !== "string") return "auth.method must be text";
  }
  const login = value.login;
  if (login !== undefined) {
    if (!isObject(login)) return "login must be an object";
    const problem = onlyKeys(login, ["succeed"]);
    if (problem !== null) return `login: ${problem}`;
    if (typeof login.succeed !== "boolean") return "login.succeed must be true or false";
  }
  const limits = value.rate_limits;
  if (limits !== undefined) {
    if (!isObject(limits)) return "rate_limits must be an object";
    const problem = onlyKeys(limits, ["primary", "secondary", "reached", "ordinary_usage_allowed"]);
    if (problem !== null) return `rate_limits: ${problem}`;
    for (const name of ["primary", "secondary"]) {
      if (limits[name] !== undefined) {
        const windowIssue = windowProblem(`rate_limits.${name}`, limits[name]);
        if (windowIssue !== null) return windowIssue;
      }
    }
    if (limits.reached !== undefined && limits.reached !== null && typeof limits.reached !== "string") return "rate_limits.reached must be text or null";
    const allowed = limits.ordinary_usage_allowed;
    if (allowed !== undefined && allowed !== null && typeof allowed !== "boolean") return "rate_limits.ordinary_usage_allowed must be true, false or null";
  }
  if (value.hooks_trusted !== undefined && typeof value.hooks_trusted !== "boolean" && value.hooks_trusted !== "modified") {
    return 'hooks_trusted must be true, false or "modified"';
  }
  if (value.app_server !== undefined && !["ok", "exit_immediately", "no_answer", "method_not_found"].includes(value.app_server as string)) {
    return "app_server must be ok, exit_immediately, no_answer or method_not_found";
  }
  if (!Array.isArray(value.turns)) return "turns must be a list";
  return null;
}

// Checks one step. `where` names it in the error, for example "turn 2, step 3".
export function parseStep(value: unknown, where = "step"): Step {
  const problem = stepProblem(value);
  if (problem !== null) throw new ScenarioError(`${where} is not a valid step: ${problem}.`);
  return value as Step;
}

export function parseScenario(value: unknown): Scenario {
  if (!isObject(value)) throw new ScenarioError("A scenario must be a JSON object.");
  const problem = scenarioProblem(value);
  if (problem !== null) throw new ScenarioError(`The scenario is not valid: ${problem}.`);
  (value.turns as unknown[]).forEach((turn, t) => {
    if (!isObject(turn) || onlyKeys(turn, ["steps"]) !== null || !Array.isArray(turn.steps)) {
      throw new ScenarioError(`Turn ${t + 1} is not valid: a turn must be an object with a list of steps.`);
    }
    turn.steps.forEach((step, s) => parseStep(step, `Turn ${t + 1}, step ${s + 1}`));
  });
  return value as unknown as Scenario;
}

// Reads the file named by RELAY_FAKE_SCENARIO. Without one, every turn says one sentence and finishes.
export function loadScenario(file = process.env.RELAY_FAKE_SCENARIO): Scenario {
  if (file === undefined || file === "") return { version: 1, turns: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ScenarioError(`Could not read the scenario ${file}: ${(error as Error).message}`);
  }
  try {
    return parseScenario(value);
  } catch (error) {
    throw new ScenarioError(`${file}: ${(error as Error).message}`);
  }
}

// The steps of turn `index` (counted from 0).
export function turnSteps(scenario: Scenario, index: number): Step[] {
  return scenario.turns[index]?.steps ?? DEFAULT_STEPS;
}

export function unixSeconds(time: string): number {
  return Math.floor(Date.parse(time) / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// "primary" is the five-hour window and "secondary" the seven-day window, as in Codex's rate limits.
export function windowName(window: "primary" | "secondary" | "five_hour" | "seven_day"): "five_hour" | "seven_day" {
  return window === "primary" || window === "five_hour" ? "five_hour" : "seven_day";
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// Writes a `write` step's file under `root` and refuses a path that leaves it, also through a
// symbolic link.
export function writeStepFile(root: string, path: string, content: string): { absolute: string; created: boolean } {
  const absolute = resolve(root, path);
  const outside = new ScenarioError(`The write step's path ${path} is outside the working directory.`);
  if (!isInside(resolve(root), absolute)) throw outside;
  const realRoot = realpathSync(root);
  const staysInside = (folder: string) => {
    let existing = folder;
    while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) existing = dirname(existing);
    const real = realpathSync(existing);
    return real === realRoot || isInside(realRoot, real);
  };
  if (!staysInside(dirname(absolute))) throw outside;
  mkdirSync(dirname(absolute), { recursive: true });
  const existing = lstatSync(absolute, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw outside;
  writeFileSync(absolute, content);
  const created = existing === undefined;
  return { absolute, created };
}

// Ends the fake with a crash step's signal. A SIGSEGV can make the system write a core dump of the
// whole Bun process first, which takes seconds to minutes. ulimit -c 0 does not stop it when the
// system pipes core dumps to a program such as apport or systemd-coredump, so on Linux the fake
// first marks itself as not dumpable (prctl PR_SET_DUMPABLE 0), which the kernel always honours.
export function crashWith(signal: "SIGKILL" | "SIGSEGV"): void {
  if (signal === "SIGSEGV" && process.platform === "linux") {
    try {
      const libc = dlopen("libc.so.6", {
        prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      });
      libc.symbols.prctl(4, 0, 0, 0, 0);
    } catch {
      // Without glibc the shell wrapper's ulimit -c 0 is the only protection.
    }
  }
  process.kill(process.pid, signal);
}
