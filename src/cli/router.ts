import { parseArgs } from "node:util";
import type { CommandDef } from "./commands/registry";
import { UsageError } from "./errors";
import { LOG_LEVELS, type LogLevel } from "../core/config/types";
import { quote } from "../core/quote";

export type RouteResult =
  | { kind: "top-help" }
  | { kind: "version" }
  | { kind: "command-help"; def: CommandDef }
  | { kind: "usage-error"; lines: string[]; quiet: boolean }
  | {
      kind: "run";
      def: CommandDef;
      positionals: string[];
      optionNames: string[];
      values: Record<string, string | boolean | string[] | undefined>;
      logLevelFlag: LogLevel | undefined;
    };

type ParseOptions = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

const SEE_COMMANDS = 'Run "relay --help" to see the commands.';

const isOptionLike = (value: string) => value.length > 1 && value.startsWith("-");

function notACommand(name: string): UsageError {
  return new UsageError([`relay: ${quote(name)} is not a relay command.`, SEE_COMMANDS]);
}

export function route(argv: string[], commands: CommandDef[]): RouteResult {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help") return { kind: "top-help" };
  if (first === "--version") return { kind: "version" };
  try {
    if (first === "help") {
      if (rest[0] === undefined || rest[0] === "-h" || rest[0] === "--help") return { kind: "top-help" };
      const def = commands.find((command) => command.name === rest[0]);
      if (!def) throw notACommand(rest[0]);
      return { kind: "command-help", def };
    }
    if (first.startsWith("-")) {
      throw new UsageError([`relay: unknown option ${quote(first.split("=")[0]!)}.`, SEE_COMMANDS]);
    }
    const def = commands.find((command) => command.name === first);
    if (!def) throw notACommand(first);
    if (rest.some((arg) => arg === "-h" || arg === "--help")) return { kind: "command-help", def };
    try {
      return parseCommand(def, rest);
    } catch (error) {
      if (error instanceof UsageError) return { kind: "usage-error", lines: error.lines, quiet: def.quiet };
      throw error;
    }
  } catch (error) {
    if (error instanceof UsageError) return { kind: "usage-error", lines: error.lines, quiet: false };
    throw error;
  }
}

function parseCommand(def: CommandDef, args: string[]): RouteResult {
  const options: ParseOptions = {
    help: { type: "boolean", short: "h" },
    "log-level": { type: "string" },
  };
  for (const option of def.options) {
    options[option.name] = { type: option.value ? "string" : "boolean" };
    if (option.short) options[option.name]!.short = option.short;
    if (option.multiple) options[option.name]!.multiple = true;
  }
  const seeOptions = `Run "relay ${def.name} --help" to see its options.`;

  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true, tokens: true });
  } catch (error) {
    throw new UsageError([...optionProblem(error, args, options, def), seeOptions]);
  }

  const { positionals, values, tokens } = parsed;
  const seeExample = `Run "relay ${def.name} --help" for an example.`;
  if (positionals.length < def.minArgs) {
    throw new UsageError([`relay: ${def.name} needs ${def.argsUsage}.`, seeExample]);
  }
  if (positionals.length > def.maxArgs) {
    const extra = positionals.slice(def.maxArgs).map(quote).join(", ");
    throw new UsageError([`relay: too many arguments for ${def.name}: ${extra}.`, seeExample]);
  }

  const level = values["log-level"];
  if (level !== undefined && !(LOG_LEVELS as readonly string[]).includes(level as string)) {
    throw new UsageError([
      `relay: --log-level must be debug, info, warn or error, not ${quote(level as string)}.`,
      seeOptions,
    ]);
  }

  const optionNames: string[] = [];
  const own: Record<string, string | boolean | string[] | undefined> = {};
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === "help" || token.name === "log-level") continue;
    if (!optionNames.includes(token.name)) optionNames.push(token.name);
    // Only options that take a value can be repeated, so a list holds strings.
    own[token.name] = values[token.name] as string | boolean | string[] | undefined;
  }
  return {
    kind: "run",
    def,
    positionals,
    optionNames,
    values: own,
    logLevelFlag: level as LogLevel | undefined,
  };
}

// parseArgs reports the problem in an English sentence; a second, lenient pass finds the option
// as the person typed it, so the message can name it exactly.
function optionProblem(error: unknown, args: string[], options: ParseOptions, def: CommandDef): string[] {
  const code = (error as { code?: string }).code;
  const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const known = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    const name = quote(token.rawName);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && !known) {
      return [`relay: unknown option ${name} for ${def.name}.`];
    }
    if (code !== "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" || !known) continue;
    if (known.type === "boolean" && token.inlineValue) {
      return [`relay: option ${name} does not take a value.`];
    }
    if (known.type === "string" && !token.inlineValue) {
      if (token.value === undefined) return [`relay: option ${name} needs a value.`];
      if (isOptionLike(token.value)) {
        // When the value is another option of the command, the value was most likely forgotten.
        if (isKnownOption(token.value, options)) return [`relay: option ${name} needs a value.`];
        return [
          `relay: option ${name} needs a value.`,
          `relay: to give a value that starts with "-", write ${quote(`--${token.name}=${token.value}`)}.`,
        ];
      }
    }
  }
  throw error;
}

function isKnownOption(arg: string, options: ParseOptions): boolean {
  if (arg.startsWith("--")) return Object.hasOwn(options, arg.slice(2).split("=")[0]!);
  return Object.values(options).some((option) => option.short === arg[1]);
}
