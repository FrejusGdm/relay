import { join } from "node:path";
import { COMMANDS, type CommandDef } from "./commands/registry";
import { SettingsError } from "./errors";
import { ExitCode } from "./exit-codes";
import { renderCommandHelp, renderTopHelp } from "./help";
import type { Io } from "./io";
import { route } from "./router";
import { loadConfig } from "../core/config/load";
import { resolveLogLevel } from "../core/config/log-level";
import type { LogLevel, RelayConfig } from "../core/config/types";
import { openLog, type LogFields, type Logger } from "../core/log";
import { resolveRelayHome } from "../core/paths";
import { printable } from "../core/quote";
import { ensureRelayHome } from "../core/relay-home";
import { VERSION } from "../core/version";

export interface CliContext {
  argv: string[];
  // The folder relay was started in. Commands that work on a project start from it.
  cwd: string;
  env: Record<string, string | undefined>;
  homedir: string;
  uid: number;
  io: Io;
  commands?: CommandDef[];
  onLogOpened?: (log: Logger) => void;   // main.ts uses it to log a signal
}

interface RunState {
  started: number;
  log?: Logger;
}

// The steps follow design decision 4. Any error, also one from the router, ends in the exit-70
// path; hook stays silent.
export async function runCli(ctx: CliContext): Promise<number> {
  const commands = ctx.commands ?? COMMANDS;
  const quiet = commands.find((def) => def.name === ctx.argv[0])?.quiet === true;
  const state: RunState = { started: performance.now() };
  try {
    return await runSteps(ctx, commands, state);
  } catch (error) {
    state.log?.error("unexpected error", errorFields(error));
    const code = quiet ? ExitCode.Ok : ExitCode.Internal;
    finish(state, code);
    if (quiet) return code;
    const message = error instanceof Error ? error.message : String(error);
    // Without a working log, nothing was written, so there is no file to point to.
    const details = state.log?.writing ? `Details are in ${printable(state.log.file)}.\n` : "";
    ctx.io.err(`relay: unexpected error: ${printable(message)}\n${details}`);
    return code;
  }
}

async function runSteps(ctx: CliContext, commands: CommandDef[], state: RunState): Promise<number> {
  const { io } = ctx;
  const result = route(ctx.argv, commands);

  switch (result.kind) {
    case "top-help":
      io.out(renderTopHelp(commands));
      return ExitCode.Ok;
    case "version":
      io.out(`relay ${VERSION}\n`);
      return ExitCode.Ok;
    case "command-help":
      io.out(renderCommandHelp(result.def));
      return ExitCode.Ok;
    case "usage-error":
      if (!result.quiet) {
        io.err(result.lines.map((line) => `${line}\n`).join(""));
        return ExitCode.Usage;
      }
      // Only hook gets here. Its usage error is logged when the relay folder can be used.
      try {
        const relayHome = useRelayHome(ctx);
        open(ctx, state, relayHome, "hook.log", quietLevel(ctx, relayHome), true).info("hook usage error", {
          arguments: ctx.argv.length - 1,
        });
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error;
      }
      return quietExit(io);
  }

  const { def, positionals, optionNames, values, logLevelFlag } = result;
  let relayHome: string;
  try {
    relayHome = useRelayHome(ctx);
  } catch (error) {
    // The folder cannot be trusted, so this error is printed and not logged.
    return settingsFailure(error, def, io);
  }

  // The settings are not loaded yet. An invalid RELAY_LOG_LEVEL is reported after them.
  const [level, levelProblem] = startLevel(logLevelFlag, ctx.env);
  const log = open(ctx, state, relayHome, def.name === "hook" ? "hook.log" : "cli.log", level, def.quiet);
  const started = { command: def.name, options: optionNames, arguments: positionals.length };

  let config: RelayConfig;
  let logLevel: LogLevel;
  try {
    config = loadConfig({ relayHome, homedir: ctx.homedir, uid: ctx.uid });
    if (levelProblem) throw levelProblem;
    logLevel = resolveLogLevel(logLevelFlag, ctx.env, config);
    log.setLevel(logLevel);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    log.info("command started", started);
    log.warn("settings invalid", { path: join(relayHome, "config.toml"), problems: error.problems });
    const code = await settingsFailure(error, def, io);
    finish(state, code);
    return code;
  }
  log.info("command started", started);
  log.info("settings loaded", {
    path: config.file,
    exists: config.exists,
    accounts: config.accounts.length,
    projects: config.projects.length,
  });

  const code = await def.handler({
    def, positionals, values, io, log, logLevel, cwd: ctx.cwd, env: ctx.env, homedir: ctx.homedir, relayHome, config,
  });
  finish(state, code);
  return code;
}

// Finds the relay folder, creates it when it is missing, and checks that it is private.
function useRelayHome(ctx: CliContext): string {
  const relayHome = resolveRelayHome(ctx.env, ctx.homedir);
  ensureRelayHome(relayHome, ctx.uid);
  return relayHome;
}

// The level before the settings are read: the flag, then RELAY_LOG_LEVEL, then info. An invalid
// RELAY_LOG_LEVEL is a settings error even when the flag is given; it is returned as the second
// item, and the flag, or else info, is used until relay reports it.
function startLevel(
  flag: LogLevel | undefined,
  env: CliContext["env"],
): [LogLevel, SettingsError | undefined] {
  try {
    return [resolveLogLevel(flag, env, null), undefined];
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return [flag ?? "info", error];
  }
}

// The level for the hook usage-error entry: from valid settings when they can be read, otherwise
// RELAY_LOG_LEVEL or info. Nothing is printed either way.
function quietLevel(ctx: CliContext, relayHome: string): LogLevel {
  try {
    return resolveLogLevel(undefined, ctx.env, loadConfig({ relayHome, homedir: ctx.homedir, uid: ctx.uid }));
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return startLevel(undefined, ctx.env)[0];
  }
}

function open(ctx: CliContext, state: RunState, relayHome: string, file: string, level: LogLevel, quiet: boolean): Logger {
  const log = openLog({
    relayHome,
    file,
    level,
    version: VERSION,
    invocation: newInvocation(),
    onFailure: (path, reason) => {
      if (!quiet) ctx.io.err(`relay: could not write to the log ${printable(path)}: ${printable(reason)}. Continuing without it.\n`);
    },
  });
  state.log = log;
  ctx.onLogOpened?.(log);
  return log;
}

async function settingsFailure(error: unknown, def: CommandDef, io: Io): Promise<number> {
  if (!(error instanceof SettingsError)) throw error;
  if (def.quiet) return quietExit(io);
  io.err(error.lines.map((line) => `${line}\n`).join(""));
  return ExitCode.Settings;
}

function finish(state: RunState, code: number): void {
  const duration = Math.round(performance.now() - state.started);
  state.log?.info("command finished", { exit_code: code, duration_ms: duration });
}

// The message is never logged, and neither is the start of the stack, which repeats it, because
// later adapters may throw errors that quote a command line or a provider's output.
function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { error_name: typeof error, stack: null };
  // The stack starts with "<name>: <message>", and the message can span several lines.
  let stack = error.stack ?? "";
  if (stack.startsWith(String(error))) stack = stack.slice(String(error).length);
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
  return { error_name: error.name, stack: frames.length > 0 ? frames.join("\n") : null };
}

function newInvocation(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// An agent may still be writing to relay hook; reading to the end spares it a broken pipe.
async function quietExit(io: Io): Promise<number> {
  if (!io.stdinIsTTY) await io.readStdinToEnd();
  return ExitCode.Ok;
}
